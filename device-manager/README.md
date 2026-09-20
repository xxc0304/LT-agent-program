# 设备管家 Agent（第一阶段）

这是家庭微脑项目的设备管理基础模块。默认使用 Mock Home Assistant 模拟设备，并提供六个
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

## 六个设备工具

- `list_devices`：获取设备列表，可按 `domain` 过滤。
- `get_state`：查询一个设备的当前状态。
- `control_device`：执行控制并返回控制前后的状态。
- `run_scene`：执行预定义的“回家模式”或“睡眠模式”，并返回逐项执行和状态验证结果。
- `diagnose_device`：诊断指定设备或全部设备，只读返回在线状态、属性异常证据和处理建议。
- `get_device_events`：按设备、`trace_id`、事件类型和数量查询动作、失败和诊断告警事件。

传感器使用 `get_state` 读取，不作为可控制设备；温湿度传感器会校验数值范围，人体、门磁和烟雾传感器会校验 `on/off` 状态。

工具定义在 `src/tools.js`，模拟 Home Assistant 的行为在 `src/mock-ha.js`。

`src/openclaw-plugin.js` 是 OpenClaw 适配层，插件清单位于
`openclaw.plugin.json`。六个工具共享同一个 Home Assistant 后端实例，
因此 Agent 控制设备后能再次读取并验证变化。

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

## 打开设备管家对话

确保 OpenClaw Gateway 正在运行，然后双击 `Start-Device-Manager.cmd`。也可以在终端执行：

```powershell
openclaw tui --session agent:device-manager:main-v2
```

如果之前打开过 `agent:device-manager:main`，它可能缓存旧的工具列表。关闭旧的 TUI
窗口后，使用上面的新会话名（或双击 `Start-Device-Manager.cmd`）即可加载最新的六个设备工具；
旧会话历史不会被删除。

`device-manager` Agent 必须先通过下面的一次性命令创建；它使用本目录中的独立工作区，
从而能读取设备管家行为规则和 skills。公共任务契约中的
`target_agent: "device-manager"` 与该 Agent id 保持一致。

```powershell
$env:OPENCLAW_STATE_DIR = "$env:USERPROFILE\.openclaw-2026.7.1-2\state"
$env:OPENCLAW_CONFIG_PATH = "$env:USERPROFILE\.openclaw-2026.7.1-2\openclaw.json"
openclaw agents add device-manager --workspace "$env:USERPROFILE\Documents\ChatGPT\LT-agent-program\device-manager\agent-workspace" --model deepseek/deepseek-v4-flash --non-interactive
```

旧版 OpenClaw 的 `coding` 工具配置默认只允许内置文件、Shell、网页和会话工具，
因此还要给这个 Agent 显式授权本项目插件（`agents add` 后 `device-manager` 通常是
`agents.list[1]`）：

```powershell
openclaw config set agents.list[1].tools.alsoAllow '["device-manager"]' --strict-json
openclaw config set plugins.allow '["device-manager","deepseek"]' --strict-json
```

这两条只修改本机 OpenClaw 配置，不会把 API Key 写入项目。修改后重启 Gateway，
重新打开 TUI；工具列表中应出现 `list_devices`、`get_state`、`control_device`、
`run_scene`、`diagnose_device` 和 `get_device_events`。

当前项目按小组要求对齐 OpenClaw `2026.7.1-2`。启动脚本使用独立配置目录
`%USERPROFILE%\.openclaw-2026.7.1-2`，不会复用新版配置。首次使用旧版前，在 PowerShell 执行一次：

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

它依次运行 50 项测试、9 项 Mock 验收、OpenClaw 插件校验和 4 个公共契约示例校验。

## 运行一键验收

不安装真实 Home Assistant 也可以运行设备管家 MVP 验收。验收脚本使用项目内置的
Mock Home Assistant，覆盖设备发现、控制后状态验证、回家场景、高风险开锁拦截、全量诊断、事件审计和未知设备错误。

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
`result.action_result` 中返回标准动作结果。重复的幂等键不会再次控制设备；PolicyDecision 为
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
控制后重新读取实体状态并写入内存审计。开锁仍强制要求 `confirmed=true`，场景仍执行全量预检。
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

本地 Mock、OpenClaw 六个工具、标准 Task/PolicyDecision 运行时、控制后状态回读、审计事件、
故障注入测试和真实 Home Assistant REST 适配层均已完成。下一步只剩跨组联调：等待设备组提供
HA 地址、长期访问令牌和实体 ID 清单后，先做只读 `npm run ha:check`，再做低风险灯/插座控制；
门锁等高风险设备仍需人工确认。跨组正式协议冻结前，继续使用 Mock 编排器，不把未验证视觉判断
直接接入真实设备。
设备管家已经具备独立 Agent 工作区，以及“接收 → 理解 → 规划 → 审批 →
执行 → 验证 → 总结”的行为规则。
