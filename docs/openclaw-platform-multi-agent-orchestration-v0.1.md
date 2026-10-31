# OpenClaw 平台级多 Agent 编排设计与实现（v0.1）

## 目标

让 OpenClaw 用户主对话成为统一入口：由 OpenClaw 当前配置的大模型理解用户表达、判断需要哪些 Agent、整理步骤和依赖；平台调度器只按登记清单校验并调用 Agent；设备操作仍由设备管家按既有设备策略处理。这里没有为每个业务 Agent 另配一套大模型 API。

## 业务链路

```text
家庭用户自然语言
        ↓
OpenClaw 主对话模型：理解意图，提出 Agent 计划
        ↓ orchestrate_household_agents
平台调度器：检查 Agent/能力登记、步骤依赖、设备动作冲突
        ├── 已登记的分析 Agent：按需并行或依赖顺序调用
        ├── 不清楚：返回自然语言问题，零 Agent 调用
        ├── 当前无匹配能力：明确说明暂不支持，零 Agent 调用
        ├── 矛盾/需确认/被阻断：返回问题或停止原因，停止后续步骤
        └── 设备任务：只调用设备管家 Agent，由其执行原有安全策略
        ↓
OpenClaw 主对话：汇总结果，或用日常语言向用户提问
```

## 谁负责什么

| 组件 | 职责 | 不负责 |
|---|---|---|
| OpenClaw 主对话模型 | 理解用户自然语言；选择一个或多个已登记 Agent；将任务拆成步骤；根据调度结果答复或追问 | 不能凭模型计划绕过代码门禁或把建议当成设备授权 |
| 平台调度器 `multi-agent-orchestrator` | Agent/能力白名单；计划和依赖校验；并行/顺序派发；设备动作冲突拦截；汇总 Trace；在澄清、确认、失败或阻断时停止后续步骤 | 不连接 Home Assistant，不直接操作设备，不单独调用 DeepSeek |
| 业务 Agent | 在登记的能力范围内分析或处理任务，并返回有类型的 JSON 结果 | 不能自行声明已获得设备策略批准 |
| 设备管家 Agent | 查询设备；负责唯一的设备操作入口；继续执行设备登记、风险策略、必要确认、动作和状态回读 | 不承担所有业务 Agent 的通用总调度职责 |

## 编排策略

- Agent 不是按固定顺序全部调用。OpenClaw 根据本轮任务提交一个或多个步骤及依赖。
- 同一条用户消息只提交一份完整计划、调用一次 `orchestrate_household_agents`。请求包含多个子任务时，将每个相关 Agent 放入同一份 `steps`；无依赖的分析可并行，有先后关系的步骤用 `depends_on` 表达。只在澄清/阻断后收到用户新信息时，才重新提交计划。
- OpenClaw 主对话模型负责理解用户意图并动态组合已登记能力；调度器不要求每种说法都预先写一条规则，但也不会因此创造新能力或放行任意工具调用。
- 当需求可能由现有能力完成但缺少信息时，OpenClaw 可提交 `decision=clarify` 和面向用户的问题；当登记能力确实无法完成时，可提交 `decision=unsupported` 和诚实说明。这两种决定均不需要 Agent 步骤，且不会调用 Agent 或设备。
- 未登记的 Agent 或能力引用会在派发前返回 `UNSUPPORTED`、稳定原因码和面向用户的通用说明；不会把内部 ID 暴露给用户，也不会产生 Agent 调用。重复步骤、缺失依赖或依赖循环仍属于计划格式错误，会在派发前拒绝。
- 没有依赖关系的分析/规划 Agent 可以并行；同一个 OpenClaw Agent 会话的调用串行，避免互相读到对方的回复。
- 存在设备动作时，先完成同一轮中可运行的分析/规划步骤；设备管家动作独立派发，不与分析 Agent 并发。
- 同一请求涉及多项设备操作时，OpenClaw 必须把完整设备意图放在一个 `device_action` 步骤中交给设备管家。设备管家使用已登记清单、候选计划校验器、冲突策略及既有确认流程，一次性核对整组动作；不得将多个潜在副作用步骤拆成独立调用。
- 如果 OpenClaw 提交了多个 `device_action` 步骤，调度器先用已明确的动作/目标元数据检查可见的互斥冲突；发现冲突则在派发前询问用户。无冲突但有多条设备动作、或其中动作信息不完整时，调度器返回专用 `BLOCKED` 结构码且零 Agent 调用。OpenClaw 主对话应把动作合并为一个设备管家步骤后自动重提一次；若设备目标/用户意图仍不清楚，再询问用户。
- 调度器提供的动作元数据仅用于计划结构和冲突预检，不构成授权，也不代替真实设备解析。设备管家仍须核验真实清单、能力、家庭策略、确认要求，并按工具结果回读验证。
- Agent 返回 `NEEDS_CLARIFICATION`、`CONFLICT`、`NEEDS_CONFIRMATION`、`BLOCKED` 或 `FAILED` 时，调度器停止所有尚未开始的步骤，包括同一并发批次中尚未派发的排队任务。已经发出的并行调用不能撤销，调度器会等待其完成并把结果一并返回；不会再启动新步骤。OpenClaw 用普通语言向用户说明；收到用户答复后重新生成一份计划，不复用未经持久化的旧计划。
- 如果并行 Agent 同时返回多个停止结果，顶层状态按保守优先级选择：`FAILED` > `BLOCKED` > `CONFLICT` > `NEEDS_CONFIRMATION` > `NEEDS_CLARIFICATION`；同级按计划中的原始步骤顺序决定顶层问题，所有 Agent 的停止结果都保留在 `results` 中。
- Agent 超时或调用结果不明时不自动重发；如果调用已发出，结果会标记副作用可能未知，避免重复动作。

### 没有现成规则或能力时

这套设计不是“为每句话预写一条 if/else”。OpenClaw 模型可以把日常表达映射到已登记能力，并将多个能力组合成计划；比如用户说“孩子写完作业后提醒我关灯”，模型可先分析是否涉及学习/节能，再把明确设备任务交给设备管家。调度器只验证这些 Agent/能力确实存在、步骤关系合理且安全门禁通过。

如果模型无法判断用户目标，返回 `NEEDS_CLARIFICATION` 并请用户补充；如果目标明确但当前登记能力做不到，返回 `UNSUPPORTED` 并说明暂时无法处理；如果模型意外提交不存在的 Agent/能力，调度器同样在执行前拦截，并确保零 Agent/设备调用。新出现的能力缺口需要开发并登记相应 Agent/能力，模型不能靠“猜”来补齐。该机制不能保证识别所有罕见情况，但确保未覆盖场景不会因模型临时编造路由而误执行。

## 示例：用户说“客厅没人了，看看能不能省点电”

1. OpenClaw 理解需求，选择能源管家评估节能机会；如确实需要看设备状态，再安排设备管家查询。它不会因为固定规则就依次调用全部 Agent。
2. 调度器先验证这两个 Agent 和所选能力已经登记，再验证依赖关系；互相独立的分析可以并行。
3. 如果能源管家发现占用信息过期或结果不确定，它返回一个具体问题，调度器停止设备任务。OpenClaw 会问用户是否继续检查或暂不处理。
4. 如果分析清楚且涉及设备变化，OpenClaw 将明确的设备请求交给设备管家。设备管家重新检查设备、家庭策略及确认要求；调度器本身不直接调用 HA。
5. 如果设备管家需要确认或返回执行结果不确定，问题/状态回到 OpenClaw 主对话；用户回答后由 OpenClaw 重新规划。

平台结果中的 `COMPLETED` 表示本次计划中的 Agent 调用均完成，不代表平台自己执行过物理设备操作。设备是否实际改变只能根据设备管家工具返回的执行与状态回读证据说明；`device_action_agent_invoked` 仅表示请求已交给设备管家。

## Agent 返回契约

每个 Agent 被调用后必须返回一个裸 JSON 对象，不得使用 Markdown 包裹。`source_agent` 和 `trace_id` 必须与本次请求一致，`result` 可省略或为空对象：

```json
{
  "status": "COMPLETED",
  "source_agent": "energy-saving",
  "trace_id": "trace-01",
  "summary": "当前没有需要处理的节能机会。",
  "result": { "opportunity": false }
}
```

Agent 返回状态包括 `COMPLETED`、`PROPOSED`、`NO_ACTION`、`NEEDS_CLARIFICATION`、`NEEDS_CONFIRMATION`、`CONFLICT`、`BLOCKED`、`FAILED`。需要澄清/确认/冲突时必须包含面向用户的 `question` 或 `message`，可附 `options`；身份、追踪号或结果结构不合规则按失败处理。另有平台顶层结果 `UNSUPPORTED`：表示模型明确判断无已登记能力，或调度器拦截了未登记的 Agent/能力；它不是 Agent 返回状态，也不触发 Agent 调用。设备管家返回设备任务时仍需由它自己的执行与策略流程决定是否操作。

## 新增 Agent

基础登记包含学习伴学、节能和设备管家。增加其他业务 Agent 时，在 `platform-orchestrator` 插件配置的 `additionalAgents` 中登记 `agent_id`、名称及能力和影响类型，并确保该 Agent 已在 OpenClaw 配置、A2A 策略和会话可见性策略中获准。插件只允许新增 `read_only` 或 `planning` 能力；`device_action` 始终只允许设备管家声明。调度器不会扫描 Gateway 中的所有 Agent，也不会调用用户计划里临时编造的 ID。

## 代码位置

- `multi-agent-orchestrator/src/platform-agent-registry.js`：平台 Agent/能力登记。
- `multi-agent-orchestrator/src/platform-orchestrator.js`：步骤校验、并发/依赖派发、冲突检测和停止/追问门；预算进度估算会在派发前校验结构化输入、至少 3 个连续完整日、逐日数据无缺漏及完整性声明，不满足时返回澄清且不调用任何 Agent。
- `multi-agent-orchestrator/src/openclaw-platform-adapter.js`：以 OpenClaw `runtime.subagent.run`、`waitForRun`、`getSessionMessages` 调用已登记 Agent，并执行 A2A/会话可见性校验；单次调用默认最多等待 120 秒，超时后不自动重试，也不代表后台 Agent 已停止。
- 能源管家在平台能力清单中分别登记能耗分析、前后用量比较、预算估算和电价排程，主 Agent 可按请求类型选择对应能力。调用失败或超时时，主 Agent 只能说明分析未完成，不能自行计算或推测原因来替代。
- `multi-agent-orchestrator/src/openclaw-platform-plugin.js`：注册给 OpenClaw 用户主 Agent 的 `orchestrate_household_agents` 工具。
- `multi-agent-orchestrator/openclaw.plugin.json`：OpenClaw 插件清单。
- `multi-agent-orchestrator/test/platform-orchestrator.test.js`、`openclaw-platform-adapter.test.js`：核心调度和 Gateway 接口 Mock 测试。

## Agent 会话上下文

适配器默认将 Agent 请求发往 `agent:<agent_id>:<session.mainKey>` 会话，`mainKey` 未配置时为 `main`。因此，同一目标 Agent、同一 mainKey 下的多次请求共享该 Agent 的会话历史；请求正文仍只转发本次任务及必要输入/依赖结果。若未来需要多家庭、多用户隔离或无历史上下文的完全独立调用，应先明确会话键策略并补相应验收。

## 验证与边界

当前自动化测试验证登记/能力校验、依赖图、并行分析、设备动作隔离、多个设备动作步骤被预检拦截、缺少动作元数据时零派发、同设备冲突询问、预算估算输入的完整性预检、单个自然语言设备任务仍可由设备管家自行核实/澄清、Agent 不确定时停止后续执行、Agent 身份/trace 校验、Gateway 授权拒绝和不自动重发。预算预检覆盖两天样本、缺少完整性声明、逐日缺口时零 Agent 派发，以及满足要求的三天完整数据可以正常派发。Mock 测试不等于真实 HA 或设备验收。

澄清回复按 MVP 处理：插件不跨 Gateway 重启保存待答计划；用户回复后 OpenClaw 根据新信息重新规划并再次提交。通用调度规则覆盖登记能力和明确场景，不宣称可穷举所有家庭罕见情况；无法判断时通过 Agent 的追问/阻断结果交还用户。

2026-10-25 的隔离 OpenClaw 2026.7.1-2 Gateway 完成真实运行时联调。主对话工具清单开放 `orchestrate_household_agents`，并屏蔽旧固定入口 `talk_to_device_manager` 与业务设备工具。首次 WebChat 联调中，一条含两个只读子任务的请求被拆成两次调度调用；随后在主对话指令中明确要求每条用户消息合成一份完整计划，并通过 Gateway 主会话再次运行同一场景。

复核轨迹确认主对话只调用了一次 `orchestrate_household_agents`，计划内含两个有关联的步骤：设备管家 `inspect_household` 查询洗碗机是否登记，能源管家 `evaluate_energy_opportunity` 在前一步之后计算电费窗口。两个步骤均返回 `COMPLETED`；清单未发现洗碗机，能源管家按用户提供的假设负载算出 20:00–22:00 约 0.42 元；`device_action_agent_invoked=false`，未控制设备、未创建预约。该运行证明 OpenClaw 主对话能动态挑选多个已登记 Agent，通过平台调度器提交依赖计划并汇总结果。设备清单扫描会刷新本地登记信息，不会控制设备。复核由 Gateway CLI 写入 `agent:dev:main` 主会话，尚未通过桌面截图确认浏览器已显示该条回复。

Gateway 重载插件后完成了安全分支复核：对“客厅那边帮我弄舒服一点”，主对话提交 `decision=clarify`，调度器返回 `NEEDS_CLARIFICATION`，`agent_calls_performed=false`；对“让客厅灯保持亮着，同时客厅全黑”，也返回自然语言二选一问题，未派发 Agent、未操作设备。

另将同一设备的 `turn_on` 与 `turn_off` 作为两个无依赖 `device_action` 步骤提交，调度器在派发前返回 `NEEDS_CLARIFICATION`、原因 `DEVICE_ACTION_CONFLICT`；`agent_calls_performed=false`、`device_action_agent_invoked=false`，并向用户询问保留哪项或如何排序。门锁解锁请求则通过设备管家只读核对设备和状态后返回 `NEEDS_CONFIRMATION`；未提交确认答复，未调用设备写工具，门锁保持上锁。这里 `device_action_agent_invoked=true` 仅表示设备管家 Agent 收到请求，不表示设备已被控制。

旧截图记录的是配置更新前固定转接入口的失败尝试，不代表上述复核后的链路。当前已在 Gateway 实时验收多 Agent 计划、澄清、动作冲突拦截和门锁待确认；用户确认后的门锁执行与执行回读尚未验收。桌面自动化当前不可用，因此浏览器页面显示仍未通过截图核对。

### 2026-10-29 Debian Gateway RPC 复核

在 Debian 12 / Node.js 24.22.1、OpenClaw `2026.7.1-2` 的临时 Profile 中，通过 loopback token 认证调用主 Agent `main` 的 `orchestrate_household_agents`。只调整了临时 Profile 的 `frontdoorAgentId`，验证后已恢复配置并关闭 Gateway。

- `decision=clarify` 返回 `NEEDS_CLARIFICATION`，`agent_calls_performed=false`。
- 提交未登记 Agent 返回 `UNSUPPORTED` / `AGENT_NOT_REGISTERED`，没有派发。
- 对同一 Mock 灯提交 `turn_on` 和 `turn_off` 返回 `NEEDS_CLARIFICATION` / `DEVICE_ACTION_CONFLICT`，没有派发。
- 提交已登记的能源管家步骤时，临时 Profile 的 A2A 默认关闭，Gateway 返回 `AGENT_CALL_FORBIDDEN`。适配器在调用 `runtime.subagent.run` 前完成授权检查，因此没有启动子 Agent 或调用模型。该响应的 `agent_calls_performed=true` 表示调度器尝试了 Agent 注册表调用并收到拒绝，不代表子 Agent 已开始运行。

随后用新的隔离 State Dir 验证了成功派发分支：临时 Profile 登记 `main` 与 `energy-saving`，A2A allowlist 只放行这两个 Agent，会话可见性设为 `all`。从 `main` 的 Gateway RPC 调用 `orchestrate_household_agents`，提交一个合成的客厅无人事件和单一 `evaluate_energy_opportunity` 步骤。OpenClaw 成功启动能源管家 Agent，本地 loopback 假模型成功返回 1 次能源任务的结构化响应，状态为 `PROPOSED`，`source_agent` 与 `trace_id` 校验通过；调度结果为 `COMPLETED`，`agent_calls_performed=true`、`device_action_agent_invoked=false`，结果明确标记 `device_write_performed=false`。这验证了 Linux Gateway 的 A2A 授权、子 Agent 调用、回包校验和结果汇总。模型回复由固定本地测试服务生成，不用于评估真实模型的语义理解能力；该验证未调用云模型或 HA，也未执行设备写操作。临时 Gateway 与假模型已经停止，临时 Profile 配置已恢复。

首次试跑时假模型声明的上下文窗口只有 8K，而能源管家的系统提示与技能提示估算约 8.1K，OpenClaw 在正式模型请求前触发上下文溢出。将临时模型上下文调为 32K 并使用新的 State Dir 后，派发成功；这属于测试端配置问题，不是 A2A 权限拒绝。

同日继续在独立临时 Profile 验证多 Agent 计划。A2A allowlist 只放行 `main`、`learning-companion` 与 `energy-saving`，会话可见性为 `all`；模型端点绑定容器 `127.0.0.1`，返回固定合成结果。

- 一份计划包含两个无依赖分析步骤时，学习伴学和能源管家均被调用并返回有效结构化结果；Gateway 汇总为 `COMPLETED`。假模型记录到两个请求时间重叠，峰值并发为 2。
- 能源管家步骤依赖学习伴学步骤时，下一 Agent 的请求实际携带 `learning-review-dependent` 的依赖结果，两个步骤依次成功完成。
- 学习伴学返回 `NEEDS_CLARIFICATION` 时，主工具返回面向用户的问题，能源管家的依赖步骤保持未执行；假模型只收到学习伴学的一次请求。

这些验证证明真实 OpenClaw Gateway 的多 Agent 并发、依赖数据传递和澄清停止链路可运行；固定回包不用于评价模型语义理解。全程未调用 DeepSeek/云模型或 HA，没有设备写入。临时 Gateway 与本地假模型已关闭，Profile 配置已恢复。

随后通过 `openclaw agent --agent main` 输入普通中文合成家庭请求完成端到端验证。Main Agent 从工具目录发现并调用一次 `orchestrate_household_agents`；该计划同时派发学习伴学与能源管家，前者返回学习状态摘要，后者返回节能建议。调度结果为 `COMPLETED`，两个步骤的结果回到 main Agent，main 再生成日常中文答复。只在本机固定模型服务发生 4 次请求（前台规划、两个业务 Agent、前台汇总），`device_action_agent_invoked=false`。这证明普通对话入口到插件、跨 Agent 派发、结果回传及主对话总结的调用链路连通；由于模型服务按脚本返回固定工具调用和文本，不能说明真实模型已具备相同的意图理解能力。无云 API、HA 或设备写入。

再以“帮我把家里弄舒服点”验证普通对话的澄清分支。Main Agent 调用同一编排工具并提交 `decision=clarify`，工具返回 `NEEDS_CLARIFICATION`、询问用户想调温度、灯光还是其他方面，`agent_calls_performed=false`。没有派发任何业务 Agent。该结果验证澄清状态能从编排工具回到 OpenClaw 主对话；识别含糊表达的能力仍需真实模型单独评估。

另以“客厅没人了，帮我看看灯要不要关”验证计划分析到设备确认的流程：能源管家先返回 `PROPOSED`，设备管家收到其依赖结果后返回 `NEEDS_CONFIRMATION` 并询问是否关灯。主对话汇总为自然语言问题；顶层 `device_action_agent_invoked=true` 仅表示设备管家收到请求，设备管家结果明确为 `execution_performed=false`、`device_write_performed=false`。临时 Profile 禁用了设备写工具且未配置 HA 凭据，未执行控制。该轮结束时两次自动权限审核超时；之后已停止两个临时进程、恢复测试前的隔离 Profile 配置，并确认 `19287`、`19288` 端口均已关闭。

2026-10-29 使用隔离 B Profile 和 DeepSeek `deepseek-v4-flash`，对明确的能源分析请求完成真实模型端到端验证。主对话调用一次 `orchestrate_household_agents`，计划只派发 `energy-saving.evaluate_energy_opportunity`；能源管家返回 `COMPLETED`，顶层为 `agent_calls_performed=true`、`device_action_agent_invoked=false`。估算结果为 3 盏 8 W 灯连续 9 小时约耗电 `0.216 kWh`、约省 `0.1728 元`。随后以“帮我把家里弄舒服点”验证澄清分支，编排器返回 `NEEDS_CLARIFICATION`，`agent_calls_performed=false`。再以关灯与整晚常亮的矛盾请求验证安全评估：实验用 `security-review-fixture.detect_instruction_conflict` 返回 `CONFLICT`，编排器转为 `NEEDS_CLARIFICATION`，`device_action_agent_invoked=false`。远程开锁请求使安全评估返回 `NEEDS_CONFIRMATION`，设备管家的依赖步骤未运行；续接同一会话并只给聊天文字确认、明确未完成 PIN/绑定手机验证后，Main Agent 再次返回 `NEEDS_CLARIFICATION`，`agent_calls_performed=false`、`device_action_agent_invoked=false`。这证明该场景中聊天确认未绕过二次验证要求，但没有实现真实身份验证流程。`security-review-fixture` 不代表项目已经交付正式安全 Agent。临时 Profile 没有 HA 插件或凭据，设备写能力未开放，所有结果均未读取或控制真实设备。完整输入、原始轨迹和成本记录见 [DeepSeek/OpenClaw 冒烟验证记录](../experiments/orchestration-comparison-v1/results/direct-deepseek-openclaw-smoke-2026-10-29.md)。这些验证只覆盖明确节能、含糊澄清、一种矛盾请求、门锁确认和聊天确认不足这几个具体场景。

## OpenClaw 安装提示

该插件是 `multi-agent-orchestrator` 下独立的平台插件，不是设备管家插件里的总调度函数。部署时应将此插件安装到 Gateway，并在用户主 Agent（默认 `dev`）允许使用 `orchestrate_household_agents`；同步配置 Gateway 的 Agent-to-Agent 白名单和会话可见性。主 Agent 的工作区指令必须将 `orchestrate_household_agents` 设为家庭请求的唯一入口；旧的固定 `talk_to_device_manager` 入口应停用，不能继续在指令里要求主 Agent 调用它。

部署器会安装独立的平台插件、把 `orchestrate_household_agents` 开放给主 Agent、显式禁用旧固定转发入口，并通过目标 Gateway CLI 生成插件元数据。2026-10-25 的本机隔离 Gateway 已单独应用该配置；该运行时配置与交付代码包的部署流程分开维护。
