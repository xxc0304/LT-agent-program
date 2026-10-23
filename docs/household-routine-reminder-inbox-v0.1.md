# 家庭作息提醒收件箱 v0.1

## 目标和边界

把“已确认的睡觉/起床偏好”转换成可追踪的本地提醒，而不是自动控制家电。到点后产生 `routine_due` Event，经运行器校验授权后写入设备管家本地收件箱；OpenClaw 工具负责检查、展示、停止检查和在用户明确知晓后标记已读。

当前没有系统通知/手机推送渠道，也不需要 Home Assistant 或真实设备。提醒只会在用户打开 OpenClaw 并调用相应工具、或明确启动的本地插件轮询中被检查和显示。它不会自动改变灯、空调、门锁等设备状态。

## 启用条件和交互

周期检查默认关闭，插件加载时不会启动计时器。启动必须同时满足：

1. 用户通过 `set_household_routine_reminder_consent` 明确开启独立的作息提醒授权；
2. 管理员在本机为 OpenClaw 进程配置 `DEVICE_MANAGER_ROUTINE_SCHEDULE_ENABLED=true`；
3. 本机设置有效家庭时区 `HOUSEHOLD_TIME_ZONE`（例如 `Asia/Shanghai`）；
4. 用户明确要求“现在开始按作息提醒”。

工具调用顺序：

1. `check_household_routine_reminders`：只做一次到期检查；
2. `start_household_routine_reminders`：启动当前插件进程内周期检查（默认每 15 秒）；
3. `list_household_routine_reminders`：查看待处理提醒；
4. `acknowledge_household_routine_reminder`：用户看见具体提醒并明确表示已知晓后，标记该条提醒；
5. `stop_household_routine_reminders`：停止周期检查。撤回提醒授权后，下一次检查会停止运行器。

如任一授权或配置不满足，检查/启动会安全返回具体的阻止状态，不会悄悄运行。普通的作息观察授权不等于提醒授权；提醒授权也不等于设备动作授权。

## 数据和可靠性

- 作息读取仅使用 `PreferenceMemoryStore` 中已确认且未过期的 `sleep_time` / `wake_time`；候选记忆不能触发提醒。
- `RoutineNotificationInbox` 仅持久化通知 ID、提醒类型、本地日期/时间、时区、状态和时间戳；不存事件原文、偏好 memory ID、设备数据或聊天内容。
- 幂等键按偏好记录和本地日期稳定生成；跨进程重复到期会合并成同一条提醒。
- 待处理数量达到容量上限时拒绝新提醒，不会覆盖未读内容；已确认历史记录可被裁剪。
- 写入使用独占锁和临时文件原子替换。损坏文件或写锁冲突时失败关闭，不会静默重置收件箱。
- 默认收件箱位于本机应用数据目录下 `LT-agent-program/routine-notifications.json`，可通过 `DEVICE_MANAGER_ROUTINE_INBOX_PATH` 覆盖。它当前是本地 JSON，未应用层加密，不应纳入 Git 或跨设备同步。
- 计时器只存在于 OpenClaw 插件进程内，进程/Gateway 重启后默认不会恢复运行；用户需重新启动。外部推送未实现。

## 验证范围

自动测试使用合成偏好、临时记忆文件、临时收件箱和可控时钟，覆盖授权门禁、到期 Event 生成、幂等、跨实例重载、明确确认、容量限制、锁冲突、损坏文件失败关闭、插件工具注册，以及插件加载不自动启动等情况。它不代表真实 HA、家庭设备、操作系统通知或外部消息渠道的联调。

