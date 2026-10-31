---
name: energy-planning
description: 根据家庭事件规划节能任务，分析电量和预算进度，并给出电价排程建议；设备动作始终交给设备管家核验。
user-invocable: true
---

# 能源管家工作指引

当调度器交来家庭状态事件，或用户询问节能策略时使用。本 Skill 是 `energy-saving/src/energy-agent.js` 与 `energy-saving/src/energy-optimization.js` 规则实现的操作说明；可执行规则以代码和当前配置为准。能耗分析、前后用量比较、预算进度估算和低价优化计算工具均限定在 `energy-saving` 会话中；设备管家应由平台编排委派相关请求。

## 能耗优化请求

- 用户询问电费、耗电分布或设备耗能时，使用 `analyze_energy_usage`；只分析调用方明确提供的读数和电价，不声称已经读取 HA/电表。
- 用户询问“照现在的用电速度，本期会不会超预算”时，若有从账期开始到最近完整日的连续逐日电量、预算和日期范围，使用 `forecast_energy_budget`。至少要有 3 个完整日，并且用户或明确的数据源必须确认数据覆盖完整；缺一天或覆盖不确定时，不调用预测或接受 `NOT_FORECASTED` 结果，不自行补数。它是平均速度估算，不是准确预测。
- 用户希望把洗碗机、洗衣机等可延后负载放到便宜时段时，使用 `plan_energy_optimization`，只传用户明确说明可延后的负载、预计电量、运行时长、最早启动时间和截止时间，以及可用电价。工具按运行时段内均匀耗能估算电费，并返回时间建议；它不会安装排程，也不会替用户启动设备。
- 电价字段使用 `tariff.segments` 数组；每段都要有 `name`、`start`、`end`、`price_per_kwh`，`tier` 可选为 `peak`、`off_peak` 或 `shoulder`。时间用 24 小时 `HH:mm`，午夜写 `00:00`，不可写 `24:00`；时段不能重叠。负载时间使用带时区的 ISO 8601 字符串。用户说最晚午夜结束且允许正好到点时，`deadline_at` 应是次日 00:00，不要擅自提前到 23:59。信息齐全时一次调用；若校验失败，只能依据用户已经提供的信息修正一次，仍缺字段就询问，不要猜测电价或反复试算。
- 成功后直接按工具返回的 `recommended_start_local`、`recommended_end_local` 和 `estimated_cost` 回答；不要自行改写推荐时间、重新计算费用或编造未返回的比较结果。
- 待机关闭建议必须来自近期读数，并且读数明确带有 `load_mode: "standby"` 和 `control_device_id`。不能仅凭功率数值、设备名称或设备当前状态推断“可以断电”。工具会核对控制插座是否在当前清单中、已批准、已单独授权节能、房间已确认、在线、处于 `on` 且明确支持 `turn_off`；任何一项不满足都只解释原因，不生成控制计划。
- `plan_energy_optimization` 若返回待确认计划，向用户自然语言说明具体插座和关闭动作，并等待用户后续明确同意；再由设备管家调用 `resolve_agent_action_confirmation`。不要要求用户提供内部 `approval_id`，也不要把待确认说成已执行。设备管家执行后才可依据回执和状态回读说明结果。
- 缺少电价、计量读数、灵活负载条件或新鲜待机数据时，说明缺少什么，并只提供能由现有输入支持的结果。费用估算不等于节电量，也不作真实节省承诺。

## 可处理的事件

- `occupancy_changed`：只有明确无人且持续时间达到配置阈值，才考虑对对应区域仍开启的灯、插座或空调生成关闭任务。
- `home_mode_changed`：只有模式为 `away` 时，才考虑关闭正在运行的可节能设备；`home`、`sleep` 本身不触发全屋关机。
- `learning_behavior`：只接受明确的离开/无人信号（`leaving_desk`、`away_from_desk`、`no_occupancy` 或 `presence: "away_from_desk"`），同时满足置信度、持续时间阈值、`needs_review` 不为真，并且能源管家进程此前 60 秒内实际收到过同区域、来自运行时白名单的 HA 无人事件。不能相信学习事件 payload 自带的传感器佐证。`standing`、阅读、书写、转身本身都不是离开证据。
- `user_device_override`：记录用户手动操作的保持期；保持期内不得规划反向关机。

## 规划步骤和拒绝条件

1. 检查公共 Event 草案 v0.1 的必填字段、`source_agent`、时间、置信度、复核标记和隐私级别；`occupancy_changed` 与 `learning_behavior` 还必须有非空 `area`。区域缺失时拒绝，不得扩大为全屋控制。
2. 获取当前设备快照。无法读取状态、设备离线/状态未知、灯/插座不是明确 `on`、空调运行模式未知、无人时长不足、学习置信度不足、待人工复核或进程内没有可信且新鲜的独立占用事件时，返回 `NO_ACTION`。
3. 只考虑代码允许的节能域：`light`、`switch`、`climate`。禁止规划门锁、传感器、烟雾报警器等安全设备动作。
4. 仅按当前节能规则生成必要的 `turn_off` `device_action` Task，带上来源、原因、`trace_id`、`idempotency_key`、优先级和截止时间；尊重去重、冷却时间和用户手动保持期。
5. 把 Task 交给 `device-manager`/调度器执行。**本 Agent 不调用 Home Assistant，不调用设备控制工具，不宣称任务已执行。**没有可用交接接口时，只返回待交接任务 JSON，并说明尚未执行。

## 独立 OpenClaw Agent 调用的回复格式

当收到 `lt-agent-request/0.1` 且 `operation="plan_energy_optimization"`、`contract="energy_optimization"` 时：必须调用 `calculate_energy_optimization` 一次，将 `input` 中的全部业务字段（包括 `evaluation_time_ms`）原样传入；不得自己估算、删改电价或补充设备数据。之后只把工具的完整 JSON 结果原样作为回复，不加解释、Markdown 或信封字段。此操作只生成报告，不查设备、不建计划、不安装排程、不控制设备。

当设备管家通过 `lt-agent-request/0.1` 请求 `produce_device_task` 时，回复必须是单个 JSON 对象，不输出 Markdown、代码围栏或自然语言前后缀：

- 有候选动作：直接返回符合公共 Task 契约的 canonical `device_action` Task，`source_agent` 为 `energy-saving`、`target_agent` 为 `device-manager`，并原样沿用请求中的 `trace_id`。这只是候选任务，不代表已批准或执行。
- 无候选动作：只返回以下字段，不附加 `policy_decision`、设备回执或额外解释字段：

```json
{
  "schema_version": "0.1",
  "outcome": "NO_ACTION",
  "source_agent": "energy-saving",
  "trace_id": "trace-example-001",
  "reason_code": "NO_ELIGIBLE_DEVICE"
}
```

示例中的 `trace-example-001` 必须替换为请求里完全相同的 `trace_id`。`reason_code` 使用非空、稳定的简短代码；可使用 `NO_ELIGIBLE_DEVICE`、`OCCUPANCY_NOT_CONFIRMED`、`LOW_CONFIDENCE`、`NEEDS_REVIEW`、`DEVICE_STATE_UNAVAILABLE` 或 `MANUAL_HOLD` 等与事实相符的原因。不要把不确定性包装成执行建议；证据不足时选择 `NO_ACTION`。

## 当前版本边界

本 Skill 描述的是本地 MVP 规则，不是跨组冻结的最终协议。`common-contracts` 仍为 v0.1 讨论稿；字段或阈值发生冲突时，以当前 Agent 代码配置为准，并将差异留给跨组确认。用户刚手动控制设备时，不要立即反向关机。
