# 维护周期本地提醒收件箱 v0.1（schema 0.4）

## 功能范围

设备管家可以使用已保存的维护计划，按需检查或在用户明确启动后周期检查 `DUE_SOON`、`DUE`、`OVERDUE` 项目，并将提醒写入 OpenClaw 本机状态目录中的收件箱。提醒只作为“需要查看/安排维护”的信息，不代表已执行维护。

## OpenClaw 工具

| 工具 | 用途 | 边界 |
| --- | --- | --- |
| `check_maintenance_reminders` | 立即检查一次并排入本机提醒收件箱 | 可按需调用；不启动周期任务 |
| `start_maintenance_reminders` | 立即检查一次，然后启动周期检查 | 需用户明确要求，并且管理员已设置本机开关；只有用户明确要求跨 Gateway 重启继续时才传 `resume_after_gateway_restart: true` |
| `stop_maintenance_reminders` | 停止周期检查并撤销自动恢复意图 | 不删除已有提醒 |
| `get_maintenance_reminder_status` | 查看功能开关、运行状态和待处理数量 | 不返回维护历史全文 |
| `list_maintenance_reminders` | 分页查看提醒；传 `include_acknowledged`、`include_snoozed`、`include_completed` 或 `include_archived` 可纳入对应记录 | 默认最近 20 条；静态查询可用 `limit`/`offset`，列表可能变化时优先续用 `next_cursor`；回执含 `total_count` |
| `archive_completed_maintenance_reminders` | 按 `completed_before` 截止时间，将已完成提醒移入同文件的归档区 | 必须先说明筛选条件并取得用户明确确认；只移动 `completed_at <= completed_before` 的 `completed` 记录；不删历史、不动待处理/已读/暂缓记录 |
| `acknowledge_maintenance_reminder` | 用户明确表示知晓后标记已读 | 不等于维护完成；完成需单独调用 `record_device_maintenance_completed` 并明确确认，完成时会同步关闭对应提醒 |
| `snooze_maintenance_reminder` | 用户明确要求稍后再提醒时，暂缓一段指定时长 | 时长需用户明确给出，范围 5 分钟至 30 天；暂缓不等于已读/完成，不会发送外部通知 |

周期检查默认关闭，插件加载不会启动计时器。启用条件：

1. 管理员在启动 OpenClaw Gateway 的进程环境中设置 `DEVICE_MANAGER_MAINTENANCE_REMINDERS_ENABLED=true`；
2. 用户明确要求开始周期维护提醒，并由 Agent 调用 `start_maintenance_reminders`；
3. 默认只在当前 Gateway 进程运行。只有用户明确要求“Gateway 重启后继续”时，才传 `resume_after_gateway_restart: true`。OpenClaw 后台服务会在 Gateway 启动时读取该授权并恢复周期检查；管理员开关关闭、状态文件损坏或不可读时均不会恢复。用户调用 `stop_maintenance_reminders` 会清除该恢复意图。

默认每 60 分钟检查一次，可通过 `DEVICE_MANAGER_MAINTENANCE_REMINDER_POLL_MS` 覆盖，范围为 60,000 到 86,400,000 毫秒。该变量只改变间隔，不会单独启用或启动提醒。

## 本地存储与去重

默认收件箱路径：

```text
<OPENCLAW_STATE_DIR>/device-manager/maintenance-reminders.json
```

若未设置 `OPENCLAW_STATE_DIR`，路径位于 `~/.openclaw/device-manager/maintenance-reminders.json`。也可用 `DEVICE_MANAGER_MAINTENANCE_REMINDER_INBOX_PATH` 覆盖。文件只保存设备/计划标识和名称、维护类型/状态、周期键及创建/更新/已读/暂缓到期/维护完成/归档时间；不保存聊天原文、HA 凭据或传感器历史。`notifications` 是有 500 条上限的活动收件箱；`archived_notifications` 保留已归档完成历史，归档通过同文件原子替换完成，避免把“搬入归档”误当成删除。文件缺失按空收件箱处理；损坏或未知 schema 会 fail closed，不自动覆盖。收件箱达到活动容量上限时，只提示可按截止日期归档已完成记录，不会自动删除或清理记录。

跨 Gateway 重启恢复意图单独存放于 `device-manager/maintenance-reminder-runner.json`，只保存 `auto_resume` 和更新时间，不包含家庭偏好或对话内容。可用 `DEVICE_MANAGER_MAINTENANCE_REMINDER_RUNNER_STATE_PATH` 覆盖。缺失状态视为未授权；损坏或未知 schema 会 fail closed，不会自动覆盖。Gateway 后台服务停止计时器时保留此意图；用户主动调用停止工具时则清除它。此功能只在 Gateway 进程已启动后恢复计时器，不负责安装或修复 Windows Gateway 开机启动任务。

重复周期检查按 `schedule_id` 和到期周期去重。`DUE_SOON` 升级为 `DUE`/`OVERDUE` 时更新同一提醒；已读提醒升级到 `OVERDUE` 时会重新进入待处理列表。已排队提醒是历史快照，修改维护计划不会静默删除它；查看后应核对当前维护计划。

用户明确选择时长后可暂缓提醒 5 分钟至 30 天。暂缓期间提醒从默认待处理列表隐藏，但可通过 `list_maintenance_reminders(include_snoozed: true)` 查看。暂缓时间到期后，下次查看列表或运行一次检查时，同一提醒恢复为待处理；如果其维护状态在暂缓期间升级为 `OVERDUE`，则立即重新打开。暂缓记录单独标记为 `snoozed`，不会伪装成已读或维护完成。

用户明确确认 `record_device_maintenance_completed` 后，维护计划会先记录完成并更新周期；随后提醒收件箱将同一 `schedule_id` 下、在完成时间之前创建的待处理/已读/暂缓提醒标记为 `completed`。它们会保留作历史，默认列表隐藏，可通过 `include_completed: true` 查看。若收件箱写入失败，维护完成记录仍保留，工具会返回 `reminder_resolution.success: false` 以提示部分同步失败；幂等重试会再次尝试同步。

提醒收件箱 schema 0.4 可安全读取 0.1/0.2/0.3：旧记录写入时补齐 `archived_notifications: []`；首次成功写入使用 0.4。未知版本、归档区含非完成提醒或 ID 在活动/归档区重复时均 fail closed，不会覆盖原文件。

归档工具要求 `user_confirmed: true` 和可解析的 `completed_before`；仅筛选 `status=completed` 且 `completed_at` 不晚于截止时间的活动记录，并添加 `archived_at` 后移入归档区。归档记录仍是完成历史，不再占用 500 条活动提醒容量；使用 `list_maintenance_reminders(include_archived: true)` 可查询。按周期去重同时检查活动区和归档区，防止后续检查重新生成相同周期提醒。归档不代表删除、清空或压缩本地文件。

## 不包含的能力

- 不发送手机推送、邮件、短信或其他外部通知；当前会话需要调用列表工具才能查看收件箱。
- 不查询真实 HA/电表，不控制设备，也不自动执行滤芯更换、清洁、检查或复位。
- 默认不在 Gateway 重启后恢复计时器；用户明确选择 `resume_after_gateway_restart: true` 后才会恢复，且管理员开关必须仍保持开启。

## 验证

可用一个命令运行完整的隔离演示：

```powershell
npm --prefix device-manager run demo:maintenance-reminders
```

演示使用合成的滤芯维护计划和临时目录，依次展示 `DUE_SOON` 提醒、独立 Node.js 进程重建后的持久化与去重、暂缓 10 分钟后到期恢复、用合成夹具模拟“已读”（不是真实用户交互）但维护仍未完成、升级为 `OVERDUE` 后重新进入待处理、明确模拟完成维护后关闭旧周期提醒并保留完成历史、按 30 天周期生成新的独立提醒，以及用合成确认将旧周期移入归档但下一周期待处理提醒仍保留。演示结束会删除临时数据；它不启动周期定时器，也不代表运行中的 OpenClaw Gateway 或真实设备已验收。

设备管家插件还提供 `run_mock_maintenance_reminder_demo`，仅供用户明确要求演示时调用。它在 OpenClaw 工具响应中返回阶段摘要，不读取正式维护台账或真实提醒；即使模型通过自然语言发起调用，所有计划/提醒仍只存在于演示临时目录。

自动化测试：

```powershell
node --test device-manager/test/maintenance-reminders.test.js
npm --prefix device-manager run demo:maintenance-reminders
npm --prefix device-manager run verify
```

测试使用临时目录、合成维护计划和可控时钟，覆盖持久化、去重/升级、明确已读、暂缓/恢复、维护完成同步、下一维护周期重新建提醒、按截止日期显式归档、容量释放且历史保留、0.1/0.2/0.3 到 0.4 兼容升级、故障文件保护、周期任务授权门禁、显式重启恢复和 OpenClaw 后台服务注册。隔离演示末尾用合成夹具演示用户确认归档，不是真实用户交互。此验证不代表本机 Gateway 已加载新版插件或真实设备联调完成。

列表支持 `limit`/`offset` 和游标分页，默认仍返回最近 20 条待处理提醒。`total_count` 是当前状态筛选后的记录总数；静态列表可用 `next_offset`，其为 `null` 时表示没有下一页。若翻页期间提醒可能新增或改变状态，优先将 `next_cursor` 作为下一页的 `cursor`：它用完整收件箱中的提醒 ID 定位，不依赖锚点仍属于当前筛选状态，也不会被新插入的较新提醒挤位。要查看翻页途中新增的较新提醒，应重新从第一页查询。游标缺失时返回 `INVALID_LIST_CURSOR`，请从第一页重查。分页先按所选状态筛选，再按最近创建时间优先排序；不改变既有默认过滤规则。

`run_mock_maintenance_reminder_demo` 的插件注册和路由另由 `device-manager/test/mock-maintenance-reminder-tool.test.js` 覆盖；当前本机隔离 profile 尚未把这个演示工具加入 allowlist，因此本机 Gateway 的运行时对话入口尚未启用。

## 本机 Gateway 加载核验（2026-10-18）

用户授权短暂重启隔离 `2026.7.1-2` Gateway 后，`openclaw gateway status` 显示 CLI/Gateway 版本一致，Gateway 在 `127.0.0.1:18789` 恢复监听；`openclaw plugins inspect device-manager --runtime` 显示插件 `loaded`，并列出当时已注册的维护提醒工具。此轮仅检查工具发现，不通过模型对话调用工具，也未读取、创建或修改家庭维护计划/提醒数据。后续维护完成联动在代码与 Mock 层验证；未因此重启 Gateway 或复测运行时工具清单。

Gateway 的 Windows Scheduled Task 当前显示 missing，因此 safe restart 后没有自动重启。为恢复用户原本正在使用的 Gateway，按既有隔离 profile 的 `state/gateway.cmd` 临时隐藏启动；未重建任务计划。当前监听进程可能在 Windows 重启后不会自动恢复。CLI 的 Gateway capability 仍显示 `connected-no-operator-scope`，不影响本次插件运行时清单读取，但实际对话工具调用尚未验证。启动输出的 iMessage/Telegram bundled channel path warnings 与 device-manager 插件加载无关。

## 周期检查的显式重启恢复

维护提醒插件后台服务会在 Gateway 启动时检查独立 runner 状态。只有管理员开关仍开启、状态文件有效，并且用户曾通过 `start_maintenance_reminders` 明确选择重启后恢复，才重新启动周期检查。默认不恢复；用户停止工具会清除授权。只恢复本地计划检查，不发送外部通知、不执行维护或设备动作。它不解决 Windows Scheduled Task missing，也不负责启动 Gateway 进程。
