# 候选 Agent 编排计划校验与确认工作流 v0.1

## 目的与边界

`multi-agent-orchestrator/src/plan-validator.js` 提供确定性校验层，用于检查 OpenClaw/LLM 或其他规划器提出的候选 Agent 计划；`src/plan-executor.js` 只在校验结果为 `ALLOW` 时，按依赖顺序调用本地显式注册的能力处理器。

本地 OpenClaw 插件现已接入候选计划工具、能源管家、学习伴学事件归一化能力、设备 Task runtime 和 HA/Mock 设备运行时。活动工作流对象仍在进程内；精简的确认/幂等摘要持久化在 OpenClaw state 下的 `device-manager/agent-approval-state.json`。服务重启后，尚未批准的旧项转为 `RECOVERY_REQUIRED`，必须刷新状态并重新规划；如果进程在设备执行窗口中断，则转为 `EXECUTION_UNCERTAIN`，禁止自动重放。确认由 OpenClaw 根据后续自然语言回复选择，并不是强身份认证。当前开发验证使用 Mock HA，项目提供真实 HA REST 适配器，但本机是否已配置真实 HA 需单独检查。尚未接入真实 HA 事件推送/认证适配器。`ALLOW` 只表示计划通过本模块的结构和策略检查；不代表外部数据真实、真实设备已获授权，或设备动作已成功。

## 计划格式

```json
{
  "schema_version": "0.1",
  "plan_id": "plan-study-light",
  "trace_id": "trace-study-light",
  "goal": "满足家庭策略时关闭学习灯",
  "steps": [
    {
      "step_id": "read-occupancy",
      "agent_id": "device-manager",
      "capability": "read_occupancy",
      "depends_on": [],
      "evidence_refs": ["ha-study-occupancy-001"],
      "input": { "area": "study" }
    },
    {
      "step_id": "plan-energy-action",
      "agent_id": "energy-saving",
      "capability": "plan_energy_action",
      "depends_on": ["read-occupancy"],
      "evidence_refs": ["ha-study-occupancy-001"],
      "input": { "area": "study" }
    },
    {
      "step_id": "turn-off-light",
      "agent_id": "device-manager",
      "capability": "execute_device_action",
      "depends_on": ["plan-energy-action"],
      "evidence_refs": ["ha-study-occupancy-001"],
      "action": {
        "name": "turn_off",
        "target_ref": { "device_id": "light.study" },
        "parameters": {}
      }
    }
  ]
}
```

模型只能引用调用方提供的证据 ID，不能把模型自己的文字判断伪装成传感器证据。设备动作类型从本地注册的 capability 描述读取，不由候选计划自报。

## 决策

- `ALLOW`：计划结构、能力、依赖、所需证据和家庭自动授权均通过。校验器本身只返回校验结果；执行器随后才会尝试调用对应的本地注册处理器。只有处理器返回成功，才记为该步骤 `SUCCEEDED`，但这仍不证明真实设备状态，需由真实适配器回读确认。
- `NEED_CONFIRMATION`：写动作未列入严格自动授权清单。工作流建立短时待确认项；收到用户明确答复后重新校验实时状态。
- `CLARIFICATION_REQUIRED`：计划含同一设备未排序的互斥动作。不能批准当前候选计划；先询问用户保留哪项或明确先后关系，再重新提交。
- `DENY`：计划格式/依赖无效，Agent 或能力未登记，必需证据缺失、不可信、来源不允许或已过期，或者动作违反家庭硬性禁止策略。

证据记录至少要有 `evidence_id`、`evidence_type`、`trust_level`、`source_type` 和 `observed_at`。可信来源判断必须由受信任的采集/适配层完成；不能相信 LLM 输出中自行填写的 `trust_level`。

家庭策略按具体设备和动作配置：`allowedDeviceIds` 与 `allowedActions` 是可在授权后执行的边界；`autoAllowedDeviceActions` 是更窄的自动执行白名单（设备 ID + 动作组合）；`blockedActions` 是硬禁止。未进自动白名单的允许动作返回 `NEED_CONFIRMATION`；未进入设备/动作允许范围或命中硬禁止则返回 `DENY`。配置为空时设备动作默认失败关闭。

计划审批需绑定 `plan_id` 与 `plan_fingerprint`，避免用户批准后计划内容发生变化。验证器无法认证用户身份；`approval` 必须来自经过认证的 UI/通道，不能直接接受模型生成的字段。

`AgentPlanWorkflow` 是本地流程骨架：新计划若需确认，会生成短时有效的待办；调用 `approve` 时先走 `authorizeActor`，再由 `evidenceProvider` 拉取最新证据并再次校验。OpenClaw 插件把“用户后续明确同意”的语义交给模型判断，软件层目前不能独立证明说话者身份。无人响应则到期标记 `EXPIRED_NO_ACTION`，不执行。过期状态在查询、决策或调用 `sweepExpired()` 时惰性更新；当前没有后台定时器。资源冲突会在建立待办之前返回 `CLARIFICATION_REQUIRED`，不接受对冲突计划的批准。确认回调和证据提供器由宿主系统注入；身份认证仍是生产部署的后续项。

## 重启恢复与幂等

- OpenClaw 插件通过 `AgentApprovalStateStore` 保存确认 ID、计划 ID/语义指纹、状态、TTL、来源，以及用于展示的最小设备动作摘要；不会保存候选计划的 `goal`、步骤 `input`、Event 原文、设备状态证据、工具结果或任意动作参数。
- 文件采用临时文件后原子改名写入；若文件无法解析、版本不支持或写入失败，插件/本次审批操作失败关闭，不继续执行设备写动作。
- 重启时 `WAITING_FOR_APPROVAL`、`APPROVING` 和 `REJECTING` 恢复为 `RECOVERY_REQUIRED`。旧批准入口不复活；用户可以明确关闭旧项，之后需重新读取设备状态、重新提交新计划并再次确认。原 TTL 不延长。
- 写入状态 `EXECUTING` 后才调用执行器。若下次启动仍看到该状态，则标记 `EXECUTION_UNCERTAIN`：这不等于设备动作一定成功，也不等于一定失败；禁止自动重放，需要先核对 HA/设备当前状态。
- `EXECUTION_UNCERTAIN` 的本地核对采用两阶段工具流程：`check_state` 只读查询所有受影响设备并返回脱敏状态摘要，记录继续保持阻止；用户看到摘要后另行明确要求关闭，才能选 `reconciled`。关闭前会再次查询；状态变化、设备不可读/离线或查询摘要超过 2 分钟时都不清除记录，必须重新核对。该闭环不执行、撤销或自动重试设备动作；用户确认仍由 OpenClaw 根据对话解释，尚非强身份认证。
- 语义相同的未完成计划在重启后仍复用同一审批记录，不会再开一张新的确认单。已执行但在终态清理前发生崩溃的计划，在原幂等 TTL 内按已完成结果去重。幂等 TTL 不被重启延长；结果不确定的记录保留，直至人工关闭/处置。
- 默认文件位置为 `$OPENCLAW_STATE_DIR/device-manager/agent-approval-state.json`（未设置时为 `~/.openclaw/device-manager/agent-approval-state.json`）；可用 `DEVICE_MANAGER_APPROVAL_STATE_PATH` 覆盖。该路径属于本机 OpenClaw state，不应进入 Git 或跨设备共享。

## 运行时职责划分

当前本地链路是：OpenClaw/LLM 语义理解并选择工具 → 候选 Event/Agent 计划进入 Node.js 注册能力和安全校验 → 只读能力直接运行、普通写动作进入待确认、冲突先澄清、证据不足拒绝 → 设备管家经当前配置的 Mock 或 HA 适配器执行并回读状态。来自公开对话工具的事件会被标记为未认证，不能仅凭 JSON 的 `source_agent` 自动执行。

LLM 负责语义理解和提出动态计划；校验器不判断哪种计划“最聪明”，而是用明确、可审计的安全边界决定候选计划是否可执行、需要确认、澄清或拒绝。执行器只遵循已校验计划，不自行增删步骤或扩大能力。当前已将工具入口接入 OpenClaw、本地业务 Agent、Task runtime、Mock/HA 设备运行时和本地审批持久化；真实传感器事件适配、强身份确认 UI，以及执行结果不确定时的真实 HA 对账流程仍待集成。

## 运行与演示

在 `multi-agent-orchestrator` 下运行：

```powershell
npm test
npm run demo:plan-validation
npm run demo:plan-workflow
```

`demo:plan-validation` 展示 `ALLOW`、`NEED_CONFIRMATION`、`DENY` 三种校验结果；`demo:plan-workflow` 展示“待确认 → 模拟授权 → 刷新上下文 → 重新校验 → Mock handler”的流程。演示不请求模型 API、不连接 HA、不触碰真实设备。Mock 返回成功只说明代码路径执行成功，不是实际家电控制的验收证据。

## 后续集成顺序

1. 接入真实 HA 事件订阅/适配器，并由适配器完成来源认证；不要将 Event JSON 中的 source 字符串当凭据；
2. 将当前本地摘要存储纳入真实身份认证/授权与确认界面；使用经过认证的 HA 环境完成两阶段状态核对、显式关闭/重规划联调；
3. 与设备组核对真实设备实体、可用能力、危险设备类别和 HA 服务调用结果边界；
4. 给计划执行器加入宿主级超时、取消与副作用不确定后的自动查询辅助；已经发生的外部副作用不会自动回滚；
5. 用脱敏后的真实 HA 测试环境完成联调；执行前重查设备状态和审批范围，执行后回读并记录 `trace_id`。

家庭配置、正式契约和安全阈值需与项目其他小组共同确认。本文件是 Agent 组开发草案，不取代正式公共契约。

## 2026-10-13：隔离 OpenClaw profile 重启恢复验证

- 使用本机 OpenClaw `2026.7.1-2`，在仓库 `tmp/isolated-openclaw-restart-validation-20261013` 创建独立 state/config；Gateway 只绑定 `127.0.0.1:19371`。没有读取或修改用户默认 OpenClaw profile；隔离配置关闭 shell 环境变量导入，测试进程也没有模型 API 凭据。验证结束后已清理该临时 profile 和合成状态。
- 通过 `openclaw plugins install --link` 加载仓库内 `device-manager` 插件。`openclaw plugins inspect device-manager --runtime` 列出插件工具；隔离 Gateway 两次启动都记录 `loaded 1 plugin(s)`，健康 RPC 返回 `ok: true`、`device-manager` 已加载且 `plugins.errors` 为空。
- 在隔离状态文件中预置两个合成摘要：`WAITING_FOR_APPROVAL` 和 `EXECUTING`。同一 profile 停止后再次启动；重新加载状态后，独立进程断言分别得到 `RECOVERY_REQUIRED` 与 `EXECUTION_UNCERTAIN`。旧待确认不会恢复批准权限，执行中断项不会自动重放。
- 新增跨进程自动化回归：两个独立 Node.js 进程先后写入并重载审批摘要，验证 `WAITING_FOR_APPROVAL → RECOVERY_REQUIRED`、`EXECUTING → EXECUTION_UNCERTAIN`，并断言私有目标、原始事件和任意参数不会落盘。
- 回归结果：`device-manager` 的 `npm run verify` 通过，包含 174/174 项测试、Mock 验收 11/11、插件校验及契约校验（17 个有效样例通过、4 个无效样例按预期拒绝）；`multi-agent-orchestrator` 的 `npm test` 73/73 通过。周期健康巡检测试改为等待实际告警/恢复和后续巡检条件，避免用固定短延时造成时序波动。
- 验证边界：本轮确认的是 Gateway 进程能够加载插件并在重启后安全恢复状态；没有通过真实模型驱动的会话调用插件工具，没有请求 DeepSeek/OpenAI API，没有连接 Home Assistant，也没有执行任何设备动作。因此这不是模型端到端或真实 HA 验收。一次健康采样出现短暂 `event_loop_delay` degraded 标记，但 `ok` 仍为 true、插件错误为空；日志中的 iMessage/Telegram setup-entry 警告与本插件无关。

## 2026-10-13：执行不确定记录的两阶段核对

- 修复了关闭 `EXECUTION_UNCERTAIN` 记录前不强制读取设备状态的缺口：`check_state` 只做只读核查并返回设备状态摘要，保持记录和幂等阻止；须先将摘要告知用户，之后用户明确要求关闭，才可调用 `reconciled`。
- 关闭动作会再次读取所有目标设备；若设备不可读/离线，或状态与刚展示的摘要不同，则继续阻止并返回最新摘要。核查摘要只在内存保留 2 分钟，Gateway 重启后必须重新核查。该操作不会重放或撤销设备动作，也不会把未知结果改写成成功/失败。
- 自动化验证覆盖：设备离线时保持阻止、只读检查不关闭、两次读取间状态变化时再次要求用户复核、稳定状态经后续关闭请求才能清除，以及超过 2 分钟的核查快照失效。
- 更新后 `device-manager` 的 `npm run verify` 通过：175/175 测试、Mock 验收 11/11、OpenClaw 插件校验通过、契约 17 个有效样例通过且 4 个无效样例按预期拒绝。该实现通过 Mock 验证；真实 HA 仍需联调。
- 用户后续确认由 OpenClaw 按对话选择，应用层未提供可信的用户轮次/身份凭据，因此“两次独立用户交互”仍依赖模型遵守工具说明；生产环境需接入经过认证的确认 UI/通道。
