# Mock 条件反馈与重新规划闭环

## 目标

在暂时无法接入真实 Home Assistant 的阶段，验证多 Agent/设备写计划遇到互斥动作时，不会盲目执行；系统会给出具体冲突信息和追问。用户澄清后，规划方必须提交一份新计划，重新经过能力、设备、证据和风险校验。新计划仍按现行策略等待明确确认，执行后再通过 Mock 状态回读验证。

## 当前实现

- `device-manager/src/agent-plan-tools.js` 在冲突反馈中附上具体设备名称、互斥动作和建议追问，明确当前计划不可批准、未执行；OpenClaw 可据此向用户自然语言解释。
- 用户选择后，OpenClaw/规划方重新提交新候选计划。系统不会自动从旧计划删步骤，也不把原计划的确认沿用给新计划。
- 新计划单独校验并展示；多步骤/候选计划仍需后续明确确认。确认后刷新设备状态/证据，再执行，并回读 Mock 状态。
- `device-manager/src/mock-replan-demo.js` 使用固定对话样例演示完整闭环。它经过设备管家计划工具边界，但不调用实际 OpenClaw Gateway 或 LLM。

## 运行

在项目根目录 PowerShell 中执行：

```powershell
cd .\device-manager
npm run demo:mock-replan
```

通过条件：初始冲突计划为 `CLARIFICATION_REQUIRED` 且未执行；澄清后的新计划变为 `WAITING_FOR_APPROVAL`；模拟明确确认后仅关闭客厅灯；最终 Mock 状态为 `off`，审计记录 `verified: true`。

## 自动化测试

```powershell
node --test test/agent-plan-tools.test.js test/mock-replan-demo.test.js test/mock-memory-learning-demo.test.js
```

测试还验证冲突回执提供“客厅灯”名称及两个动作，且确认不能绕过冲突门禁。

## 证据边界

演示中的用户语句是固定测试输入；澄清后“只保留关灯”是代码构造的新候选计划。此演示验证的是 Node.js 校验、工具工作流和 Mock 状态回读，不是 DeepSeek/OpenClaw 自然语言理解能力的实测，也不证明真实 HA、传感器或家电已接入。真实 Gateway 模型对话与 HA 事件联调仍需在对应运行环境中单独验证。
