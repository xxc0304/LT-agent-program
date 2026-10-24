# OpenClaw 计划工具结构与 Gateway 联调记录

日期：2026-10-13  
范围：`submit_agent_plan` 工具输入结构；OpenClaw Gateway + DeepSeek V4 Flash + 隔离 Mock 设备后端。  
安全边界：没有连接真实 Home Assistant 或真实家电；没有批准或执行 Gateway 测试中生成的设备计划；本文不包含 API Key、Gateway token 或其他认证材料。

## 本次代码改进

此前 `submit_agent_plan` 把 `plan` 声明为任意 JSON 对象，模型缺少可依循的嵌套结构。现改为显式 schema：

- 计划必须包含 `schema_version`、`plan_id`、`trace_id`、`goal` 和 1–12 个 `steps`。
- 每一步包含 `step_id`、已注册的 `agent_id` 与 `capability`；依赖和能力输入使用明确字段。
- 设备动作必须放在 `step.action`，格式为 `{ "name": "turn_off", "target_ref": { "device_id": "light.living_room" }, "parameters": {} }`。
- 模型不得提交 `evidence_refs` 或自造证据 ID。插件从当前已登记设备清单和运行时状态中采集证据，再由本地校验器判定可信度和时效。
- 工具 schema 和本地计划验证器是两道不同的边界：schema 约束模型输入形状；本地验证器仍负责设备白名单、能力/动作、安全策略、冲突、证据、确认和执行控制。
- 为 `submit_agent_plan` 增加进程内短期幂等保护：同一 `plan_id`/同一语义计划在校验中或待确认期间复用原结果，不重复建立确认项；语义相同但 `plan_id` 或 `trace_id` 不同的重试也复用同一项。相同 `plan_id` 被改成不同内容时明确拒绝。拒绝、过期或其他终态后释放记录，允许用户重新规划/提交。
- 幂等指纹不包含 `plan_id`、`trace_id` 和运行时补充的证据引用；计划目标、步骤、依赖、动作和参数仍参与指纹比较。该记录只存在当前 Node.js 进程内，不是跨重启的持久化幂等账本。

## Gateway 联调观察

联调使用隔离的 OpenClaw `2026.7.1-2` profile，Gateway 成功加载设备管家插件。设备后端保持 Mock；没有真实 HA 连接。

1. 首次模型输出的计划字段/动作嵌套不符合工具要求，工具安全路径返回 `DENIED`，没有进入冲突评估，也没有设备动作。
2. 模型按工具结构提交同一设备的相互冲突动作后，Node.js 计划工具返回 `CLARIFICATION_REQUIRED` / `PLAN_RESOURCE_CONFLICT`，并要求用户澄清；没有建立批准项，也没有动作。
3. 模拟用户回答“只留关灯”后，模型提交了新计划。新计划进入 `WAITING_FOR_APPROVAL`；测试没有批准它，设备控制工具未被调用。该待确认项按 5 分钟 TTL 失效。

这次联调证明了 Gateway 能调用设备管家工具、冲突被本地策略拦截、澄清后必须提交新计划并等待确认。它不证明真实设备控制、HA 集成或真实家庭环境行为。

Gateway 测试期间模型返回的三次 `usage.total` 分别为 22,512、24,068、25,349。此值可能包含缓存上下文，不等同于实际计费 token 数。

## Schema 更新后的 DeepSeek 复测

使用同一隔离 profile 和同一个设备管家会话，再调用 DeepSeek V4 Flash 两次验证新 schema：

1. 模型按 `steps[].action` 结构提交针对同一客厅灯的 `turn_on` 与 `turn_off` 两步计划；工具返回 `CLARIFICATION_REQUIRED`，指出 `power` 冲突组、`approval_allowed: false`，没有执行设备动作。
2. 测试会话模拟用户澄清“只留关灯”后，模型提交只含 `turn_off` 的新计划；工具返回 `WAITING_FOR_APPROVAL`，`execution_performed: false`。没有调用批准或设备执行工具，Mock 设备状态没有被控制。待确认项按 5 分钟 TTL 自动过期。

本次模型调用元数据确认模型为 `deepseek/deepseek-v4-flash`。这说明该冲突场景下的新 schema 和提示能够引导模型提交合法计划；不代表模型在所有复杂场景都必然正确，也不替代真实 HA 联调。

审计元数据显示：首次冲突提交调用了 `submit_agent_plan` 一次；澄清后的第二轮出现两次 `submit_agent_plan` 调用。两轮都没有 `control_device` 或 `resolve_agent_action_confirmation` 调用。元数据审计不包含每次提交的计划结果，因而无法据此断言第二轮是否短暂创建了重复待确认项。随后对测试会话做只读待确认查询，返回 0 项；先前的待确认项已超过 5 分钟 TTL 自动过期。没有批准或执行任何计划。

## 幂等保护的 Gateway 复测

在隔离 `2026.7.1-2` Gateway 上使用新的设备管家会话和 DeepSeek V4 Flash（thinking off），要求模型将同一个候选计划以完全相同的参数连续调用两次。Gateway 进程加载的 `device-manager` 插件来自本仓库；profile 未设置真实 HA 后端，进程也没有 `DEVICE_MANAGER_BACKEND` 覆盖值，因此按插件默认配置使用 Mock Home Assistant。

- 两次 `submit_agent_plan` 调用均成功返回 `WAITING_FOR_APPROVAL`。
- 第二次返回 `idempotency.deduplicated: true`，两次返回同一个确认项；没有生成第二个待确认项。
- 测试计划随后被明确拒绝以清理队列；最终待确认队列为 0。
- 本轮 `control_device` 调用数为 0；未批准、未执行任何设备动作。

这证明重复工具调用经过当前 Gateway 插件进程时会命中短期幂等保护；不覆盖 Gateway 重启后重试，也不代表真实 HA 设备联调。

## 验证状态

- `agent-plan-tools.test.js`：16 项通过；新增覆盖同 ID 重复、跨 ID 语义重复、并发重复、同 ID 改内容拒绝，以及拒绝/过期后释放。
- 隔离 OpenClaw Gateway + DeepSeek V4 Flash：schema 冲突澄清流程复测通过；幂等复测确认连续两次相同计划调用被合并为一个待确认项。测试项已拒绝清理，队列为 0；没有批准或执行设备动作。
- `npm run verify`：本次幂等改动后重新通过；166 项设备管家测试、11 项验收检查、OpenClaw 插件校验、5 项公共契约测试，以及 17 个有效/4 个预期无效契约样例校验均通过。

## 后续

- 幂等保护已通过单元测试及隔离 Gateway 的真实重复工具调用验证，但目前只在当前进程内有效；若 Gateway 重启，待确认项和幂等记录都会丢失。接真实家庭设备前，后续需设计并验证持久化审批/幂等状态与重启恢复策略。
- 后续若要覆盖更多模型输出变体，可在 API 额度允许时扩展 Gateway 场景；本次仅覆盖“同设备冲突→澄清→单动作新计划”的一个路径。
- 与真实 HA 联调前，仍需具备受控设备、设备白名单、备份和现场确认流程。
