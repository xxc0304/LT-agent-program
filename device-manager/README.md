# 设备管家 Agent（第一阶段）

这是家庭微脑项目的设备管理基础模块。默认使用 Mock Home Assistant 模拟设备，并提供设备工具、多 Agent 调度和本地家庭偏好记忆工具
可以被 Agent 调用的结构化工具；也已经提供真实 Home Assistant REST API 适配层，拿到联调
地址和令牌后可切换后端，不需要修改 Agent 工具定义。

## 当前包含的设备

| 设备 | device_id | 类型 |
| --- | --- | --- |
| 客厅灯 | `light.living_room` | `light` |
| 卧室空调 | `climate.bedroom` | `climate` |
| 客厅窗帘 | `cover.living_room_curtain` | `cover` |
| 入户门锁 | `lock.front_door` | `lock` |
| 客厅温度传感器 | `sensor.living_room_temperature` | `sensor` |
| 客厅湿度传感器 | `sensor.living_room_humidity` | `sensor` |
| 客厅人体感应器 | `binary_sensor.living_room_motion` | `binary_sensor` |
| 入户门磁 | `binary_sensor.front_door_contact` | `binary_sensor` |
| 厨房烟雾传感器 | `binary_sensor.kitchen_smoke` | `binary_sensor` |
| 客厅小米插座（模拟） | `switch.living_room_plug` | `switch` |

设备初始状态位于 `config/devices.json`，后续可以直接增加其他模拟设备。

跨组交接时，`list_devices` 和 `get_state` 支持传入 `canonical: true`，返回统一设备视图：稳定
`device_id`、`source.external_id`、`availability`、`state_snapshot` 和 `capabilities` 分开表达。
默认返回的 HA 风格字段仍保留，便于当前 Mock 和真实 HA 适配器兼容。

## 设备工具和多 Agent 调度工具

能耗分析、前后用量比较、预算进度估算和低价优化计算工具只开放给 `energy-saving` 会话；设备管家保留 `plan_energy_optimization` 委派入口，并负责待机候选的设备复查、确认和执行。部署安装器会显式拒绝设备管家直接使用能源分析工具，避免绕过能源管家职责。维护工具管理本地维护计划和提醒收件箱；完整工具范围与边界见 [`../docs/energy-operations-openclaw-tools-and-maintenance-store-v0.1.md`](../docs/energy-operations-openclaw-tools-and-maintenance-store-v0.1.md) 与 [`../docs/maintenance-reminder-inbox-v0.1.md`](../docs/maintenance-reminder-inbox-v0.1.md)。

- `list_devices`：获取设备列表，可按 `domain` 过滤。
- `get_state`：查询一个设备的当前状态。
- `control_device`：执行控制并返回控制前后的状态。
- `run_scene`：固定参数场景执行器；OpenClaw 对话层会拦截直接调用，用户场景统一走预览和确认流程。
- `diagnose_device`：诊断指定设备或全部设备，只读返回在线状态、属性异常证据和处理建议。
- `get_device_events`：按设备、`trace_id`、事件类型和数量查询动作、失败和诊断告警事件；默认保留最近 200 条进程内记录。真实 HA 后端可通过 `DEVICE_MANAGER_EVENT_LEDGER_PATH` 显式启用本地持久化账本，仍最多保留 200 条，并会剔除任意消息/参数、API 错误文本、令牌和 HA 主机地址。
- `dispatch_agent_event`：将标准 Event 交给本地调度器，由能源管家规划；对话工具输入一律视为未认证，产生设备写任务时会暂停询问，确认后再由设备管家执行并回读；不接收图片或 API Key。
- `evaluate_energy_event_with_independent_agent`：通过 2026.7.1-2 Gateway 调用独立注册的 `energy-saving` Agent；严格校验 Event/Task/`NO_ACTION` 与 trace。`NO_ACTION` 为正常无动作结果；Task 进入设备管家既有计划校验和确认流程。对话事件不等于认证传感器事实，因此候选设备动作默认暂停等待确认，不直接执行。
- 内部 `createIndependentLearningEnergyWorkflow`：把经本地认证的结构化学习观测交给独立 `learning-companion` 产出 Event，再按时效、目标范围、置信度、复核状态和离位持续时间门禁决定是否调用 `energy-saving`；当前尚无已接线的可信视觉/传感器来源，因此不对话暴露、不接受模型自报认证。
- `call_independent_agent`：通用独立 Agent Gateway 调用边界，仅返回经过契约校验的候选 Event/Task/`NO_ACTION`，本身不执行设备动作。
- `submit_agent_plan`：提交 OpenClaw/LLM 提出的多 Agent 候选计划，由本地注册表、设备白名单、实时状态/证据和冲突校验决定执行、确认、澄清或拒绝。
- `resolve_agent_action_confirmation` / `list_pending_agent_action_confirmations`：处理或查看待确认操作；不向用户索取内部审批 ID，只有看到具体设备与动作后的明确答复才能批准。
- `run_mock_agent_chain_demo`：仅响应明确的自然语言演示请求；在隔离 Mock HA 中合成事件并跑通学习伴学、节能、设备管家链路，不连接真实设备。
- `run_mock_household_memory_learning_demo`：仅响应明确的家庭偏好学习演示请求；使用合成温度/亮度事件和临时存储，不读取或修改正式家庭记忆，不连接真实 HA，也不执行设备动作。
- `run_mock_maintenance_reminder_demo`：仅响应明确的维护提醒演示请求；使用临时合成数据演示提醒生成、跨 Node.js 进程去重、明确时长的暂缓与到期恢复、合成已读边界、逾期升级、维护完成与下一周期提醒，以及显式确认后归档旧周期；不查询真实维护状态、不修改正式维护台账。
- `get_household_preference` / `list_household_memories`：仅读取已确认的本地温度、灯光亮度和作息偏好；普通候选不作为可用偏好返回。若相关范围有 `conflict_review`，偏好查询会返回候选值和冲突状态，OpenClaw 必须先询问用户，不能沿用旧值。
- `remember_household_preference`、`get_household_observation_consent`、`set_household_observation_consent`、`get_household_routine_reminder_consent`、`set_household_routine_reminder_consent`、`confirm_household_memory_candidate`、`forget_household_memory`：显式保存、查看/撤回观察与提醒授权、确认和删除。观察授权与作息提醒授权相互独立，均默认关闭；撤回观察授权会删除观察推断出的候选和已确认推断记忆，但保留用户明确保存的偏好；撤回提醒授权不删除已确认的作息偏好。保存提醒授权本身不会自动启动定时器或发送通知。候选写入 API 仅留给内部可信适配器，不开放给对话模型，避免模型伪造学习证据。
- `preview_household_routine`：读取已确认的睡觉/起床偏好，产出只读提醒建议；偏好冲突时返回候选、不生成建议；不创建时钟任务，也不控制设备。
- `check_household_routine_reminders` / `start_household_routine_reminders` / `stop_household_routine_reminders` / `get_household_routine_reminder_status`：用已确认作息产生 `routine_due` 事件并去重写入本地提醒收件箱；周期检查不会随插件启动，只有用户明确要求启动、持久提醒授权开启、配置家庭 IANA 时区且本机 `DEVICE_MANAGER_ROUTINE_SCHEDULE_ENABLED=true` 时才启动。检查结果可由 OpenClaw 展示；不发送外部推送、不控制设备。
- `list_household_routine_reminders` / `acknowledge_household_routine_reminder`：读取待处理提醒或历史，并在用户明确表示已知晓后标为已确认。收件箱默认位于本机应用数据目录 `LT-agent-program/routine-notifications.json`，只保存提醒类型、日期/时间、时区、状态和时间戳，最多保留 200 条；容量满时不丢待处理提醒。
- `plan_scene`：只读预览回家、睡眠或离家场景；已确认的卧室舒适温度（设备在线且处于温控范围内）和客厅舒适亮度（设备在线且明确支持亮度调节）可作为建议参数，不执行控制。
- `execute_scene_plan`：仅在用户看到完整计划并于后续独立消息明确同意后，重新校验偏好和设备、执行计划并逐项回读；Agent 在工具调用中传入内部计划 ID 与 `user_confirmed: true`，不要求用户输入 UUID/口令；计划十分钟过期、只能使用一次，Gateway 重启会使未完成计划失效。
- `discover_household_devices`：只读扫描 HA 当前暴露的受支持实体及可用的 Device/Entity/Area Registry，并与本地家庭设备清单对账；新发现实体默认待核对。
- `list_household_device_inventory`：查看实体、物理设备分组、HA 房间建议、用户核对房间、登记状态和节能授权。
- `review_household_device`：按用户明确提供的信息校正设备名称/房间、批准或排除设备，并可单独开启节能授权。HA 导入的房间只是建议；纳入节能必须明确核对并传入房间，且门锁、窗帘、传感器等不属于当前节能候选类型。
- `plan_room_energy_saving`：刷新 HA 清单后，按已确认房间动态规划当前在线、已批准、已授权节能且明确支持关断的灯/插座；设备不齐时输出可执行子集和跳过原因，不猜等效动作。
- `execute_room_energy_saving_plan`：仅在用户看过完整多设备计划并在后续消息明确同意后执行；执行前重新检查设备与能力，旧计划变化即失效，结果逐设备回读。
- `analyze_room_energy_adaptation`：刷新指定房间并输出场景就绪度、设备缺口和可执行的下一步完善建议；会考虑用户明确保存的设备偏好，只读不控制。
- `record_room_energy_scenario_feedback`：只记录用户明确表达的结构化反馈；可将某台设备设为优先/排除/恢复默认，也可记录方案有帮助或效果不佳。优先偏好不绕过审批、房间、节能授权、在线和能力检查。
- `get_room_energy_adaptation_report`：汇总本地结构化反馈和设备动作回读统计。没有能耗传感器与对照基线时，不报告节电 kWh 或百分比。
- `start_household_device_monitor` / `stop_household_device_monitor` / `get_household_device_monitor_status`：用户明确要求持续监测后，启停当前 OpenClaw 进程内的只读状态订阅和每分钟健康巡检；真实 HA 使用 WebSocket，Mock 使用模拟事件。`off` 是正常状态、不告警；普通实体首次离线后等待 2 分钟复查，显式配置的安全关键实体等待 15 秒复查。宽限期内恢复会写入脱敏 `diagnostic_transient`、不生成故障告警；达到 3 台同时持续离线时，普通设备告警合并成一条 `diagnostic_shared_infrastructure_suspected`，避免把一次可能的断电/网络/HA 故障误报成多台设备各自损坏；门锁等明确配置的安全关键实体仍单独告警。数量降到阈值以下会写 `diagnostic_shared_infrastructure_cleared`，剩余普通设备恢复单独跟踪。系统不自动判定共同根因；故障恢复会清除活动告警并写入 `diagnostic_recovered`；实体从成功清单扫描中消失时写入 `diagnostic_tracking_ended`，但不代表设备已修复。不自动控制或修复设备。

新实体默认不能控制、不能被能源管家使用。OpenClaw 执行设备写操作前会重新扫描 HA，并检查目标实体已在清单中且登记批准；能源管家则只收到已批准、显式 `energy_opt_in`、具备用户确认房间的灯/插座/空调。登记文件保存 HA 物理设备/实体标识、Registry 房间建议、用户核对与授权元数据，但不保存 HA 凭据或实时状态。默认放在当前 OpenClaw 状态目录下的 `device-manager/device-inventory.json`，也可用 `DEVICE_MANAGER_INVENTORY_PATH` 指定。

真实 HA 扫描通过 REST `/api/states` 读取实体，再以 WebSocket `/api/websocket` 读取 Device/Entity/Area Registry；可把多个实体按 `ha_device_id` 聚合展示，并过滤 HA Entity Registry 标记为 disabled 的实体。灯的亮度能力依据 `supported_color_modes`，空调/窗帘能力依据 `supported_features` 与温控范围识别；明确不支持的动作会在发送服务请求前拦截，未知能力会保留兼容路径并标记为未知。WebSocket 不可用时会退回 REST-only，并在结果中显式报告 `registry_enrichment.status: unavailable`；旧的 Registry 元数据不会因此被清掉。登记/授权仍按 HA `entity_id` 独立处理。该功能不扫描局域网，设备必须先由 HA 集成接入。自动化测试使用 Fake WebSocket，真实 HA 尚未实机联调。详细流程和验收范围见 [`docs/device-inventory-onboarding-v0.1.md`](../docs/device-inventory-onboarding-v0.1.md)。

设备清单扫描也会报告本次运行中观察到的可用状态变化，以及 HA 动作能力从支持变为不支持/未知等变化；这些差异让设备管家能据最新条件重算方案，不保存常态设备状态。当前“房间最小节能”闭环和限制见 [`docs/adaptive-device-management-v0.1.md`](../docs/adaptive-device-management-v0.1.md)，离线演示可运行 `npm run demo:adaptive-energy`。

场景逐步完善：`analyze_room_energy_adaptation` 根据当前实体、授权、房间确认、在线状态和动作能力给出差距分析；用户明确反馈后，`record_room_energy_scenario_feedback` 把单设备优先/排除选择保存在 OpenClaw 状态目录 `device-manager/scenario-adaptation.json`（可用 `DEVICE_MANAGER_SCENARIO_PROFILE_PATH` 改路径）。未来计划会应用已保存的排除偏好，并仅在设备通过全部原有安全检查后优先展示偏好设备。持久化内容限于设备偏好、反馈类型和执行回读计数，不保存聊天原文；它不是 LLM 自动推断习惯，也不会创建触发器或自动执行。当前效果评估只覆盖执行和状态回读，不等于实测节能量。

作息提醒收件箱和运行器由本地自动化测试覆盖；隔离演示可运行 `npm run demo:routine-reminders`。其周期检查仅在授权后可选启动，且运行状态只在当前插件进程中，进程重启后需用户重新启动。当前实现是本地收件箱而非系统通知推送；提醒达到时刻不会自行向手机/外部通道发送消息。收件箱写入不会控制设备。家庭记忆/提醒 JSON 当前没有应用层加密，不要跨设备同步或上传 Git。

维护提醒可用 `npm run demo:maintenance-reminders` 一键演示：合成计划进入近期提醒、独立 Node.js 进程读回并去重、暂缓 10 分钟并在到期后恢复、用合成夹具模拟已读（不是真实用户交互）但不算维护完成、逾期后重新打开提醒、记录维护完成并生成下一周期提醒，再显式确认归档旧周期且保留新周期待办。演示数据存于临时目录并在结束后删除；不调用 Gateway、HA、模型 API 或外部通知，也不启动周期定时器。
同一隔离演示也可由 OpenClaw 在用户明确要求演示时调用 `run_mock_maintenance_reminder_demo`，输出只包含阶段摘要与安全边界，不把测试夹具伪装成人的确认。

状态监测默认不自动启动，只应在用户明确要求持续监测后调用。真实 HA 模式使用 WebSocket 订阅 `state_changed`；Mock 模式使用模拟后端中的状态变化事件。事件经防抖后刷新清单并诊断变化设备；监测期间还会每分钟扫描一次设备清单并巡检健康状态，可补发现漏掉的状态推送。`off` 是正常业务状态，不触发告警。实体出现 `unavailable` / `unknown` 时先进入待复查：普通设备默认宽限 2 分钟，明确配置的安全关键实体默认宽限 15 秒，随后重新扫描 HA 并诊断；持续离线才产生告警。同一故障不重复新增告警。宽限期内健康恢复会清除待复查并只写入 `diagnostic_transient`（实体 ID、故障代码、持续毫秒数和固定摘要），不生成故障或恢复告警；诊断/清单检查失败时保持待复查并稍后重试，不能当成健康或持续离线。3 台及以上同时持续离线时，普通设备告警聚合为一条 `diagnostic_shared_infrastructure_suspected`，提示可能涉及 HA、网络或供电，不把每台普通设备分别判断为故障；明确配置的安全关键设备仍保留单独告警。离线数量降到阈值以下时写入 `diagnostic_shared_infrastructure_cleared`，仍离线的普通设备恢复单独跟踪。系统不会自动推断根因。设备在正式单设备告警后恢复健康时清除活动告警并写 `diagnostic_recovered`；实体从成功的 HA 清单扫描中消失时写 `diagnostic_tracking_ended`，不能推断设备已修复。所有监测摘要都不保留原始状态、属性或令牌，也不会自动控制/修复设备。Mock 监测只代表模拟设备事件，不是真实传感器数据。监测仅在当前 OpenClaw 进程中运行，进程重启后需重新启动。真实 HA 连接仍未实机联调；自动化测试使用 Fake WebSocket。

离线告警策略可用 OpenClaw 进程环境变量调整（单位为毫秒）；安全关键实体列表只做精确 ID 匹配，不按名称、设备类型或风险提示自动猜测：

```text
DEVICE_MANAGER_OFFLINE_GRACE_MS=120000
DEVICE_MANAGER_CRITICAL_OFFLINE_GRACE_MS=15000
DEVICE_MANAGER_CRITICAL_MONITOR_ENTITIES=lock.front_door,binary_sensor.smoke_alarm
```

未设置最后一项时没有显式安全关键实体，所有离线实体使用普通宽限期。`requires_confirmation` / `risk_level` 控制写操作是否需要用户确认，与监测离线严重级别是两套独立策略。

传感器使用 `get_state` 读取，不作为可控制设备；温湿度传感器会校验数值范围，人体、门磁和烟雾传感器会校验 `on/off` 状态。

工具定义在 `src/tools.js`，模拟 Home Assistant 的行为在 `src/mock-ha.js`。

`src/openclaw-plugin.js` 是 OpenClaw 适配层，插件清单位于
`openclaw.plugin.json`。设备控制、候选计划和事件调度共享同一个 Home Assistant 后端与待确认工作流，
因此跨 Agent 任务控制设备后能再次读取并验证变化。`run_mock_agent_chain_demo` 则刻意使用独立的 Mock HA，保证演示不会控制配置中的真实后端。

`dispatch_agent_event` 的边界是：学习伴学 Agent 产生 `learning_behavior` Event，能源管家只生成
`device_action` Task，设备管家才执行动作。公开 OpenClaw 工具不会把 Event 的 `source_agent` 当作认证凭据；代码会重写来源为未认证输入。只有内部适配层通过已配置的可信入口提交的事件，才可能满足自动执行条件；当前插件尚未连接真实 HA 事件推送，因此公开工具触发的设备写操作都要确认。

学习行为触发节能动作时，能源管家必须先实际收到同区域、60 秒内、可信来源的 HA `occupancy_changed` 无人事件；学习模型不能在 payload 里自报传感器佐证。当前 `agent-event-demo.js` 的白名单与占用事件均为本地 Mock，不代表已连接真实传感器。动作确认细则见 [`docs/agent-action-confirmation-policy-v0.1.md`](../docs/agent-action-confirmation-policy-v0.1.md)。

## OpenClaw Skills

设备管家工作区的 `skills/` 包含只读查询 `device-status`、设备控制 `device-control`、场景控制
`scene-control`、只读故障诊断 `fault-diagnosis` 和记忆治理 `household-preferences`。节能和学习伴学工作区模板分别包含
`energy-planning` 与 `learning-behavior-review`。Skill 是操作流程与安全边界说明，不替代
`src/` 中的实际业务逻辑和工具；尤其学习 Skill 不能代替视觉模型，节能 Skill 也不能越过设备管家直接执行。

家庭记忆 API 位于 `agent-memory/`，默认存入本机应用数据目录；未确认推测不得用于设备控制。当前 JSON 文件没有应用层加密，不应放进仓库、云盘或跨设备同步。

## 安全规则

当前 OpenClaw 插件已在代码路径中实施以下确认分级：

- 只读查询、设备诊断、状态/事件查看：不需要确认。
- 目标和动作明确的单设备即时操作：普通灯、插座/开关、空调和窗帘不要求额外操作确认；仍须通过家庭设备登记、在线状态、参数和新鲜证据校验，执行后回读。门锁和显式标记为高风险的设备除外。
- 门锁上锁，以及显式标记为高风险的设备写操作：先展示目标与动作，等待用户后续明确同意。设备可通过 `requires_confirmation: true` 或 `risk_level: high/critical` 标记；真实 HA 也可通过 `HA_CONFIRMATION_REQUIRED_ENTITIES` 设置实体 ID 清单。工具参数 `confirmed: true` 不能绕过此门禁。
- 门锁解锁：用户在聊天中明确同意后，还必须由独立可信认证界面完成身份验证。认证适配器签发的短时授权绑定到审批 ID、计划指纹、门锁实体和 `unlock` 动作；设备写入层在调用 HA 前校验签名、受众、时效和一次性标识。认证服务未配置、未返回有效凭据或凭据不匹配时，Mock 与真实 HA 后端都会拒绝开锁。PIN、生物特征和签名凭据不在 OpenClaw 工具参数中，也不得进入对话。
- 场景、多设备操作、跨 Agent 候选计划和未预授权自动化仍需确认。模糊目标/动作、多个可能解释或冲突计划必须先澄清，不能让模型猜测执行。
- 能源管家事件自动关灯：仅允许经内部可信入口、由能源管家实际生成的灯具 `turn_off` 任务；公开对话工具提交的事件不会被视为可信传感器事实。当前没有真实 HA 事件适配器，所以公开事件工具触发写操作时会要求确认。
- 目标/动作不清楚：先澄清，不提交写计划。必要证据缺失/过期或设备离线：拒绝/等待刷新，用户同意不能替代证据。
- 同设备互斥动作：候选计划返回 `CLARIFICATION_REQUIRED`，不创建批准项；调度器队列中的同优先级冲突 fail-closed（冲突任务均不执行）。询问用户保留哪项或要求的先后顺序，再提交新计划。
- 超时或执行后状态回读不确定：不自动重放命令；先用 `get_state` 或 `diagnose_device` 查清状态。
- 成功的控制操作写入内存审计日志。
- 控制请求完成后必须回读状态；服务请求成功但状态未达到目标时返回
  `POST_ACTION_VERIFICATION_FAILED`，不会伪装成成功。
- 成功控制结果带有 `verified: true` 和 `verification_required: true`，同时写入
  `action_executed` 事件；失败、超时和状态不一致写入 `action_failed` 事件。

- 一次性诊断可将异常写入 `diagnostic_alert`；持续监测下离线需先过宽限期复查，普通离线告警为 `warning`，显式关键实体为 `critical`。监测宽限期内恢复写 `diagnostic_transient`，不写故障告警。
- 持续监测发现先前告警设备恢复健康时写入 `diagnostic_recovered` 事件；该事件只说明重新观测到健康状态，不表示系统执行了修复。
- 持续监测发现实体从成功的 HA 清单扫描中消失时写入 `diagnostic_tracking_ended`，说明停止跟踪该实体的活动告警；不代表设备恢复。
- 场景执行前会完整检查目标设备是否可用，避免设备离线造成“半个场景”被执行。
- 个性化计划执行前会再次读取偏好和设备条件；计划内容或可用条件变化、设备离线或温控范围未知时拒绝执行。
- 确认后的个性化温度只允许替换预定义场景中的空调设定温度，不允许模型临时拼装其他动作。
- 场景执行审计会携带计划 ID 作为 `task_id` 和 `trace_id`，可以通过 `get_device_events` 追踪。
- 预定义场景不含开锁动作；开锁必须经过聊天确认和独立可信认证。

### 门锁可信认证适配器

OpenClaw 插件通过服务端 HTTP 适配器请求可信认证；默认未配置，门锁解锁因此保持 fail-closed。配置项：

- `DEVICE_MANAGER_LOCK_AUTH_URL`：认证服务 HTTPS URL；仅本机回环地址允许 HTTP。
- `DEVICE_MANAGER_LOCK_AUTH_PUBLIC_KEY`：认证服务 Ed25519 公钥 PEM，不是私钥。
- `DEVICE_MANAGER_LOCK_AUTH_ISSUER`：签发者标识。
- `DEVICE_MANAGER_LOCK_AUTH_AUDIENCE`：可选，默认 `lt-agent-device-manager`。

聊天确认后，插件向认证服务发送 `approval_id`、`plan_id`、`plan_fingerprint`、`device_id`、`action: unlock` 和待办到期时间。服务必须自行在可信界面验证用户身份，不得把 PIN 或生物特征回传给 OpenClaw；成功后返回 `{ "proof": "<Ed25519 signed compact JWT>" }`。JWT 需要包含 `iss`、`aud`、`sub`、`jti`、`iat`、`exp`，以及与请求完全一致的 `approval_id`、`plan_id`、`plan_fingerprint`、`device_id`、`action`。授权有效期最多 60 秒。设备管家只配置公钥并在执行写操作前验证，不接收签名私钥。服务缺失、超时、响应无效或验证失败都会停止动作。

当前重放标识在 Gateway 进程内做一次性记录；待审批工作流重启后不会恢复为可执行项。若部署多个 Gateway 实例或要求跨进程共享防重放状态，需要认证服务/平台提供共享的一次性消费机制后再启用开锁。

## 故障诊断

`diagnose_device` 不会修改设备状态。它会检查设备是否可用，以及灯具亮度、空调温度、窗帘开合度、门锁状态等属性是否自洽，并返回 `healthy`（正常）、`offline`（离线）或 `abnormal`（状态异常）及证据。

## 预定义场景

| 场景 | 参数 | 动作 |
| --- | --- | --- |
| 回家模式 | `home` | 客厅灯亮度设为 70、打开窗帘、开启卧室空调并设为 26℃ |
| 睡眠模式 | `sleep` | 关闭客厅灯、关闭窗帘、开启卧室空调并设为 26℃ |
| 离家模式 | `away` | 关闭客厅灯、客厅插座、窗帘和卧室空调 |

## 运行演示

本项目只使用 Node.js 标准库，不需要下载依赖。

```powershell
cd device-manager
npm run demo
```

演示依次执行：列出设备、打开客厅灯、验证状态、拦截未经确认的开锁操作。

验证本次智能插座和统一设备视图：

```powershell
cd device-manager
$env:DEVICE_MANAGER_BACKEND = "mock"
npm run demo:plug
```

该演示会依次展示插座发现、统一设备视图、插座控制回读和离家模式验证。

验证不依赖其他小组的本地编排链路：

```powershell
cd device-manager
$env:DEVICE_MANAGER_BACKEND = "mock"
npm run demo:orchestration
```

`mock-orchestrator.js` 临时扮演编排、安全和云边组，依次输出 `Task`、`PolicyDecision`、
`ResourceStatus`、设备管家执行和回执；演示还会验证重复幂等任务不会再次控制，以及开锁会进入
`CHALLENGE`。后续只需替换这几个 Mock 接口，不需要重写设备管家。

验证独立 Agent 组合工作流的本地安全分支：

```powershell
cd device-manager
npm run demo:independent-agent-chain
```

该演示分别覆盖来源未认证时拒绝、学习事件待复核时不调用能源管家、能源管家返回 `NO_ACTION`，以及能源管家提交关灯候选后由设备管家要求确认。所有 Agent 回复和观测认证都是代码内测试夹具；它不是独立 OpenClaw Agent/DeepSeek 联调。演示使用新建的内存 Mock HA，灯态从初始化开始就是 `on`，不通过控制命令预置；报告应显示 `model_calls: 0`、`device_actions_executed: 0`、各场景 Mock 动作审计为 0，最终灯态仍为 `on`。

验证 A-05 的接口故障联动（缺字段、超时、异常回执）：

```powershell
cd device-manager
npm run demo:interface-faults
```

演示会对照一条成功控制闭环，以及 `ResourceStatus` 缺字段、`PolicyDecision` 超时、设备管家回执
`trace_id` 不匹配三种故障。预期只有正常链路产生一次 Mock 控制；故障路径均返回明确错误且不继续
调用后续阶段。该验收使用进程内 Mock，不代表跨组真实接口已连通。

验证 OpenClaw 调度桥接的最小链路：

```powershell
cd device-manager
$env:DEVICE_MANAGER_BACKEND = "mock"
npm run demo:agent-event
```

验证新家庭设备发现/登记与节能候选筛选（仅 Mock，不控制真实 HA）：

```powershell
cd device-manager
npm run demo:inventory
```

验证设备持续监测基础闭环（仅临时 Mock 数据）：

```powershell
cd device-manager
npm run demo:device-monitor
```

演示会启动模拟监测，模拟一次状态推送漏报，再由周期巡检发现离线设备并产生只读诊断告警；随后模拟设备在监测之外恢复健康，验证活动告警清除并记录脱敏的 `diagnostic_recovered` 事件。之后再模拟三台设备同时离线，验证普通设备告警被合并为一条 `diagnostic_shared_infrastructure_suspected`；共同离线数量减少后，组级提示清除，剩余设备恢复单独跟踪。演示同时确认没有发生控制动作或自动修复。临时数据在演示结束后清理。

预期看到 `status: "SUCCEEDED"`、`agents_involved` 包含
`learning-companion`、`energy-saving`、`device-manager`，以及客厅灯最终为 `off`。

也可在设备管家 OpenClaw 对话中直接用自然语言发起同一条演示链路，例如：
“演示一下孩子离开书桌十分钟后，能源管家如何和设备管家协作关灯。”
Agent 应调用 `run_mock_agent_chain_demo`，并用自然语言总结三个 Agent、任务回执和最终灯态。
该工具始终创建隔离的 Mock HA；工具内部临时生成的占用/学习事件只是合成演示数据，不是摄像头或真实 HA 传感器结果，
也不会控制真实设备。此入口验证“自然语言请求 → OpenClaw 选择工具 → 本地 Mock 多 Agent 链路”，
不代表多个独立 OpenClaw Agent 已通过远程消息互相调用。普通用户设备控制不得调用此演示工具。

验证作息到期事件、本地收件箱和用户确认已读闭环（仅临时数据，不启动定时器）：

```powershell
cd device-manager
npm run demo:routine-reminders
```

预期输出包含 `EVENTS_DELIVERED`、一条 `22:30` 睡前提醒、`ACKNOWLEDGED`，且 `runner_auto_started`、`external_push_sent`、`device_action_performed` 均为 `false`。演示只使用临时记忆和临时收件箱，结束时删除。

验证家庭偏好冲突从查询到设备执行的闭环（仅隔离 Mock）：

```powershell
cd device-manager
npm run demo:preference-conflict
```

演示先生成 `24°C` 已确认偏好与 `25°C` 三日模拟观察冲突，确认 `plan_scene` 返回 `PREFERENCE_CONFLICT` 且不创建计划、不执行动作；模拟用户选择 `25°C` 后重新规划，再模拟用户对完整场景的第二次确认，最后由 Mock HA 执行并逐项回读。该脚本复用 OpenClaw 插件工具函数，但不启动 OpenClaw Gateway、不调用 LLM，也不连接真实 HA；用户选择和确认是脚本夹具，不代表自然语言对话验收。数据存于临时目录并在结束后删除。

## 从 OpenClaw 主对话使用家庭功能

产品演示和日常交互应停留在 OpenClaw 用户主 Agent `dev`：用户直接用自然语言和 OpenClaw 对话，`dev` 通过 `orchestrate_household_agents` 按任务动态选择一个或多个业务 Agent；只有涉及设备查询/控制时才调用设备管家。设备控制、计划确认、设备清单和状态回读仍由设备管家完成；主 Agent 不直接获得设备写工具。

`dev` 应开放 `orchestrate_household_agents`，并按配置允许平台调度器调用相应业务 Agent。旧 `talk_to_device_manager` 仅作兼容，不应再作为主对话路由入口；部署器会在主 Agent 上显式禁用它。跨 Agent 调用仍受 OpenClaw `agentToAgent` 与会话可见性策略约束。隔离 profile 的用户主会话由部署时配置决定，不要误用 `%USERPROFILE%\.openclaw` 下其他版本的配置。

设备验证人员可在 OpenClaw 同一对话中发送“客厅灯现在是什么状态？”或“帮我看下有哪些设备”。若设备管家需要核实信息或明确确认，OpenClaw 会在当前对话中追问；用户正常回复即可继续，不需要提供工具名或计划 ID。

## 直接调试设备管家 Agent（开发排查用）

通常不需要切换到设备管家。仅在开发人员排查子 Agent 工具、工作区说明或 Gateway 配置时，才直接打开 `device-manager` 会话。确保 OpenClaw Gateway 正在运行，然后双击 `Start-Device-Manager.cmd`。也可以在终端执行：

```powershell
openclaw tui --session agent:device-manager:main-v3
```

如果之前打开过 `agent:device-manager:main`，它可能缓存旧的工具列表。关闭旧的 TUI
窗口后，使用上面的新会话名（或双击 `Start-Device-Manager.cmd`）即可加载最新的设备工具和调度工具；
旧会话历史不会被删除。

`device-manager` Agent 必须先通过下面的一次性命令创建；它使用本目录中的独立工作区，
从而能读取设备管家行为规则和 skills。公共任务契约中的
`target_agent: "device-manager"` 与该 Agent id 保持一致。

```powershell
$env:OPENCLAW_STATE_DIR = "$env:USERPROFILE\.openclaw-2026.7.1-2\state"
$env:OPENCLAW_CONFIG_PATH = "$env:USERPROFILE\.openclaw-2026.7.1-2\openclaw.json"
openclaw agents add device-manager --workspace "$env:USERPROFILE\Documents\ChatGPT\LT-agent-program\device-manager\agent-workspace" --model deepseek/deepseek-v4-flash --non-interactive
```

旧版 OpenClaw 的 `coding` 工具配置默认只允许内置文件、Shell、网页和会话工具。
需要在全局插件白名单中启用插件，并在该 Agent 的 `alsoAllow` 中逐项放行要用的工具
（`agents add` 后 `device-manager` 通常是 `agents.list[1]`）：

```powershell
openclaw config set agents.list[1].tools.alsoAllow '["list_devices","get_state","control_device","run_scene","diagnose_device","get_device_events","dispatch_agent_event","submit_agent_plan","resolve_agent_action_confirmation","list_pending_agent_action_confirmations","run_mock_agent_chain_demo","run_mock_household_memory_learning_demo","run_mock_maintenance_reminder_demo","plan_energy_optimization","save_maintenance_schedule","get_device_maintenance_plan","record_device_maintenance_completed","check_maintenance_reminders","start_maintenance_reminders","stop_maintenance_reminders","get_maintenance_reminder_status","list_maintenance_reminders","acknowledge_maintenance_reminder","snooze_maintenance_reminder","get_household_preference","list_household_memories","remember_household_preference","get_household_observation_consent","set_household_observation_consent","get_household_device_action_observation_consent","set_household_device_action_observation_consent","get_household_routine_reminder_consent","set_household_routine_reminder_consent","confirm_household_memory_candidate","preview_household_routine","forget_household_memory","plan_scene","execute_scene_plan","start_household_device_monitor","stop_household_device_monitor","get_household_device_monitor_status"]' --strict-json
openclaw config set plugins.allow '["device-manager","deepseek"]' --strict-json
```

如果手动管理 Agent 权限，将能耗分析工具放给能源管家会话，而不是设备管家。标准部署优先使用仓库安装器，它会同时配置 `analyze_energy_usage`、`evaluate_energy_effect`、`forecast_energy_budget` 和 `calculate_energy_optimization` 的运行时会话限制。

这两条只修改本机 OpenClaw 配置，不会把 API Key 写入项目。修改后重启 Gateway，
重新打开 TUI；设备管家工具列表中应出现六个基础设备工具、`dispatch_agent_event`、三个候选计划/确认工具、三个 Mock 演示工具、四个能耗/维护计划工具和八个维护提醒工具（包含 `snooze_maintenance_reminder`、`archive_completed_maintenance_reminders`），`plan_scene`、`execute_scene_plan`，三个 HA 状态监测工具，以及
`get_household_preference`、`list_household_memories`、`remember_household_preference`、
`get_household_observation_consent`、`set_household_observation_consent`、
`confirm_household_memory_candidate`、`preview_household_routine` 和
`forget_household_memory`。

`plan_scene` 只返回预览；即使返回个性化温度或亮度，也不会自动执行。Agent 必须先展示步骤和目标值，
收到用户后续独立消息中的明确肯定答复（例如“执行吧”）后，再以内部计划 ID 和 `user_confirmed: true` 调用 `execute_scene_plan`。不要向用户显示 ID/UUID，也不要要求照抄固定口令。
该工具重新校验偏好和设备后，才会把确认的温度/亮度传给场景执行器；底层 `run_scene` 仍使用预定义场景参数，
OpenClaw 对话层会拦截 Agent 对它的直接调用。
`user_confirmed` 是 Agent 对后续对话的判断，不是工具可独立验证的用户身份凭据；对真实家庭设备启用前，
仍应评估是否需要 OpenClaw 原生人工审批或独立确认界面。

统一设备动作确认仍由 OpenClaw 解释后续自然语言回复，不是强身份认证。当前插件会把最小化的确认/幂等摘要写入 OpenClaw state 下的 `device-manager/agent-approval-state.json`，不会保存聊天原文、Event 输入、设备证据或任意动作参数。Gateway 重启后，旧待确认项转为 `RECOVERY_REQUIRED`，必须刷新状态并重新规划；若中断发生在执行窗口，则标为 `EXECUTION_UNCERTAIN` 并禁止自动重放，核对设备状态后需用户明确关闭记录。生产部署仍需原生确认界面/身份认证和设备执行结果对账机制。

当前项目按小组要求对齐 OpenClaw `2026.7.1-2`。启动脚本使用独立配置目录
`%USERPROFILE%\.openclaw-2026.7.1-2`，不会复用新版配置。首次使用旧版前，在 PowerShell 执行一次：

手动运行任何 `openclaw` 命令时，每个新的 PowerShell 窗口都要先设置下面两个环境变量；双击
`Start-Device-Manager.cmd` 会自动设置。漏设时 CLI 会回退到默认 `%USERPROFILE%\.openclaw`，而该目录可能由其他版本创建，不能拿它的配置/状态库直接配合 `2026.7.1-2` 使用。

```powershell
$env:OPENCLAW_STATE_DIR = "$env:USERPROFILE\.openclaw-2026.7.1-2\state"
$env:OPENCLAW_CONFIG_PATH = "$env:USERPROFILE\.openclaw-2026.7.1-2\openclaw.json"
$deviceManagerOpenClaw = "C:\Users\QVQ\AppData\Roaming\npm\openclaw.cmd"
& $deviceManagerOpenClaw onboard --mode local --skip-daemon
```

在向导中选择团队确定的模型并在终端直接输入 API Key；不要把 Key 粘贴到聊天或写入项目。
完成后再双击启动脚本。若暂时只验证插件，可以不配置真实 HA，默认仍使用 Mock Home Assistant。

## 运行测试

```powershell
cd device-manager
npm test
```

也可以用一条命令完成全部本地检查：

```powershell
cd device-manager
npm run verify
```

它依次运行设备、调度和家庭记忆测试、Mock 验收、OpenClaw 插件校验和公共契约样例校验。

## 运行一键验收

不安装真实 Home Assistant 也可以运行设备管家 MVP 验收。验收脚本使用项目内置的
Mock Home Assistant，覆盖设备发现、控制后状态验证、回家场景、个性化计划的确认/过期/重校验与执行、
高风险开锁拦截、全量诊断、事件审计和未知设备错误。

```powershell
cd device-manager
npm run acceptance
```

输出中的 `status: "PASS"` 表示当前设备管家 MVP 的虚拟设备链路通过；这不代表真实家具、MQTT
或 Matter 协议已经接入。真实 Home Assistant 接入属于后续适配阶段。

故障回读和事件测试（不需要真实 HA）：

```powershell
cd device-manager
npm test
```

测试包含“服务返回成功但设备状态未改变”“HA 请求超时”“诊断异常告警”和“开锁确认拦截”等情况。
事件账本默认仍是有界进程内存实现，Mock 模式下重启后会清空。若真实 HA 环境希望跨 Gateway 重启保留最近 200 条脱敏事件，可在启动 OpenClaw 的本地环境中显式设置 `DEVICE_MANAGER_EVENT_LEDGER_PATH` 指向本机文件；只有真实 HA 后端会使用该持久账本。日志仅保存动作名、简化前后状态、有限诊断代码、设备实体 ID 和安全格式的 `trace_id`，不保存 API Key、HA 地址、原始 API 报错、任务参数、幂等键、任意摘要或聊天内容。持久日志是本机 JSON、未应用层加密；需纳入本机磁盘/文件访问控制，不要放到 Git、普通云盘或跨设备同步。格式损坏或锁冲突时会失败关闭，不会静默覆盖旧日志。实现与验证边界见 [`docs/persistent-device-event-ledger-v0.1.md`](../docs/persistent-device-event-ledger-v0.1.md)。

## 标准任务入口（公共契约草案）

公共契约草案位于仓库根目录 `common-contracts/`。设备管家当前支持用标准 `Task` 对象调用已有工具，
不需要其他 Agent 已经完成；测试中用 Mock 任务生产者模拟调用。

```powershell
node ..\common-contracts\validate-examples.mjs
npm test
```

例如 `control_device` 任务由 `device-manager/src/task-runtime.js` 转换成设备工具调用，执行后返回统一的
`TaskReceipt`。普通控制返回 `SUCCEEDED`，未知设备返回 `FAILED`，未经确认的开锁返回 `CHALLENGE`。
这份契约目前是 v0.1 讨论稿，需和其他小组确认后再升级为 v1。

同时，任务运行时已经兼容计划中的 `device_action` 任务形态：使用 `target_ref.device_id`、
`action`、`priority: P0-P4`、`data_level: L0-L3`、`trace_id` 和 `idempotency_key`，并在回执的
`result.action_result` 中返回标准动作结果；`task_priority` 会保留 canonical 原值，即使 `P3/P4` 在旧执行字段中都映射为 `low`。重复的幂等键不会再次控制设备；PolicyDecision 为
`DENY` 时不会调用设备工具。

## 切换到真实 Home Assistant

真实适配层使用 Home Assistant REST API。认证信息只通过当前 PowerShell 的环境变量传入，
不要把令牌写入代码、配置文件或 Git。先在 Home Assistant 中创建“长期访问令牌”，然后执行：

```powershell
$env:DEVICE_MANAGER_BACKEND = "home-assistant"
$env:HA_URL = "http://你的HA地址:8123"
$secret = Read-Host "请输入 Home Assistant 长期访问令牌"
$env:HA_TOKEN = $secret
Remove-Variable secret
$env:HA_ENTITY_ALLOWLIST = "light.living_room,climate.bedroom,cover.living_room_curtain,lock.front_door,switch.heater,climate.boiler"
$env:HA_CONFIRMATION_REQUIRED_ENTITIES = "switch.heater,climate.boiler"
```

`HA_ENTITY_ALLOWLIST` 是可选但推荐的安全白名单；`HA_CONFIRMATION_REQUIRED_ENTITIES` 用于把高功率加热设备、燃气/水阀等需确认设备加入确认清单。两者均以英文逗号分隔，后者可不设置。HA 实体若已提供 `risk_level: high/critical` 或 `requires_confirmation: true` 属性，也会进入确认流程。默认会通过 HA WebSocket 查询实体注册表；若部署的反向代理不支持 WebSocket，可设置 `$env:HA_REGISTRY_ENRICHMENT = "false"` 暂时使用 REST-only。Registry 查询失败会降级，不影响 REST 状态读取，但房间建议/物理设备归组不会被伪造。先进行只读连通性检查：

```powershell
npm run ha:check
```

REST 连通后，可在同一 PowerShell 会话启动只读 HA 状态监测冒烟检查（默认监听 30 秒）：

```powershell
$env:HA_MONITOR_SMOKE_DURATION_MS = "30000"
npm run ha:monitor-smoke
```

运行期间可从 HA 界面或实体原有控制方式改变一台测试设备，观察是否收到状态事件以及诊断/恢复记录；脚本自身不会控制设备。报告只包含实体 ID、事件类型和诊断代码等白名单摘要，不输出令牌、原始状态或属性。设备清单写入临时目录并在脚本退出时删除；若监听期间没有设备变化，`observed_state_event_count` 为 0 并不等于连接失败，先确认 `connection_state` 为 `connected`。按 Ctrl+C 可提前结束。

检查通过后，需要在同一个 PowerShell 环境中启动 Gateway，才能继承这些临时环境变量：

```powershell
openclaw gateway run
```

真实后端当前支持灯、开关/插座、空调、窗帘、门锁、普通传感器和二值传感器；设备控制会映射到 HA service，
控制后重新读取实体状态并写入内存审计。上锁须经过 OpenClaw 确认工作流；解锁还需要独立可信认证适配器，场景仍执行全量预检；
个性化温度只有在实时读取到空调上下限且目标值仍在范围内时才会执行。
退出 PowerShell 后临时令牌失效，不会保存到仓库。

## 安装到本机 OpenClaw（开发模式）

在本目录执行：

```powershell
openclaw plugins install --link .
openclaw plugins enable device-manager
openclaw plugins inspect device-manager --runtime
```

本地链接方式便于开发：修改仓库中的工具代码后，不需要重新复制插件包。

## 当前完成边界与下一阶段

本地 Mock、OpenClaw 设备工具、候选 Agent 计划工具、统一确认工作流、`dispatch_agent_event` 调度工具和家庭记忆工具、标准 Task/PolicyDecision
运行时、控制后状态回读、审计事件、故障注入测试和真实 Home Assistant REST 适配层均已完成。
当前开发机的 OpenClaw `2026.7.1-2` 独立 profile 已注册 `device-manager`、`learning-companion` 和 `energy-saving`，并完成学习伴学/节能工作区 Skill 发现核验；其他电脑仍需在各自 profile 中单独注册/重载工作区并确认 Skill 与工具可调用。Agent 注册配置是本机状态，不保存在仓库中。
当前自动事件通道仍缺真实 HA 事件推送/来源认证适配器。收到设备组提供的 HA 地址、长期访问令牌和实体 ID 清单后，先做只读 `npm run ha:check`，再按确认策略联调；不能仅以 Event 字段中的来源名判定事件可信。
跨组正式协议冻结前，继续使用 Mock 编排器，不把未验证视觉判断直接接入真实设备。
设备管家已经具备独立 Agent 工作区，以及“接收 → 理解 → 规划 → 审批 →
执行 → 验证 → 总结”的行为规则。

维护周期与异常排查规划器位于 `src/maintenance-planner.js`；日程和完成记录持久化到 OpenClaw 本机状态目录。另有本地提醒收件箱：`check_maintenance_reminders` 可按需检查，周期检查只有在本机 `DEVICE_MANAGER_MAINTENANCE_REMINDERS_ENABLED=true` 且用户明确调用 `start_maintenance_reminders` 后才会启动；插件加载默认不会启动。用户明确选择 `resume_after_gateway_restart: true` 后，插件后台服务可在 Gateway 进程重启时恢复检查；用户停止提醒会撤销恢复授权。它不负责启动 Gateway/Windows 计划任务。提醒仅进入本地收件箱，不发手机/外部通知，标记已读也不等于维护完成。接口与边界见 [`../docs/energy-operations-openclaw-tools-and-maintenance-store-v0.1.md`](../docs/energy-operations-openclaw-tools-and-maintenance-store-v0.1.md) 和 [`../docs/maintenance-reminder-inbox-v0.1.md`](../docs/maintenance-reminder-inbox-v0.1.md)。
