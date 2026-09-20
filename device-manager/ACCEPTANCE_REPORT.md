# 设备管家 Agent 本地验收报告

更新时间：2026-09-19

## 验收结论

当前设备管家 Agent 的本地 Mock 链路通过验收，可以作为其他 Agent 尚未接入时的独立演示和联调基线。
本报告只证明代码、契约和 Mock Home Assistant 的行为正确，不代表真实家庭设备已经接入。

## 自动化结果

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `npm test` | PASS（50/50） | Mock 工具、Task Runtime、编排器、真实 HA REST 适配器和故障场景 |
| `npm run acceptance` | PASS（9/9） | 10 个设备发现、插座控制、传感器读取、场景、开锁拦截、诊断和事件审计 |
| `npm run plugin:validate` | PASS | OpenClaw 插件清单和六个工具定义有效 |
| `node common-contracts\\validate-examples.mjs` | PASS（4/4） | 公共契约 Task/TaskReceipt/Event 示例有效 |
| `npm run verify` | PASS | 上述四项检查的一键入口（含 50 项测试） |

## 已验证功能

- 设备发现：10 个 Mock 设备，包含灯、插座、空调、窗帘、门锁、温湿度、人体、门磁和烟雾传感器。
- 统一设备视图：`canonical_id`、来源实体、可用性、状态快照和能力分离，便于跨 Agent 传递。
- 控制闭环：控制前检查设备和参数，执行后必须回读状态；状态未改变时返回
  `POST_ACTION_VERIFICATION_FAILED`。
- 安全控制：门锁 `unlock` 未带明确确认时返回 `CHALLENGE/CONFIRMATION_REQUIRED`，不调用设备动作。
- 场景：`home`、`sleep`、`away` 执行前完整预检，执行后逐项核对目标状态。
- 任务运行时：兼容旧 `control_device` Task 和 `device_action` canonical Task，支持 PolicyDecision、
  trace_id、幂等键和标准回执。
- 事件和审计：动作成功写入 `action_executed`，动作失败/超时/状态不一致写入 `action_failed`，
  诊断异常写入 `diagnostic_alert`；均可用 `get_device_events` 查询。
- 真实 HA 适配器：已用无网络 fake fetch 验证实体白名单、Bearer 认证、服务映射、回读失败、超时、
  认证失败和场景预检，不包含任何真实令牌。

## 尚未宣称完成的部分

- 尚未接入实验室真实 Home Assistant、MQTT、Matter 或真实家具；需要设备组提供 HA 地址、长期令牌
  和实体 ID 白名单后才能联调。
- 事件账本目前是进程内存实现，进程重启后清空；后续可替换成统一日志或消息队列存储。
- `common-contracts` 仍是 v0.1 讨论稿，正式字段需和其他小组确认后冻结 v1。
- 学习行为模型输出只能作为事件或建议，不能在准确率和误报率未达标前直接触发高风险设备控制。

## 建议的跨组联调顺序

1. 用协议组提供的地址、令牌和实体白名单运行只读 `npm run ha:check`。
2. 只接入灯或插座，验证“Task → PolicyDecision → ResourceStatus → 设备管家 → 状态回读 → Event”。
3. 通过 `get_device_events` 和 HA 日志比对 `trace_id`、动作结果和真实状态。
4. 最后再接入窗帘、空调等设备；门锁只在人工确认链路完整后联调。
