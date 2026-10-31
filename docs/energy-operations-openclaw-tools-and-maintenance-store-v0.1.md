# 能耗分析与设备维护 OpenClaw 工具接入 v0.1

## 目标

将能源管家已有的本地分析能力和设备管家已有的维护计划逻辑注册为 OpenClaw 可调用工具，并使维护周期在 Gateway 重启后保留。本阶段仍是本地/Mock 工具链，不连接真实 HA、电表或家电。

## 新增 OpenClaw 工具

| 工具 | 输入 | 结果与边界 |
| --- | --- | --- |
| `plan_energy_optimization` | 调用方提供的分时电量和电价；可选的用户明确可延后负载；可选待机读数和对应控制插座 ID | 设备管家经 OpenClaw 适配器委派独立 `energy-saving` Agent；能源管家使用受限的 `calculate_energy_optimization` 确定性工具，适配器逐字段核对报告后交给设备管家。待机候选还要重新核对登记/授权/状态/能力，再交给标准计划工作流待用户确认；不会自动安装排程或控制设备 |
| `analyze_energy_usage` | 调用方提供的区间电量读数，可选电价、预算、时区 | 仅能源管家会话可调用；返回总量、设备/区域/时段画像、显式证据异常候选、成本预算与人工建议；不查电表、不创建设备任务 |
| `forecast_energy_budget` | 账期预算和日期，以及从账期开始到最近完整日连续无缺漏的逐日 kWh；至少 3 个完整日，调用方必须明确声明覆盖完整。每日项使用 `date` 和 `energy_kwh` | 仅能源管家会话可调用；主对话编排器先校验结构化数据和完整性声明，条件不足时澄清且零 Agent 派发；会把常见的 `kwh` 字段归一为工具需要的 `energy_kwh`；工具自身仍会对缺天或未确认完整的数据返回 `NOT_FORECASTED`；不查电表、不创建任务、不控制设备 |
| `evaluate_energy_effect` | 指定设备集合、采样间隔及前后两个窗口 | 仅能源管家会话可调用；窗口等长、读数完整且对齐时报告观察差值；不证明因果节能 |
| `save_maintenance_schedule` | 设备 ID、维护类型、下次日期或周期，可选使用量阈值 | 新建或更新本地维护日程；不读取设备、不执行维修 |
| `get_device_maintenance_plan` | 可选诊断快照、评估时刻和完成历史分页参数 | 返回逾期/到期/近期/资料缺失计划及只读排查建议，并按页返回本地完成历史；没有调用真实 HA |
| `record_device_maintenance_completed` | `schedule_id`、可选完成时间、`user_confirmed: true` | 仅记录用户明确报告已完成的实体维护；更新周期并清零已存在的使用计数；不执行维护或设备复位 |

工具实现位于 `device-manager/src/energy-operations-tools.js`，由 `device-manager/src/openclaw-plugin.js` 注册，并在运行时将只读能耗分析、前后用量比较、预算进度估算与内部优化计算限定给 `energy-saving` 会话。Windows 与 Linux 安装器只向能源管家授予这些工具；设备管家保留 `plan_energy_optimization` 委派入口，并继续负责任何设备计划的校验、用户确认、设备控制和状态回读。节能业务逻辑复用 `energy-saving/src/energy-agent.js`、`energy-saving/src/energy-budget-forecast.js` 与 `energy-saving/src/energy-optimization.js`；维护计划复用 `device-manager/src/maintenance-planner.js`，没有再引入新的调度框架。

预算估算使用线性日均速度，不构成统计预测或节能效果证明。其完整数据声明由调用方提供，能源管家只能验证日期连续和样本数，无法独立核验计量来源是否漏报。本功能已通过本地回归（能源管家 52/52、OpenClaw 能耗工具 7/7、部署安装器 13/13）和隔离 OpenClaw Gateway 主对话运行验收：`dev` 会话调用 `orchestrate_household_agents`，编排记录一个 `energy-saving` Agent 步骤；该 Agent 会话实际调用 `forecast_energy_budget`。Trace ID 为 `budget-forecast-frontdoor-20261025`。以 2026-10-01 至 10-03 每日 2、3、4 kWh、100 kWh 月预算为例，工具回报账期内（10 月 1 日至 31 日）估算约 93 kWh、预计余量约 7 kWh，状态为 `PACE_WITHIN_BUDGET`。这验证了主对话经编排到能源管家的调用链，不代表真实电表数据已接入。

`plan_energy_optimization` 的低谷窗口以 15 分钟为候选起点，在用户提供的时间窗内查找电价最低的可运行窗口。能源管家调用只对其会话开放的 `calculate_energy_optimization` 生成原始报告；适配器按固定的 `evaluation_time_ms` 重算并逐字段比对，任何差异都拒绝下游使用。费用差额假设负载在运行时段内均匀耗能，只是电价变化下的估算，不是减少了相同数量的 kWh。待机候选要求测量读数显式提供 `load_mode: "standby"`、`control_device_id` 和带时区的近期 `recorded_at`；功率阈值默认 5 W。该标签本身仍不能证明断电安全，因此设备管家只会把已登记、已授权、房间已确认、在线、当前为 `on` 且明确支持 `turn_off` 的开关/插座送入待确认计划。低谷负载排程目前只返回建议，不持久化或执行定时器。

本地 Mock 演示入口：`npm --prefix energy-saving run demo:optimization`。它使用临时设备清单、合成数据和脚本专用确认信号，输出 `tmp/energy-operations/optimization-demo-<id>.json`；确认信号只用于展现完整 Mock 流程，不等同于实际用户确认。

## 本地持久化

维护计划和完成记录保存在 JSON 文件：

```text
<OPENCLAW_STATE_DIR>/device-manager/maintenance-schedules.json
```

如果 OpenClaw 没有设置 `OPENCLAW_STATE_DIR`，默认目录为当前用户的 `~/.openclaw/device-manager/maintenance-schedules.json`（Windows 常见位置为 `C:\Users\<用户名>\.openclaw\device-manager\maintenance-schedules.json`）。可用 `DEVICE_MANAGER_MAINTENANCE_SCHEDULE_PATH` 单独覆写文件路径。工具响应不返回本地绝对路径。

文件只保存结构化维护日程和完成记录，不保存对话原文、API Key、HA 凭据、传感器历史或设备控制命令。插件实例内会串行化读写；计划列表、完成历史、计划变更和完成登记都争用同路径的 `.lock` 文件，避免并发读到 Windows 备份复制中的半成品，也避免多进程读改写互相覆盖。锁冲突时默认最多等待 1000ms，并每 25ms 重试获取锁；`MaintenanceScheduleStore` 可通过 `lockWaitMs` 参数设置 0–5000ms。等待超时后返回/抛出 `MAINTENANCE_STORE_LOCKED` 并失败关闭。多写进程同时竞争时由独占锁逐一串行完成，临时锁释放后不会覆盖彼此新增的维护计划（此行为已通过 4 个独立 Node 进程的并发测试验证）。系统不会自动删除已有锁；若进程异常退出遗留锁，需要维护人员核对后手动处理。`get_device_maintenance_plan` 使用一次 `readSnapshot()` 在同一锁内读取计划和完成历史，避免两个列表来自不同时间点。文件优先用临时文件重命名替换，在 Windows `EPERM`/`EEXIST` 场景回退为备份、复制与恢复流程，这一回退不是严格原子替换。文件不存在时按空存储处理；JSON 损坏、结构不合法或 schema 版本未知时会停止写入，不自动覆盖/迁移。

### 只读锁状态诊断

维护写入返回 `MAINTENANCE_STORE_LOCKED` 时，可检查锁文件元数据；诊断只读取 `<维护计划文件>.lock`，不读取计划/完成记录正文、不显示锁 token，也不修改或删除文件：

```powershell
npm --prefix device-manager run maintenance:lock-status
npm --prefix device-manager run maintenance:lock-status -- --path "C:\path\to\maintenance-schedules.json"
```

输出会区分 `UNLOCKED`、锁记录 PID 当前仍存在、PID 不存在和锁元数据损坏。PID 仍存在不保证一定就是原写入进程（操作系统可能复用 PID）；PID 不存在也只说明原 PID 当前未运行。孤儿锁会让写操作继续失败关闭；诊断和存储逻辑都不会自动清锁，已通过“持锁进程退出但锁文件保留”的子进程测试确认。只有先确认不存在任何维护写入者并按运维流程检查后，才可人工处置残留锁。

维护计划更新按字段合并：未传的可选字段保留，显式传 `null` 才清除字段；清除使用量阈值时，`usage_since_service`、`usage_limit`、`usage_unit` 必须同时为 `null`。已有 `schedule_id` 不能改绑到另一个设备或维护类型，避免旧完成历史指向新对象。

完成记录处理规则：

- 必须传 `user_confirmed: true`；模型/用户没有明确表示已实际完成时不能调用。
- 存在 `interval_days` 时，从完成时间起按经过的 24 小时计算下次到期时间。
- 存在使用量计数时，完成后重置为 0，并把原计数写入完成历史。
- 完成时间不能早于安装时间或上次完成时间；相同计划与完成时间重复提交会返回原记录。省略完成时间时，Gateway 会使用当前时钟，同一计划 60 秒内的无时间重试返回原记录；60 秒后按新的维护事件处理。
- 维护计划查询默认回传最新 20 条完成历史；可传 `completion_schedule_id` 按维护计划筛选，再用 `completion_limit`（1–50）与 `completion_offset`（0–500）分页。列表可能在翻页期间增加新记录时，可用回执 `completion_history_page.next_cursor` 传入 `completion_cursor`，稳定地继续读较旧记录；游标无效时从第一页重查。回执提供筛选后的 `total_count`、`next_offset`、`next_cursor` 和当前 `schedule_id_filter`。不传筛选/分页参数仍保持原有最近 20 条行为，完整历史仍保存在本地文件。
- 没有维护周期时不猜测下一次日期，并清除旧的显式到期日；计划将显示资料不完整。
- 记录完成只是更新维护台账，不等于系统替用户换滤芯、清洁、检查或复位设备。

## 验证

```powershell
node --test device-manager/test/maintenance-store.test.js device-manager/test/energy-operations-tools.test.js
node --test device-manager/test/maintenance-reminders.test.js
npm --prefix device-manager test
npm --prefix energy-saving test
```

新增测试覆盖：工具定义和 OpenClaw 插件实际注册/路由、能耗分析与前后窗口、维护计划重启后读取、重复更新、完成确认门槛、周期/使用量重算、损坏存储 fail-closed。维护提醒工具及本地收件箱的说明、启用条件和状态升级规则见 [`maintenance-reminder-inbox-v0.1.md`](./maintenance-reminder-inbox-v0.1.md)。插件级测试不等于本机 Gateway 已加载新版插件；若要做真实 OpenClaw 对话演示，仍需将本次代码部署到目标 Gateway 并重启/确认插件版本，然后用 Mock 数据实际调用。

## 范围外

- 从 HA/电表自动拉取读数或诊断快照；
- 真实设备接入、自动设备控制、自动维修和维护复位；
- 手机/系统/外部消息推送；本地周期检查只会把条目排入收件箱；
- 对节能建议或前后差值作实际家庭效果/因果结论。
