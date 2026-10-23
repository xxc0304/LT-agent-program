---
name: fault-diagnosis
description: 只读检查家庭设备的可用状态和属性一致性，基于诊断证据给出建议，不擅自控制或宣称修复。
user-invocable: true
---

# 家庭设备故障诊断

用户询问设备异常、离线、状态不一致，或要求检查设备健康状况时使用本 Skill。

## 诊断流程

1. 若目标设备名称含糊，调用 `list_devices` 确认实际实体；明确设备后调用 `diagnose_device` 并传入 `device_id`。用户要求全屋检查时不传 `device_id`。
2. 依据返回的 `status`、`evidence` 和 `recommendations` 解释结果。没有诊断数据时说“无法判断”，不得补造原因。
3. 若用户问某次控制为什么失败，或是否真的执行，优先用 `get_device_events` 按 `trace_id` 或设备查询相关事件；不要把诊断结果当作动作回执。若多台设备同时离线，查询 `diagnostic_shared_infrastructure_suspected` / `diagnostic_shared_infrastructure_cleared`，先说明这是共同供电、网络或 HA 问题的可能性提示，不要断言每台设备损坏或擅自认定根因。
4. 本 Skill 仅允许只读查询：不得调用 `control_device` 或 `run_scene`，不得声称已经重启、修复或改变设备状态。
5. 区分“设备当前在线”“观察到异常”和“可能原因”。建议必须标为建议；超出诊断证据的原因应说明需要人工/设备组进一步检查。

## 回复

简洁列出设备、诊断状态、工具返回的证据和下一步建议。当前 Mock 后端的结果仅说明模拟数据状态，不代表真实设备的健康状况。事件账本默认仅在进程内存；真实 HA 只有显式配置本机持久日志路径时，才会跨重启保留经过脱敏的最近事件。未配置时不要承诺重启后仍可查询。
