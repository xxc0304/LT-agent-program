---
name: safety-event-triage
description: 对门磁、人体移动、门锁状态、陌生人疑似和跌倒疑似等结构化家庭安全事件进行范围核验、风险分级和保守分诊。
---

# 安全事件分诊

## 输入要求

只处理符合项目 Event v0.1 的结构化对象。先检查 `event_id`、`event_type`、`occurred_at`、`source`、`trace_id`、`privacy_level`、`data_level` 和 `payload`。缺字段、来源未知、事件过期、重复 `dedup_key` 或时间/置信度不合法时，返回拒绝或人工复核，不生成设备动作。

## 事件处理边界

- `door_contact_changed`、`motion_detected`、`door_lock_state_changed`：描述传感器或设备报告的状态，不推断具体人员身份或动机。
- `stranger_suspected`：仅代表模型疑似；保留 `needs_review=true`，不得称作“已确认陌生人/入侵”。
- `fall_suspected`：仅代表疑似跌倒；先按项目确认的流程触发人工复核/关怀确认。不得清除告警或未经策略授权联动高风险设备。
- 模型事件若置信度不足、缺少时间/区域或标记待复核，只能输出复核结果，不生成自动控制任务。

## 执行边界

1. 记录并沿用输入 `trace_id`；按 `event_id`/`dedup_key` 去重。
2. 检查调用权限和策略结果。`DENY` 不执行；`CHALLENGE` 必须等待用户通过正式确认通道完成确认；只有 `ALLOW` 才可将低风险、明确的 Task 交给调度器。
3. 本 Agent 不直接调用 Home Assistant。设备管家负责工具调用、控制后状态回读和审计。
4. 门锁、燃气、告警解除、医疗相关联动不得仅凭模型事件自动执行。
5. Event 中不包含原始照片、视频、音频、API Key、姓名或其他不必要身份信息；确需证据时仅保留本地受控引用，并等待数据安全组确认相应字段和保留规则。

## 输出

输出应包含事件 ID、trace ID、采用的证据、风险判断、是否需人工复核、是否生成候选 Task 及其原因。无法确认时明确输出 `unknown`/`needs_review`，不得补猜缺失信息。

本 Skill 是 A-06 工作稿。通知联系人、跌倒确认交互、策略权限及数据分级须由对应小组确认后，才能用于 A-07/A-08 实际联调。
