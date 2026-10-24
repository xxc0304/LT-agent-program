---
name: device-status
description: 查询家庭设备、传感器和在线状态，并用证据说明当前状态。只读，不执行控制动作。
user-invocable: true
---

# 全屋设备状态查询

用于回答“家里有哪些设备”“客厅温度是多少”“有没有人”“门磁是否触发”“设备是否在线”等只读问题。

## 工作流程

1. 用户询问新家庭有哪些设备，或本地登记清单为空/需要刷新时，调用 `discover_household_devices`，再调用 `list_household_device_inventory` 查看待核对登记。
2. 对已登记实体用 `list_devices` 确认 HA 当前实体 ID，必要时按 `domain` 过滤；房间未登记时应说明未知，不得从 ID 猜房间。
3. 再调用 `get_state` 读取目标设备的最新状态和属性。
4. 对多个设备逐个读取，不要根据历史对话猜测当前状态。
5. 回复设备名称、状态、关键属性、是否在线，并明确当前是 Mock HA 模拟数据。

## 设备类型

- `light`：灯光和亮度；
- `climate`：空调和温度设定；
- `cover`：窗帘和开合度；
- `lock`：门锁状态；
- `sensor`：温度、湿度等数值传感器；
- `binary_sensor`：人体、门磁、烟雾等开/关状态传感器。

## 安全边界

- 本 Skill 只查询，不调用 `control_device` 或 `run_scene`。
- 发现设备离线或状态异常时，说明证据并建议调用 `diagnose_device`；不得声称已经修复。
- 如果用户问最近的控制是否真正执行或设备故障是否恢复，可改用 `get_device_events` 查询 `action_executed`、`diagnostic_alert`、`diagnostic_transient`、`diagnostic_recovered`、`diagnostic_tracking_ended`、`diagnostic_shared_infrastructure_suspected` 或 `diagnostic_shared_infrastructure_cleared` 事件；监测中的短时离线会先待复查，宽限期内恢复只记 `diagnostic_transient`、不算故障告警；多台同时离线的共同基础设施事件只是可能性提示，不代表已确认断电、网络或 HA 根因；正式恢复事件仅表示监测重新观测到健康状态；跟踪结束事件表示实体已从 HA 清单消失，不能推断设备已修复。`off` 是设备正常状态，不要报离线。事件账本默认是进程内存；只有真实 HA 且明确配置本机持久日志时才可跨重启查询脱敏事件。
- 不要把“有人”“烟雾触发”等状态直接解释为入侵、火灾或医疗结论；需要由安全守护或其他专门 Agent 进一步判断。
