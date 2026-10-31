# 家庭设备发现与登记 MVP v0.2

## 目标与范围

本模块把 Home Assistant 当前暴露的实体整理为家庭设备登记清单，供设备管家和能源管家共用。发现过程只读；新实体默认 `pending_review`，不自动获得设备控制权限或节能权限。真实 HA 后端可通过 WebSocket 读取 Device/Entity/Area Registry，将多个实体按 HA `device_id` 分组，并补充区域、厂商和型号信息。

当前阶段的发现来源是设备管家已有的 `list_devices`，真实 HA 后端通过 REST `/api/states` 读取实体状态，再尝试通过 WebSocket `/api/websocket` 读取三个 Registry。能力识别使用 HA 实体当前暴露的 `supported_color_modes`、`supported_features`、温度范围等属性；可证实不支持的动作不会下发，证据不足时标记为未知，不把未知等同于不支持。它不会扫描局域网，也不能发现尚未配网或尚未接入 HA 的设备。WebSocket 注册表不可用时，清单回退到 REST 实体信息，并在 `registry_enrichment.status` 标明 `unavailable`；已有房间/设备元数据保留，不将回退结果伪装成完整 Registry 扫描。HA 的房间名称只是待核对建议，不从实体 ID 猜测，也不自动视为用户确认。

## OpenClaw 工具

1. `discover_household_devices`：重新读取 HA 实体及可用的 Registry 信息并与本地清单对账；只读。结果同时包含按 HA 物理设备分组的 `physical_devices`。
2. `list_household_device_inventory`：查看实体名称、HA 房间建议、用户确认房间、物理设备分组、登记状态、在线情况和节能授权。
3. `review_household_device`：根据用户明确提供的信息登记/排除实体，记录理由，可设置名称、明确核对的房间和 `energy_opt_in`。

节能授权要求：实体登记为 `approved`、类型属于灯/开关/空调、房间已经由用户明确核对（通过登记时传入 `area_id`），并由用户明确选择 `energy_opt_in=true`。HA Registry 导入的 `area_name`/`ha_area_id` 只是建议；即使该房间存在，也不能跳过用户核对。窗帘、门锁、传感器不纳入当前节能动作。所有新实体默认 `energy_opt_in=false`。

设备控制入口在执行前重新扫描 HA，并要求该实体当前存在且登记为可控/已批准；未登记设备返回 `DEVICE_APPROVAL_REQUIRED`。能源管家只获取清单中已批准并显式开启节能授权的设备；仍由原节能规则决定是否产生任务，再由设备管家执行、回读和审计。

## 本地存储

仅保存登记所需元数据：HA `entity_id`、HA 物理设备 ID、HA Entity unique ID、HA 区域 ID/名称建议、设备名称/厂商/型号、用户覆盖名、用户确认的房间、审批状态、节能授权、首次/最近发现时间、审核理由。**不保存 HA Token、实时设备状态、家庭摄像头图像/视频。**

默认路径：

- `DEVICE_MANAGER_INVENTORY_PATH` 设置时，使用该完整路径；
- 否则使用 `$OPENCLAW_STATE_DIR/device-manager/device-inventory.json`；
- 若未设置 `OPENCLAW_STATE_DIR`，使用用户主目录下 `.openclaw/device-manager/device-inventory.json`。

状态由 HA 实时提供；文件只负责跨重启保留命名、房间和审批等登记信息。扫描时若成功读取但实体已消失，系统撤销该实体控制/节能许可并要求重新核对；HA 请求失败时不修改原清单。

## 验收

```powershell
Set-Location device-manager
npm test
```

MVP 验收覆盖：扫描新增实体、默认待核对、无房间拒绝节能授权、门锁不能纳入节能、授权后的设备筛选、清单跨进程重载、实体消失后撤销授权，以及能源管家只生成已授权实体的任务。

## 当前限制与下一步

- 每个 HA entity 暂按一条登记/授权记录处理；HA Device Registry 分组仅用于展示和对账，不把同一设备多个实体的权限自动合并。
- HA WebSocket Registry 查询已实现并通过 Fake WebSocket 自动化测试，但尚未连到真实 HA 实机验证权限、反向代理路径、区域映射和多家庭隔离。房间导入仅是建议，必须由用户核对。
- `list_devices` 会枚举 HA 暴露的支持实体；`HA_ENTITY_ALLOWLIST` 仍可进一步限定实体范围。
- 当前是 Agent 组本地 MVP；HA 实体能力映射已有自动化测试，但仍需真实 HA 联调确认不同集成提供的属性一致性；多家庭隔离、WebSocket 重连/增量同步仍未实现。

