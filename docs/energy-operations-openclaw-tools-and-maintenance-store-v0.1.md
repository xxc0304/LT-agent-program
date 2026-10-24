# 能耗分析与设备维护 OpenClaw 工具接入 v0.1

## 目标

将节能 Agent 已有的本地分析能力和设备管家已有的维护计划逻辑注册为 OpenClaw 可调用工具，并使维护周期在 Gateway 重启后保留。本阶段仍是本地/Mock 工具链，不连接真实 HA、电表或家电。

## 新增 OpenClaw 工具

| 工具 | 输入 | 结果与边界 |
| --- | --- | --- |
| `analyze_energy_usage` | 调用方提供的区间电量读数，可选电价、预算、时区 | 返回总量、设备/区域/时段画像、显式证据异常候选、成本预算与人工建议；不查电表、不创建设备任务 |
| `evaluate_energy_effect` | 指定设备集合、采样间隔及前后两个窗口 | 窗口等长、读数完整且对齐时报告观察差值；不证明因果节能 |
| `save_maintenance_schedule` | 设备 ID、维护类型、下次日期或周期，可选使用量阈值 | 新建或更新本地维护日程；不读取设备、不执行维修 |
| `get_device_maintenance_plan` | 可选诊断快照、评估时刻和完成历史分页参数 | 返回逾期/到期/近期/资料缺失计划及只读排查建议，并按页返回本地完成历史；没有调用真实 HA |
| `record_device_maintenance_completed` | `schedule_id`、可选完成时间、`user_confirmed: true` | 仅记录用户明确报告已完成的实体维护；更新周期并清零已存在的使用计数；不执行维护或设备复位 |

工具实现位于 `device-manager/src/energy-operations-tools.js`，由 `device-manager/src/openclaw-plugin.js` 注册。节能业务逻辑复用 `energy-saving/src/energy-agent.js`，维护计划复用 `device-manager/src/maintenance-planner.js`，没有再引入新的调度框架。

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
