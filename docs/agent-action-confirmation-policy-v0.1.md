# Agent 设备动作确认、冲突与不确定处置 v0.1

## 目的与实现范围

本策略由 OpenClaw 工具层、`device-manager/src/agent-plan-tools.js`、`device-manager/src/orchestrator-bridge.js` 和 `multi-agent-orchestrator/src/plan-workflow.js` 共同实施。OpenClaw/LLM 负责理解用户自然语言、选择 Agent/工具并提出计划；Node.js 层检查 Agent 能力白名单、设备/动作白名单、实时设备状态、证据有效期和资源冲突；设备管家是唯一设备写操作执行者，并在执行后回读状态。

该实现是项目本地原型。确认状态保存在当前插件进程内，最长 5 分钟；Gateway 重启后待确认项丢失。OpenClaw 根据对话回复选择批准、拒绝或暂缓，因此这是人机流程门禁，不是强身份认证。当前公开事件工具没有真实 HA 事件推送和来源认证，不能把工具 JSON 中的 `source_agent` 字段视为凭证。

## 确认分级

| 请求/动作 | 是否确认 | 软件行为 |
| --- | --- | --- |
| 列设备、读状态、查事件、故障诊断 | 否 | 只读直接返回；不调用设备写接口 |
| 用户明确指向一个普通设备的单设备即时操作（灯、插座/开关、空调、窗帘） | 否，免二次确认 | 仍检查设备白名单、在线状态、动作/参数和新鲜证据；成功后回读验证。任一高风险标记都会覆盖默认值 |
| 明确标记为高风险的设备写操作 | 是 | 通过 HA 实体 `risk_level: high/critical`、`requires_confirmation: true` 属性或 `HA_CONFIRMATION_REQUIRED_ENTITIES` 实体 ID 清单标记；展示设备与动作，等待后续明确同意 |
| 门锁锁定/解锁 | 是 | 高风险；每次都确认。`confirmed: true` 参数不能绕过 OpenClaw 策略 |
| 场景、多个设备动作、OpenClaw/LLM 提出的候选计划 | 是 | 先展示完整步骤，再等待明确确认；确认后刷新状态/证据并重新校验 |
| 由节能 Agent 生成的自动关灯 | 仅特定可信事件免确认 | 仅内部已认证事件入口、节能 Agent 实际产出的 `light.turn_off`、规则及证据均通过时可自动执行。其他能源设备仍需确认 |
| OpenClaw 对话工具提交的任何事件 | 是（若会导致写操作） | 来源强制标记为未认证；即使 JSON 写着 `ha-event-adapter`，也不能自动控制 |

`control_device.confirmed` 是兼容字段，不再代表确认事实。工具 `resolve_agent_action_confirmation` 只应在用户看见具体动作后，根据后续独立消息中的明确肯定答复批准；拒绝则停止，提问/犹豫/沉默/含糊答复则暂缓。用户无需输入 UUID、审批 ID 或固定口令。

OpenClaw/LLM 可将罕见口语解释为候选意图，但只能在目标、动作和参数都明确且唯一时发起单设备直控；若目标/动作含糊、多种解释并存或模型不确定，应先自然语言澄清。该策略不声称覆盖所有家庭特例；未知风险应通过 `requires_confirmation`、`risk_level` 或 `HA_CONFIRMATION_REQUIRED_ENTITIES` 显式升级，而不可由模型自行降级。

## 冲突时如何处理

1. 候选计划内同一设备存在互斥动作（如同一盏灯同时开和关，且没有清楚的依赖顺序）时，计划工作流返回 `CLARIFICATION_REQUIRED`，不创建批准项、不执行。OpenClaw 应把冲突说清楚，问用户希望哪个动作生效或是否有先后顺序，然后基于答案重新规划。
2. 调度器队列发现同设备同优先级冲突任务时 fail-closed：冲突任务不执行，trace 带 `TASK_CONFLICT` 和涉及的任务 ID。OpenClaw 应暂停自动化、向用户说明冲突设备和提议动作，询问保留哪一个；不能把高优先级当作用户意图或静默丢弃另一项。
3. 有明确依赖顺序的计划可继续做其他安全校验；顺序本身仍不会绕过需要确认的规则。用户确认后校验的是同一份计划指纹，计划内容改变必须重新询问。

## 不确定、证据不足或执行结果未知

- 目标设备或动作不明确：不调用写工具；先问用户要控制哪个房间/设备、执行什么动作。
- 设备不在当前清单、离线、状态读取失败、必需证据缺失或证据超过 5 秒有效期：返回 `DENY`，不执行。向 HA/设备适配器刷新信息；刷新仍失败时报告无法确认当前状态，不能用用户批准代替设备证据。
- 学习行为低置信度、标注待复核、课堂整体画面、非目标儿童、区域不一致或缺少独立占用传感器佐证：节能 Agent 不生成控制任务。不能通过询问用户“是否确认”把不可靠的传感器/视觉数据变成事实；可说明观察不确定并请求新的传感器状态或人工确认事实。
- 动作参数超界或设备能力不支持：拒绝并说明有效范围；不自动改写目标参数后执行。
- 执行调用超时、HA 返回成功但回读不一致、回读失败或出现 `side_effects_unknown`：停止后续动作，不自动重放。先用 `get_state`/`diagnose_device` 读取当前状态；仍未知则报告“执行结果未能确认”，等待用户/运维处理。
- 待确认 5 分钟内没有明确回应：待办过期为 `EXPIRED_NO_ACTION`，设备不动；重新发起时重新取状态和证据。

## 两类事件通路

- 对话/演示通路：`dispatch_agent_event` 和 `submit_agent_plan` 来自 OpenClaw 工具调用，事件/计划均为候选数据。公开通路会覆盖事件来源字段，写任务进入 `CHALLENGE` 并等待确认。
- 内部可信通路：`createOrchestratorBridge().dispatchTrustedEvent()` 不是 OpenClaw 用户工具，只供未来经过身份认证的内部 HA/事件适配器调用。适配器来源必须在内部白名单中；对占用事件，节能 Agent 还检查区域、持续时间、时间新鲜度、置信度、离位规则和独立传感器证据。插件当前没有配置真实事件适配器，故不能宣称已实现真实传感器触发的全自动家电控制。

## 本地验证

```powershell
cd device-manager
node --test test/agent-plan-tools.test.js test/orchestrator-bridge.test.js
cd ..\multi-agent-orchestrator
node --test test/plan-workflow.test.js test/plan-validator.test.js
```

这些测试运行于 Mock Home Assistant，不调用真实大模型、真实 HA 或真实家电。OpenClaw 的确认信号仍由模型从自然语言对话中解释；真实家庭上线前还需要原生确认界面/身份认证、审批持久化，以及 HA 事件适配器联调。
