# 设备管家 Agent 本地验收报告

更新时间：2026-10-15

## 验收结论

当前设备管家 Agent 的本地 Mock 链路通过验收，可以作为其他 Agent 尚未接入时的独立演示和联调基线。
本报告只证明代码、契约和 Mock Home Assistant 的行为正确，不代表真实家庭设备已经接入。

## A-05 Mock 接口故障联动补充（2026-09-28）

在原有单模块异常测试之外，Mock 编排器现在可以注入 ResourceStatus、PolicyDecision 和设备管家回执，
用一条任务链检查接口缺字段、超时和异常响应的处理顺序。新增 `device-manager` 测试后为 75/75 通过；
`npm run verify`、`npm run demo:interface-faults` 均通过。

| 注入场景 | 预期处理 | 设备动作 |
| --- | --- | --- |
| Task 缺少目标设备字段 | `INVALID_TASK`，不进入策略/执行 | 不执行 |
| ResourceStatus 缺少 `online` | `INVALID_RESOURCE_STATUS`，fail closed | 不执行 |
| ResourceStatus 超时 | `TIMEOUT / RESOURCE_STATUS_TIMEOUT`，停止后续调用 | 不执行 |
| PolicyDecision 异常/缺少决策 | `POLICY_DECISION_ERROR` / `INVALID_POLICY_DECISION` | 不执行 |
| PolicyDecision 超时 | `TIMEOUT / POLICY_DECISION_TIMEOUT` | 不执行 |
| 设备管家执行超时 | `TIMEOUT / DEVICE_MANAGER_TIMEOUT`，注明副作用未知 | 不能据此断言执行或回滚 |
| 回执的 `trace_id` 与请求不一致 | `INVALID_TASK_RECEIPT`，不伪装成功 | 状态视为未知 |

复现命令：

```powershell
cd device-manager
npm run demo:interface-faults
```

这仍是本进程内的故障注入 Mock，不是安全组、云边端组或设备组的真实接口联调；跨组契约也尚未冻结。

## 自动化结果

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `npm test` | PASS（76/76，2026-09-29） | Mock 工具、Task Runtime、编排器、真实 HA REST 适配器、故障场景、Skills 和个性化计划确认执行 |
| `npm run acceptance` | PASS（10/10） | 设备发现、插座控制、传感器读取、场景、个性化计划确认/回读、开锁拦截、诊断和事件审计 |
| `npm run plugin:validate` | PASS | OpenClaw 插件清单和设备、调度、记忆、场景工具定义有效 |
| `node common-contracts\\validate-examples.mjs` | PASS（14 个有效、3 个预期拒绝） | 公共契约示例与缺字段拒绝样例 |
| `npm run verify` | PASS（2026-09-29） | 上述检查的一键入口：76 项测试、10 项 Mock 验收、插件校验及契约样例校验 |

本次只在 Mock Home Assistant 上运行自动化验收；它不代表真实 HA/家具已接入。

## OpenClaw Agent 实际调用验收（2026-09-24）

通过本机 OpenClaw CLI 调用 `device-manager` Agent 完成一次 Mock 睡眠场景闭环；OpenClaw CLI 与 Gateway 版本均为 `2026.7.1-2`，模型为 DeepSeek V4 Flash。

| 阶段 | 实际结果 |
| --- | --- |
| 计划预览 | Agent 调用 `plan_scene` 生成睡眠场景计划；只读预览，未控制设备。未读取到已确认的卧室温度偏好，因此计划采用场景默认值 26°C。 |
| 用户确认与执行（历史验收） | 当时的工具版本要求用户在看到完整计划后，于后续消息原样发送一次性确认口令；Agent 随后调用 `execute_scene_plan`。返回 `confirmation_verified: true`、`plan_revalidated: true`、`execution_performed: true`。该交互已调整为自然语言确认，需在本机 OpenClaw 对话中复测。 |
| 执行后回读 | 客厅灯关闭（亮度 0）、客厅窗帘关闭（位置 0）、卧室空调开启并设为 26°C；四项目标状态均 `verified: true`。 |

执行轮的 OpenClaw 调用元数据为 `thinking: off`。该验证运行在 Mock HA 后端，不连接或控制真实 Home Assistant/家具；26°C 仅为场景默认值，没有写入长期偏好。此处记录的是一次 Agent 运行结果，不代替上方自动化测试，也不代表真实设备联调完成。历史运行使用固定确认口令；当前版本改为 Agent 将用户后续明确肯定答复映射为内部 `user_confirmed: true`，自然语言交互的 Gateway 实测尚待复测。

2026-09-29 本机环境补充：OpenClaw `2026.7.1-2` 独立 profile 已注册 `learning-companion` 和
`energy-saving`，并通过本机 CLI 核验两个工作区 Skills 可发现；`device-manager` 也处于该 profile。
注册/Skill 发现不等于这些 Agent 已通过远程消息机制互相调用；进程内调度器和本机 OpenClaw profile
仍是两项不同的验证。注册状态保存在该电脑的 OpenClaw 配置，不随本报告或仓库迁移。

## 已验证功能

- 设备发现：10 个 Mock 设备，包含灯、插座、空调、窗帘、门锁、温湿度、人体、门磁和烟雾传感器。
- 统一设备视图：`canonical_id`、来源实体、可用性、状态快照和能力分离，便于跨 Agent 传递。
- 控制闭环：控制前检查设备和参数，执行后必须回读状态；状态未改变时返回
  `POST_ACTION_VERIFICATION_FAILED`。
- 安全控制：门锁 `unlock` 未带明确确认时返回 `CHALLENGE/CONFIRMATION_REQUIRED`，不调用设备动作。
- 场景：`plan_scene` 只读预览；`execute_scene_plan` 要求 Agent 在后续独立消息中识别到明确肯定答复（计划十分钟有效），执行前重校验偏好和设备，个性化温度再做范围预检，执行后逐项核对目标状态并关联审计 ID。用户无需输入内部计划 ID/口令。OpenClaw 对话层拒绝直接调用固定参数 `run_scene`。
- 多 Agent 自然语言演示：新增 `run_mock_agent_chain_demo`，用户可在 OpenClaw 对话中用自然语言请求演示；工具在专用 Mock HA 中合成占用/学习事件，经过学习伴学、节能和设备管家，最终回读客厅灯状态。单测与插件结构校验通过；合成事件不代表真实感知，不控制真实设备。
- 家庭偏好学习 Mock 演示：新增 `run_mock_household_memory_learning_demo`，用合成温度/亮度事件演示候选形成、确认与只读建议，不触碰正式家庭记忆或真实 HA。2026-10-15 本机 `2026.7.1-2` Gateway 实测及统计准确性复测见 A-08。
- 任务运行时：兼容旧 `control_device` Task 和 `device_action` canonical Task，支持 PolicyDecision、
  trace_id、幂等键和标准回执。
- 事件和审计：动作成功写入 `action_executed`，动作失败/超时/状态不一致写入 `action_failed`，
  诊断异常写入 `diagnostic_alert`；均可用 `get_device_events` 查询。
- 真实 HA 适配器：已用无网络 fake fetch 验证实体白名单、Bearer 认证、服务映射、回读失败、超时、
  认证失败和场景预检，不包含任何真实令牌。
- `user_confirmed` 是 Agent 的对话判定，不是工具层独立验证的身份凭据；真实家具部署前如需可信审批，应接入 OpenClaw 原生人工审批或外部确认界面。

## 尚未宣称完成的部分

- 尚未接入实验室真实 Home Assistant、MQTT、Matter 或真实家具；需要设备组提供 HA 地址、长期令牌
  和实体 ID 白名单后才能联调。
- 事件账本默认是有界进程内存实现，最多保留最近 200 条；真实 HA 后端只有显式设置 `DEVICE_MANAGER_EVENT_LEDGER_PATH` 时才使用脱敏本地 JSON 跨重启保留事件。Mock 账本与动作审计仍是进程内存。该本机日志不是统一日志服务，也未应用层加密。
- `common-contracts` 仍是 v0.1 讨论稿，正式字段需和其他小组确认后冻结 v1。
- 学习行为模型输出只能作为事件或建议，不能在准确率和误报率未达标前直接触发高风险设备控制。

## 建议的跨组联调顺序

1. 用协议组提供的地址、令牌和实体白名单运行只读 `npm run ha:check`。
2. 只接入灯或插座，验证“Task → PolicyDecision → ResourceStatus → 设备管家 → 状态回读 → Event”。
3. 通过 `get_device_events` 和 HA 日志比对 `trace_id`、动作结果和真实状态。
4. 最后再接入窗帘、空调等设备；门锁只在人工确认链路完整后联调。

## A-06 持续离线与共同基础设施告警聚合（2026-10-11）

实现普通设备离线宽限与多设备共因聚合策略，防止可能的断电、网络或 Home Assistant 连接问题被拆成多台设备各自故障。监测仍为只读，不会自动修复或控制设备。

| Mock 场景 | 结果 |
| --- | --- |
| 单台普通设备在宽限期内恢复 | 只写脱敏瞬时事件，不生成故障告警 |
| 单台普通设备超过宽限期仍离线 | 复查确认后产生 `warning` |
| 三台及以上同时持续离线 | 只有宽限期复查确认仍离线的设备计入阈值；普通设备合并为一条 `diagnostic_shared_infrastructure_suspected`，明确配置的安全关键设备仍可单独产生 `critical` |
| 共同故障候选期间，部分设备恢复 | 暂缓普通单设备告警；核查结束后，只对仍离线的设备恢复单独跟踪，避免漏报或重复报 |
| 同时离线数量降到阈值以下 | 写入 `diagnostic_shared_infrastructure_cleared`，仍离线普通设备恢复单独跟踪 |
| 设备恢复或 HA 清单中消失 | 分别记录恢复或结束跟踪；不会把实体消失伪装成设备已修复 |

自动化回归结果：`device-manager` `npm test` 144/144 通过；`npm run acceptance` 10/10 通过；OpenClaw 插件校验通过；公共契约校验 17 个有效及 4 个预期拒绝样例通过。测试覆盖多设备候选部分恢复后的单设备告警恢复，以及事件账本容量淘汰和事件 ID 单调性。`npm run demo:device-monitor` 可复现单台离线和多台聚合场景。上述结果来自本地 Mock/Fake WebSocket；尚未连接真实 HA、网络或家电。

## A-07 房间节能场景差距分析与反馈适配（2026-10-11）

新增场景分析、显式个性化反馈和执行回读汇总。工具会按最新 HA 清单判断指定确认房间的场景状态（`ready`、`partial`、`blocked`），列出设备审核、房间确认、节能授权、在线状态和动作能力方面的缺口及下一步建议。用户可明确设置设备优先/排除/恢复默认；未来计划遵循这些偏好，但设备优先选择仍必须通过原有登记与授权门槛。执行后记录动作尝试和回读验证计数。

| 验收项 | 结果 | 边界 |
| --- | --- | --- |
| 场景缺口分析 | PASS | 返回可执行子集、缺口原因和下一步建议；只读，不控制 |
| 显式排除/恢复设备偏好 | PASS | 偏好写入本地档案并跨工具实例加载；排除应用到后续计划 |
| 优先设备偏好 | PASS | 只有符合全部审批、房间、授权、在线及动作能力条件才优先展示 |
| 未审核设备的优先请求 | PASS | 仅记录用户偏好，不越权纳入动作 |
| 反馈与执行评估 | PASS | 统计结构化反馈、动作尝试和状态回读；不存原始聊天文本 |
| 节能效果报告 | PASS（正确限制） | 无能耗基线时明确 `quantified=false`，不虚构 kWh 或节能百分比 |

验证：`npm run verify` 全部通过；`npm test` 149/149，`npm run acceptance` 10/10，插件清单校验通过，公共契约 17 个有效与 4 个预期拒绝样例通过。新增 5 项场景测试覆盖缺口建议、反馈显式门槛、偏好持久化/重置、优先排序、安全授权门槛和不虚报节能量。结果全部基于本地 Mock；没有真实 HA/家电联调，也没有实测节能率。

## A-08 DeepSeek 家庭偏好学习自然语言工具验收（2026-10-15）

本机 OpenClaw `2026.7.1-2` Gateway 配置最初未在 `device-manager.tools.alsoAllow` 放行 `run_mock_household_memory_learning_demo`。已备份配置并仅追加该工具，重启后确认 Gateway 可用。随后通过 OpenClaw `device-manager` Agent 的自然语言入口实测：DeepSeek V4 Flash（thinking off）成功调用该工具 1 次、0 次失败、未使用模型回退。

第一次模型回复把事件数总结为 12，而 Mock 工具输出实际包含 13 条事件记录。为避免模型自行估算，工具结果增加了结构化 `event_summary`，并在工具说明中要求按其字段复述；Gateway 重启加载后再次实测，DeepSeek 准确返回以下数量：

| 统计项 | 结果 |
| --- | ---: |
| 事件记录总数（含同日重复手动事件） | 13 |
| 接受的手动事件记录 | 8 |
| 忽略的自动化/Agent/未知来源记录 | 5 |
| 去重后的证据日期数 | 6 |

模拟结果形成空调 24°C、灯光亮度 65% 两项候选；候选确认是在 Mock 工具内部模拟，不是用户对真实家庭偏好的实际确认。最终只产生回家场景只读建议，`execution_performed=false`；事件及记忆写入临时目录并在演示结束后删除。此测试没有连接、查询或控制真实 Home Assistant/设备，也没有训练模型。

修改后 `device-manager` 自动化测试为 179/179 通过。该结果证明本机 OpenClaw → DeepSeek → 设备管家模拟工具的自然语言调用链和工具结果复述可用；不证明真实 HA 接入、真实用户偏好学习或实际设备控制已完成。

## A-09 能耗分析与维护管理 OpenClaw 工具（2026-10-17）

本轮把已有的节能分析和设备维护计划能力接入设备管家 OpenClaw 插件，新增 `analyze_energy_usage`、`evaluate_energy_effect`、`save_maintenance_schedule`、`get_device_maintenance_plan`、`record_device_maintenance_completed` 五项工具。维护日程与完成历史写入 OpenClaw 本地状态目录的 `device-manager/maintenance-schedules.json`，并可在新 Store 实例中恢复。

维护完成记录必须传 `user_confirmed: true`，没有维护间隔时不推测下次日期；记录动作不代表 Agent 实际更换耗材、维修、复位或控制设备。能耗分析只处理调用方显式提供的读数，未连接 HA/电表，也未自动读取设备诊断。工具不会将前后观察差异表述为因果节能量。

| 验证项 | 结果 |
| --- | ---: |
| 新增工具及持久化测试 | PASS（13/13） |
| `device-manager` 全量测试 | PASS（240/240） |
| `energy-saving` 全量测试 | PASS（43/43） |
| 设备管家 Mock 验收 | PASS（11/11） |
| OpenClaw 插件清单校验 | PASS（隔离 `OPENCLAW_STATE_DIR` 后构建并校验） |
| 公共契约样例校验 | PASS（17 个有效、4 个预期拒绝） |

后续复核补齐维护存储对未知 schema 版本 fail-closed 且不覆盖原文件的测试；
针对性测试仍为 13/13，设备管家全量回归保持 240/240。

假设审查首轮发现的 5 项接口/语义空白已补充到 A-021–A-025，A-002、A-003、A-020 的台账描述已更正。第二轮复审因审查任务额度用尽而未完成；以上通过的是自动化测试和插件/契约校验，不等同于独立复审或语义正确性背书。

上述结果证明插件代码注册、工具路由和本地逻辑测试通过，不代表运行中的 OpenClaw Gateway 已重新加载该版本。本轮没有重启或改写用户全局 Gateway 配置；真实 HA、电表和物理家电仍未接入。完整接口说明见 [`../docs/energy-operations-openclaw-tools-and-maintenance-store-v0.1.md`](../docs/energy-operations-openclaw-tools-and-maintenance-store-v0.1.md)。

## A-10 维护周期本地提醒收件箱（2026-10-18）

在已持久化的维护计划之上增加本地提醒收件箱与 6 个 OpenClaw 工具：按需检查、启动/停止周期检查、查看状态、列出提醒、明确确认已读。检查只处理 `DUE_SOON`、`DUE`、`OVERDUE`；同一维护周期去重，状态升级时更新条目，逾期升级可重新打开已读提醒。标记已读不代表维护已完成，仍须单独调用显式完成记录。

周期检查默认关闭；需管理员本机设置 `DEVICE_MANAGER_MAINTENANCE_REMINDERS_ENABLED=true`，并由用户明确要求启动。默认每小时检查一次，提醒只写入本地 OpenClaw 收件箱；没有手机/外部推送，Gateway 重启后不会自动恢复周期检查，也不执行设备或物理维护。

| 验证项 | 结果 |
| --- | ---: |
| 维护提醒专项测试 | PASS（8/8） |
| `device-manager` 全量测试 | PASS（248/248） |
| 设备管家 Mock 验收 | PASS（11/11） |
| `energy-saving` 全量测试 | PASS（43/43） |
| OpenClaw 插件清单校验 | PASS |
| 公共契约校验 | PASS（17 个有效、4 个预期拒绝） |

上述为本地代码、临时文件和插件注册测试，不代表运行中的 Gateway 已加载新版插件；本轮没有重启 Gateway 或连接真实 HA。假设审查没有可用复审者，`SWEEP_UNAVAILABLE` 已如实记录，不宣称语义审查通过。接口与启用说明见 [`../docs/maintenance-reminder-inbox-v0.1.md`](../docs/maintenance-reminder-inbox-v0.1.md)。

## A-11 维护提醒隔离演示（2026-10-18）

新增 `npm run demo:maintenance-reminders`，使用临时目录和合成滤芯计划，依次展示 `DUE_SOON`、独立 Node.js 进程重建后保留并去重、用合成夹具模拟确认已读（不是真实用户交互）但不登记维护完成，以及升级为 `OVERDUE` 后同一提醒重新进入待处理列表。演示结束清理临时状态；不启动周期定时器，不连接 Gateway/真实 HA，不调用模型或外部通知，不执行设备动作或物理维护。

自动化 CLI 集成测试和设备管家全量回归通过。该结果证明本地演示路径可运行，不等同于本机 Gateway 已加载新版插件或真实家庭维护状态已接入。

## A-12 维护提醒工具在本机 Gateway 的加载核验（2026-10-18）

用户授权后，对隔离 `2026.7.1-2` Gateway 发起 safe restart。重启后 `gateway status` 显示 CLI/Gateway 版本一致且 `127.0.0.1:18789` 恢复监听；`plugins inspect device-manager --runtime` 显示插件 `loaded`，六个维护提醒工具均出现在运行时工具清单中。没有调用模型、维护提醒工具或真实家庭数据，也没有连接 HA/控制设备。

注意：Windows Scheduled Task 显示 missing，safe restart 不会自动拉起进程，因此本轮按已存在的隔离 profile `state/gateway.cmd` 临时隐藏启动，未创建新的计划任务。Gateway CLI capability 仍为 `connected-no-operator-scope`；本次只证明插件被加载，不证明用户对话里的工具回调已实测。另有 iMessage/Telegram bundled channel setup path warnings，与 device-manager 插件加载成功并存。

## A-13 OpenClaw 可调用的隔离维护提醒演示工具（2026-10-18）

新增 `run_mock_maintenance_reminder_demo`，仅响应用户明确的维护提醒演示请求。工具复用既有隔离演示并仅返回阶段摘要，覆盖近期提醒生成、独立 Node.js 进程重启后持久化去重、合成“已读”不代表真人确认或维护完成，以及逾期后同一提醒重新打开。演示只写临时目录并在结束后清理，不读取或修改正式维护台账。

验证：`device-manager` 全量测试 PASS（251/251）；OpenClaw `plugins validate --root . --entry ./src/openclaw-plugin.js` PASS；新增工具路由测试确认各阶段结果与安全边界。首次插件校验发现被导入的 CLI 演示脚本含顶层 `await`，OpenClaw 的 jiti loader 无法解析；已将 CLI 入口改为 Promise 启动并复验通过。校验时 iMessage/Telegram channel setup 有非阻断警告。

本轮没有把新演示工具加入本机隔离 profile allowlist，没有再次重启 Gateway，也没有发起 DeepSeek 请求；因此新增工具已在代码、插件清单和自动化测试中就绪，但尚未在本机 Gateway 对话中启用。演示不接真实 HA、不发送通知、不启动周期任务、不执行设备动作或物理维护。

## A-14 维护提醒周期检查的显式重启恢复（2026-10-18）

新增独立、fail-closed 的维护提醒 runner 状态文件。周期检查默认仍关闭；仅当管理员本机开关保持开启，且用户明确调用 `start_maintenance_reminders` 并选择 `resume_after_gateway_restart: true` 时，OpenClaw 后台服务才在 Gateway 重启后恢复周期检查。用户显式停止会停止计时器并清除此恢复意图；Gateway 正常停机/升级只停止内存计时器、保留用户已明确授权的恢复意图。损坏状态不会被覆盖且不会自动恢复。

验证：维护提醒专项测试 11/11 通过；`device-manager` 全量测试 254/254、Mock 验收 11/11、OpenClaw 插件校验和公共契约校验均通过。用例覆盖恢复授权持久化、模拟进程重建、Gateway 后台服务启动/停止钩子、管理员开关关闭、默认不开启、显式停止清除授权和损坏状态保护。未修改本机 Gateway 配置、未重启 Gateway、未添加 Windows 计划任务、未发送外部通知，也未连接真实 HA/设备。该功能只在 Gateway 本身已经运行时恢复，不负责让 Gateway 随 Windows 自动启动；本机 Gateway 对话中的实际工具调用尚未验证。
