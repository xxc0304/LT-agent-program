---
name: household-preferences
description: 查询、记住或删除用户明确授权的家庭温度和作息偏好；推测习惯必须经同意、重复观察并由用户确认。
user-invocable: true
---

# 家庭偏好与记忆管理

本 Skill 通过设备管家插件的家庭记忆工具管理少量结构化偏好。工具连接到家庭记忆存储后端，不是对话历史、长期知识库或 OpenClaw 的梦境日记。家庭部署建议每户使用独立 SQLite 数据库，并放在 OpenClaw Gateway/家庭边缘节点的持久化数据区；旧 JSON 后端仅作为兼容默认值，数据库后端由部署配置明确启用。

## 支持范围

- `comfort_temperature_c`：舒适温度（16–30℃），可按房间区分；
- `sleep_time`、`wake_time`：本地时间 `HH:mm`，可按工作日/周末区分。

查询“我平常喜欢多少度/几点睡”时，使用 `get_household_preference`；用户要求查看全部记忆时使用 `list_household_memories`。只把 `status: confirmed` 的记录当作用户偏好。若查询返回 `status: conflict_review`，把冲突候选值自然地列给用户并询问其选择；不要沿用旧值、自动采用多数值或直接生成依赖该偏好的设备/提醒计划。没有记忆时如实说明并询问，不能编造“习惯值”。

## 写入与推测

- 用户明确说“记住”“以后默认”或“长期按这个设置”时，调用 `remember_household_preference`，设置 `user_explicit_request: true`。一次性调温/开灯指令不等于长期记忆授权。
- 用户明确要求开始观察时，调用 `set_household_observation_consent` 开启授权，并可用 `get_household_observation_consent` 查询当前状态。授权默认关闭；普通聊天、一次性控制、图片或单次设备状态不能作为行为证据。候选写入仅供内部可信事件适配器调用，不对话模型开放；当前 HA `state_changed` 事件没有可靠的手动操作归因，因此在完成来源适配前不得声称已自动采集或推断真实家庭习惯。
- 可信适配器将来接入后，仅观察睡觉/起床的结构化时间；日期由代码按家庭时区计算，观察时间按 15 分钟归并；至少 3 个不同本地日期且置信度达到 0.8，才会形成待确认候选。同一天的重复事件不增加观察次数。
- 同一偏好范围的观察值相互不同，或新观察值与已确认偏好不同，候选会进入 `conflict_review`，不会自动晋级。调用 `list_household_memories(include_pending: true)` 向用户展示各候选值、观察天数和状态；不得替用户判断哪个值代表习惯。用户选定某个达到证据门槛的候选后，才能调用 `confirm_household_memory_candidate`；用户也可以直接明确要求记住某个新值，显式偏好会覆盖并清除同范围候选。
- 候选未确认前不能用于设置设备或自动安排日程。先向用户展示具体内容和证据摘要，再等待明确选择，然后调用 `confirm_household_memory_candidate` 并设置 `user_confirmed: true`。
- 用户明确撤回观察授权时，调用 `set_household_observation_consent` 关闭；这会删除观察推断的候选和已确认推断记忆，但保留用户明确要求保存的偏好。
- 作息观察授权与“按已确认作息安排提醒”的授权完全独立。用户明确要求开启或停止提醒时，使用 `set_household_routine_reminder_consent`；没有明确要求不能自行开启。
- 用户明确要求现在检查提醒时，使用 `check_household_routine_reminders`；明确要求开始周期提醒时，先确认用户提醒授权已开启，再调用 `start_household_routine_reminders`。后者还要求本机 `DEVICE_MANAGER_ROUTINE_SCHEDULE_ENABLED=true` 和有效 `HOUSEHOLD_TIME_ZONE`；任一条件未满足时说明具体缺项，不要自行修改本机配置。提醒收件箱通过 `list_household_routine_reminders` 查看；只有用户看见具体提醒并明确表示已知晓后，才调用 `acknowledge_household_routine_reminder`。用户要求停止时调用 `stop_household_routine_reminders`。
- 用户要求忘记/删除时，先列出并确认目标记录，再使用 `forget_household_memory`。不要用日记、自由文本或原始聊天副本替代结构化存储。

## 隐私与执行安全

- 只存值、范围、来源类型、置信度、事件 ID、确认状态和有效期；不保存原始对话、儿童图像/视频、身份信息、API Key、密码或瞬时设备状态。
- 作息偏好是计划条件，不是设备执行授权。仓库提供默认关闭的本地作息轮询器、独立提醒同意状态和持久化 OpenClaw 收件箱；只有用户显式启动且本机功能开关已配置，轮询器才在当前插件进程中工作。提醒可通过 OpenClaw 工具查看，不会发送外部推送，也不会在到点时自动控制设备。Gateway 重启后需用户重新启动轮询。
- JSON 文件和标准 SQLite 数据库都没有应用层加密；不要把家庭数据复制到 Git、CtxHop、普通云盘或未经批准的跨设备同步。数据库部署需要保护 Gateway 的持久化数据区并建立经授权的备份策略。当前后端为 Mock 时，任何设备动作都必须标注模拟结果。
