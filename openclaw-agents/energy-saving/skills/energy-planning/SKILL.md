---
name: energy-planning
description: 根据可信的家庭占用、模式或学习行为事件规划低风险节能任务；只生成计划交给设备管家，不直接控制设备。
user-invocable: true
---

# 节能任务规划

当调度器交来家庭状态事件，或用户询问节能策略时使用。本 Skill 是 `energy-saving/src/energy-agent.js` 规则实现的操作说明；可执行规则以代码和当前配置为准。

## 可处理的事件

- `occupancy_changed`：只有明确无人且持续时间达到配置阈值，才考虑对对应区域仍开启的灯、插座或空调生成关闭任务。
- `home_mode_changed`：只有模式为 `away` 时，才考虑关闭正在运行的可节能设备；`home`、`sleep` 本身不触发全屋关机。
- `learning_behavior`：只接受明确的离开/无人信号（`leaving_desk`、`away_from_desk`、`no_occupancy` 或 `presence: "away_from_desk"`），同时满足置信度、持续时间阈值、`needs_review` 不为真，并且节能 Agent 进程此前 60 秒内实际收到过同区域、来自运行时白名单的 HA 无人事件。不能相信学习事件 payload 自带的传感器佐证。`standing`、阅读、书写、转身本身都不是离开证据。
- `user_device_override`：记录用户手动操作的保持期；保持期内不得规划反向关机。

## 规划步骤和拒绝条件

1. 检查公共 Event 草案 v0.1 的必填字段、`source_agent`、时间、置信度、复核标记和隐私级别；`occupancy_changed` 与 `learning_behavior` 还必须有非空 `area`。区域缺失时拒绝，不得扩大为全屋控制。
2. 获取当前设备快照。无法读取状态、设备离线/状态未知、灯/插座不是明确 `on`、空调运行模式未知、无人时长不足、学习置信度不足、待人工复核或进程内没有可信且新鲜的独立占用事件时，返回 `NO_ACTION`。
3. 只考虑代码允许的节能域：`light`、`switch`、`climate`。禁止规划门锁、传感器、烟雾报警器等安全设备动作。
4. 仅按当前节能规则生成必要的 `turn_off` `device_action` Task，带上来源、原因、`trace_id`、`idempotency_key`、优先级和截止时间；尊重去重、冷却时间和用户手动保持期。
5. 把 Task 交给 `device-manager`/调度器执行。**本 Agent 不调用 Home Assistant，不调用设备控制工具，不宣称任务已执行。**没有可用交接接口时，只返回待交接任务 JSON，并说明尚未执行。

## 当前版本边界

本 Skill 描述的是本地 MVP 规则，不是跨组冻结的最终协议。`common-contracts` 仍为 v0.1 讨论稿；字段或阈值发生冲突时，以当前 Agent 代码配置为准，并将差异留给跨组确认。用户刚手动控制设备时，不要立即反向关机。
