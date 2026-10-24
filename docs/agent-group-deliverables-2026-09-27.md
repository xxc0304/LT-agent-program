# Agent 组 9 月 27 日到期交付对照（工作稿）

更新时间：2026-09-27  
依据：飞书《家庭智能中枢项目｜任务拆解、技术架构与 30 天执行计划》及当前本地仓库。  
状态说明：代码实现、Mock 验收和跨组签字是不同状态；本文件不代替其他小组对契约的确认。

## 截止日任务

| ID | 计划交付 | 当前证据 | 判断 / 尚需动作 |
| --- | --- | --- | --- |
| A-01 | 设备管家、安防 Agent 边界及 Event/Task 初版 | 设备管家边界、Event/Task 草案和本文件的安防看护边界已具备 | 本地初版已补齐；等待协议组、安全组确认后才能称“冻结” |
| A-02 | OpenClaw 测试环境、基础状态/消息接口 | 设备管家已由 OpenClaw CLI/Gateway 调用；插件校验和 Mock 接口验收记录见 `device-manager/ACCEPTANCE_REPORT.md` | 当前实现达到本地测试目的；需把版本/运行步骤/证据回填甘特进展表。学习伴学、节能模板是否需作为独立 OpenClaw Agent 注册，仍应按组内部署约定确认 |
| A-03 | 正常、异常、缺字段样例及一个可重复任务 | `common-contracts/examples/` 有正常设备、Task、Event、回执及安全/学习事件；`examples/invalid/` 有缺字段拒绝样例；调度器有可重复 Mock 演示和异常测试 | 本地可验收；演示仍是 Mock，不是跨组真实服务联调 |
| A-06 | 门磁、人体、门锁、陌生人、疑似跌倒事件与 Skill | `openclaw-agents/security-watch/` 和对应 Event 样例 | 已形成工作稿；安防负责人/安全组需确认名称、严重级别、数据等级、确认/通知及策略边界 |
| A-12 | 儿童学习 Agent 负责人、候选范围、Event/Task 样例 | 学习伴学模板、学习行为 Event、显式开始 Session Event、台灯提醒候选 Task 及下文范围提案 | 候选范围和样例已补；正式负责人、AI 台灯能力及行为事件口径仍须团队确认 |
| M2 | Device/Event/Task 示例可校验 | Device、legacy Task、canonical `device_action` Task、Event 与回执样例；验证器也会检查预期应拒绝的缺字段样例 | 本地样例验证已补；Device 与 UDM 映射、数据分级和枚举仍待跨组确认 |

## Agent 边界提案

```text
结构化感知 Event
  ├─ learning-companion：识别/整理学习观察，只产出 Event
  ├─ security-watch：核验安全 Event，输出复核或候选处置，不直接控制
  └─ energy-saving：按明确规则把 Event 转成节能 Task
           ↓
multi-agent-orchestrator：路由、排序、幂等、超时/重试和 trace
           ↓
device-manager：策略检查、执行设备工具、回读状态、生成审计回执
```

任何 Agent 都不能把待复核或未知事件升级成事实；安全策略拒绝/挑战时不得绕过；原始媒体不进入跨 Agent Event。现有 `multi-agent-orchestrator` 是进程内 Mock 调度器，不等于独立 OpenClaw Agent 间的远程消息服务。

## 儿童学习伴学 Agent 候选范围（A-12 提案）

**候选 MVP：**

1. 在用户/照护者明确开始后建立学习 Session，并接收授权来源的结构化观察；
2. 产生带来源、时间、置信度和复核标记的 `learning_behavior` Event；
3. 仅把已经确认的低风险提醒或台灯调光候选 Task 交给调度器/设备管家；
4. Session 结束后生成简短学习过程摘要，不保存原始儿童图像或不必要身份信息。

**当前限制：**SCB 课堂试验是课堂整体标签，不代表目标儿童身份或在位状态；单帧不能证明持续时间。当前视觉接口测试不训练模型，低置信度/待复核结果不得触发节能或设备控制。AI 台灯的设备能力、状态、事件来源和控制 API 尚待提供。

契约样例 `study-session-started-event.json` 仅由用户明确操作启动；`study-lamp-reminder-task.json` 是供接口讨论的候选动作，标有 `example_only` 和 `execution_requires_user_authorization`，不得直接拿去控制真实台灯。

**责任人：**甘特图目前只列出 A-12 的三位参与者，没有给出明确单一负责人。建议由组内指定接口负责人；此工作稿由肖欣辰整理，不代表团队已经正式任命。

## 契约中需跨组拍板的差异

- **设备描述：**当前 `Device` 是设备管家统一视图（`device_id/name/domain/state/available/attributes`）；协议组 UDM 草案还包含 vendor、location、properties、events、services、constraints、securityLevel、version。需形成显式映射，不要把两套字段当成已一致。
- **Task 任务类型：**现有实现同时有旧设备管家 Task（`control_device` 等）和节能输出的 canonical `device_action`；Task Schema 已加入两个分支的本地兼容草案。
- **优先级：**旧任务用 `low/normal/high/critical`，canonical 调度器用 `P0`–`P4`；草案暂时兼容两者，需由各组确定唯一公共枚举和映射。
- **状态语义：**Task 生命周期状态（`CREATED/READY/RUNNING/SUCCEEDED/FAILED/CANCELLED`）与 TaskReceipt 执行结果（另含 `CHALLENGE/TIMEOUT/RETRYABLE`）是两类字段，不能混为同一个状态机。
- **数据级别：**飞书方案写 L1–L4，当前代码草案写 L0–L3。映射未确认前，示例里的 L0–L3 只代表本地草案值，不是最终安全分类。
- **策略/资源接口：**`PolicyDecision` 由安全组确认；`ResourceStatus` 和调度结果由云边端组确认。当前演示中的对应方由 Mock 代替。

## 本地复现

从项目根目录：

```powershell
node common-contracts/validate-examples.mjs
Set-Location multi-agent-orchestrator
npm test
npm run demo
Set-Location ../device-manager
npm run verify
```

预期：契约验证报告有效示例通过并拒绝缺字段样例；多 Agent Demo 在 Mock HA 上重复运行并显示学习事件→节能 Task→设备管家回读；设备管家 verify 的测试/验收/插件校验通过。以上结果不得表述为真实设备联调或正式节能率。

## 依赖与下一节点

- **协议组：**确认 UDM/Device 字段映射、HA 地址和实体白名单、首台插座真实控制/回读接口。
- **安全组：**确认 L1–L4 数据级别、PolicyDecision、挑战确认通道和审计字段。
- **云边端组：**确认 ResourceStatus 和调度结果接口。
- **台灯/场景团队：**提供学习区台灯能力、状态、事件和命令接口。
- 9/28 后按 A-05 开始模拟接口的超时/缺字段/错误回执联动；安全链路对应 A-07。真实设备及三场景最终演示在后续计划节点进行。
