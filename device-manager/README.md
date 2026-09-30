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

- `list_devices`：获取设备列表，可按 `domain` 过滤。
- `get_state`：查询一个设备的当前状态。
- `control_device`：执行控制并返回控制前后的状态。
- `run_scene`：固定参数场景执行器；OpenClaw 对话层会拦截直接调用，用户场景统一走预览和确认流程。
- `diagnose_device`：诊断指定设备或全部设备，只读返回在线状态、属性异常证据和处理建议。
- `get_device_events`：按设备、`trace_id`、事件类型和数量查询动作、失败和诊断告警事件。
- `dispatch_agent_event`：将标准 Event 交给本地调度器，由节能 Agent 规划，再由设备管家执行并回读；不接收图片或 API Key。
- `get_household_preference` / `list_household_memories`：只读取已确认的本地温度/作息偏好；候选默认不进入偏好查询。
- `remember_household_preference`、`propose_household_memory_candidate`、`confirm_household_memory_candidate`、`forget_household_memory`：显式保存、接收授权的结构化作息观察、用户确认和删除。作息观察须提供事件 ID、带时区的发生时间、家庭 IANA 时区、置信度和授权；工具由代码计算本地日期并按 15 分钟归并，至少三个不同本地日期后才形成候选。不要从普通聊天或图片推测作息；未确认候选不能用于计划或控制。
- `preview_household_routine`：读取已确认的睡觉/起床偏好，产出只读提醒建议；不创建时钟任务，也不控制设备。
- `plan_scene`：只读预览回家、睡眠或离家场景；卧室舒适温度偏好只有在已确认且落在设备温控范围内时才作为建议参数，不执行控制。
- `execute_scene_plan`：仅在用户看到完整计划并于后续消息原样发送一次性确认口令后，重新校验偏好和设备、执行计划并逐项回读；计划十分钟过期、只能使用一次，Gateway 重启会使未完成计划失效。

传感器使用 `get_state` 读取，不作为可控制设备；温湿度传感器会校验数值范围，人体、门磁和烟雾传感器会校验 `on/off` 状态。

工具定义在 `src/tools.js`，模拟 Home Assistant 的行为在 `src/mock-ha.js`。

`src/openclaw-plugin.js` 是 OpenClaw 适配层，插件清单位于
`openclaw.plugin.json`。六个设备工具和 `dispatch_agent_event` 共享同一个 Home Assistant 后端实例，
因此跨 Agent 任务控制设备后能再次读取并验证变化。

`dispatch_agent_event` 的边界是：学习伴学 Agent 产生 `learning_behavior` Event，节能 Agent 只生成
`device_action` Task，设备管家才执行动作。当前调度器和设备后端仍是进程内 Mock/本地实现，真实 HA 联调前先用
`npm test` 和 `npm run demo` 验证链路。

学习行为触发节能动作时，节能 Agent 必须先实际收到同区域、60 秒内、来源列入运行时白名单的 HA `occupancy_changed` 无人事件；它只把这个已路由事件缓存在当前进程中，不信任学习模型在 payload 里自报的佐证。OpenClaw 插件默认不信任任何占用来源，因此没有真实适配器认证和显式配置时，视觉事件不会单独触发设备动作。当前 `agent-event-demo.js` 的白名单与占用事件均为本地 Mock，不代表已连接真实传感器。

## OpenClaw Skills

设备管家工作区的 `skills/` 包含只读查询 `device-status`、设备控制 `device-control`、场景控制
`scene-control`、只读故障诊断 `fault-diagnosis` 和记忆治理 `household-preferences`。节能和学习伴学工作区模板分别包含
`energy-planning` 与 `learning-behavior-review`。Skill 是操作流程与安全边界说明，不替代
`src/` 中的实际业务逻辑和工具；尤其学习 Skill 不能代替视觉模型，节能 Skill 也不能越过设备管家直接执行。

家庭记忆 API 位于 `agent-memory/`，默认存入本机应用数据目录；未确认推测不得用于设备控制。当前 JSON 文件没有应用层加密，不应放进仓库、云盘或跨设备同步。

## 安全规则

第一版已经在工具代码中强制实施以下规则：

- 不存在的设备不能控制。
- 离线设备不能控制。
- 参数超出范围时拒绝执行。
- 入户门锁的 `unlock` 操作必须传入 `confirmed: true`。
- 成功的控制操作写入内存审计日志。
- 控制请求完成后必须回读状态；服务请求成功但状态未达到目标时返回
  `POST_ACTION_VERIFICATION_FAILED`，不会伪装成成功。
- 成功控制结果带有 `verified: true` 和 `verification_required: true`，同时写入
  `action_executed` 事件；失败、超时和状态不一致写入 `action_failed` 事件。
- 诊断发现离线或状态异常时写入 `diagnostic_alert` 事件；事件携带 `trace_id`，便于和公共 Task 关联。
- 场景执行前会完整检查目标设备是否可用，避免设备离线造成“半个场景”被执行。
- 个性化计划执行前会再次读取偏好和设备条件；计划内容或可用条件变化、设备离线或温控范围未知时拒绝执行。
- 确认后的个性化温度只允许替换预定义场景中的空调设定温度，不允许模型临时拼装其他动作。
- 场景执行审计会携带计划 ID 作为 `task_id` 和 `trace_id`，可以通过 `get_device_events` 追踪。
- 预定义场景不含开锁动作；开锁仍必须由用户单独明确确认。

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

预期看到 `status: "SUCCEEDED"`、`agents_involved` 包含
`learning-companion`、`energy-saving`、`device-manager`，以及客厅灯最终为 `off`。

## 打开设备管家对话

确保 OpenClaw Gateway 正在运行，然后双击 `Start-Device-Manager.cmd`。也可以在终端执行：

```powershell
openclaw tui --session agent:device-manager:main-v2
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
openclaw config set agents.list[1].tools.alsoAllow '["list_devices","get_state","control_device","run_scene","diagnose_device","get_device_events","dispatch_agent_event","get_household_preference","list_household_memories","remember_household_preference","propose_household_memory_candidate","confirm_household_memory_candidate","preview_household_routine","forget_household_memory","plan_scene","execute_scene_plan"]' --strict-json
openclaw config set plugins.allow '["device-manager","deepseek"]' --strict-json
```

这两条只修改本机 OpenClaw 配置，不会把 API Key 写入项目。修改后重启 Gateway，
重新打开 TUI；工具列表中应出现六个设备工具、`dispatch_agent_event`、`plan_scene`、`execute_scene_plan`，以及
`get_household_preference`、`list_household_memories`、`remember_household_preference`、
`propose_household_memory_candidate`、`confirm_household_memory_candidate`、`preview_household_routine` 和
`forget_household_memory`。

`plan_scene` 只返回预览；即使返回个性化温度，也不会自动执行。Agent 必须先展示步骤和温度，
要求用户在后续单独一条消息中原样发送 `confirmation_phrase`，然后才调用 `execute_scene_plan`。
该工具重新校验偏好和设备后，才会把确认温度传给场景执行器；底层 `run_scene` 仍执行固定参数，
OpenClaw 对话层会拦截 Agent 对它的直接调用。
确认口令仅为工具层防误触与过期保护，不是独立于 Agent 的强身份认证；对真实家庭设备启用前，
仍应评估是否需要 OpenClaw 原生人工审批或独立确认界面。

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
事件账本当前为进程内存实现，重启后不会保留；后续接入统一日志或消息队列时，只需替换
`src/events.js` 的存储实现，事件字段和 `get_device_events` 工具保持不变。

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
$env:HA_ENTITY_ALLOWLIST = "light.living_room,climate.bedroom,cover.living_room_curtain,lock.front_door"
```

`HA_ENTITY_ALLOWLIST` 是可选但推荐的安全白名单，多个实体 ID 用英文逗号分隔。先进行只读连通性检查：

```powershell
npm run ha:check
```

检查通过后，需要在同一个 PowerShell 环境中启动 Gateway，才能继承这些临时环境变量：

```powershell
openclaw gateway run
```

真实后端当前支持灯、空调、窗帘、门锁、普通传感器和二值传感器；设备控制会映射到 HA service，
控制后重新读取实体状态并写入内存审计。开锁仍强制要求 `confirmed=true`，场景仍执行全量预检；
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

本地 Mock、OpenClaw 设备工具、`dispatch_agent_event` 调度工具和家庭记忆工具、标准 Task/PolicyDecision
运行时、控制后状态回读、审计事件、故障注入测试和真实 Home Assistant REST 适配层均已完成。
当前开发机的 OpenClaw `2026.7.1-2` 独立 profile 已注册 `device-manager`、`learning-companion` 和 `energy-saving`，并完成学习伴学/节能工作区 Skill 发现核验；其他电脑仍需在各自 profile 中单独注册/重载工作区并确认 Skill 与工具可调用。Agent 注册配置是本机状态，不保存在仓库中。
随后等待设备组提供 HA 地址、长期访问令牌和实体 ID 清单；拿到后先做只读 `npm run ha:check`，再做低风险灯/插座控制。门锁等高风险设备仍需人工确认。
跨组正式协议冻结前，继续使用 Mock 编排器，不把未验证视觉判断直接接入真实设备。
设备管家已经具备独立 Agent 工作区，以及“接收 → 理解 → 规划 → 审批 →
执行 → 验证 → 总结”的行为规则。
