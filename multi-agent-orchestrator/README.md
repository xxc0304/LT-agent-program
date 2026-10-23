# 多 Agent 调度器 MVP

这是家庭微脑项目的最小多 Agent 调度层。它不是对 OpenClaw 的替代，而是把本项目的业务规则落在 OpenClaw 之上：事件路由、任务优先级、幂等、重试和运行链路记录。

## 当前链路

```text
learning-companion 学习伴学 Agent
        ↓ learning_behavior Event
multi-agent-orchestrator
        ↓ 调用 energy-saving
energy-saving 节能 Agent
        ↓ device_action Task
device-manager 设备管家 Agent
        ↓
Mock Home Assistant
```

## 组件

- `src/learning-agent.js`：把单行为结果或试验性的课堂场景结果转换为 `learning_behavior` Event；节能 Agent 只采用先前实际路由到自身的可信 HA 无人事件作独立佐证，不读取模型在 payload 中自报的传感器证明；
- 单张图片固定标记为 `needs_review: true`、`duration_ms: 0`；多帧接口只根据输入帧的真实时间戳计算跨度，默认至少 6 帧、跨度不少于 10 分钟、相邻帧间隔不超过 2 分钟，且 80% 高置信度在位结果一致，才确认稳定在位状态；
- `src/scheduler.js`：注册 Agent、按事件路由、按优先级/截止时间排序、处理幂等、重试和 trace；
- `src/openclaw-agent-client.js`：独立 OpenClaw Agent 的调用边界；严格解析并校验 Event/Task JSON、来源/目标 Agent 和 trace，处理超时、敏感字段与幂等键；
- `src/openclaw-gateway-transport.js`：适配 OpenClaw 2026.7.1-2 插件公开的 `runtime.subagent.run` / `waitForRun` / `getSessionMessages` 链路；固定子 Agent 白名单，调用前执行 A2A 与会话可见性校验，超时后不自动重发；
- `../device-manager/src/independent-learning-energy-workflow.js`：将结构化学习观测依次交给独立学习伴学/节能 Agent；以本地认证回调、事件一致性、时效、置信度、目标范围和复核状态作为代码门禁；
- `../docs/agent-trigger-and-memory-policy.md`：事件来源/Agent 触发矩阵和家庭记忆边界；
- `../agent-memory/`：家庭偏好本地存储服务，由设备管家 OpenClaw 插件提供读写工具；
- `src/demo.js`：完整 Mock 演示；
- `src/demo-scene-review.js`：课堂场景观察结果的本地模拟演示，预期安全地不触发设备动作；
- `src/replay-scene-pilot.js`：将本地已保存预测离线回放到 Event/Agent 链路，不加载原图、不调用模型；
- `test/scheduler.test.js`、`test/scene-pilot-replay.test.js`：端到端、低置信度拦截、课堂场景保护、回放、优先级、幂等、重试和 Agent 不可用测试。

## 运行

```powershell
Set-Location C:\Users\QVQ\Documents\ChatGPT\LT-agent-program\multi-agent-orchestrator
npm test
npm run demo
npm run demo:scene-review
npm run replay:scene-pilot
```

演示会模拟学习伴学 Agent 输出“孩子高置信度站立且已离开书桌 10 分钟”，然后由调度器调用节能 Agent 生成关灯任务，最后交给设备管家 Agent 执行并回读状态。

`npm run demo:scene-review` 则模拟一份课堂场景视觉结果，展示它如何进入学习伴学 Event、被节能 Agent 接收后忽略，最终不派发设备任务且 Mock 灯保持开启。该演示使用桩结果，不需要图片、API Key 或真实 Home Assistant，也不证明视觉模型本身的识别能力。

`npm run replay:scene-pilot` 会读取本机已有的 5 条获批模型预测（默认路径为 `learning-behavior/data/scb/results/scene-pilot-2026-09-27-predictions-approved.jsonl`），经当前 Event 适配器和调度器离线回放；没有该本地文件时可用 `--predictions <JSONL路径>` 指定。它应报告 5/5 进入复核、5/5 节能 Agent 不动作、0 个设备任务，且 Mock 灯保持开启。需要保存结果时可运行：

```powershell
npm run replay:scene-pilot -- --out ..\learning-behavior\data\scb\results\scene-pilot-agent-replay-2026-09-27.json
```

这份回放只检验当前 Agent 适配与安全规则，不重新计算视觉识别准确率。

### OpenClaw 独立 Agent Gateway 调用边界

用户不需要进入业务 Agent 会话。用户主 Agent `dev` 通过 `orchestrate_household_agents` 理解需求并动态选择已登记 Agent；只有涉及设备操作时才调用设备管家。旧的 `talk_to_device_manager` 固定转发工具仅保留兼容实现，部署器会在主 Agent 上显式禁用，主 Agent 指令不得要求调用它。

设备管家插件提供 `call_independent_agent`：由 OpenClaw 7.1 ToolPluginFactory 注入可信的 `agentId`、`sessionKey` 和活动配置；工具仅在 `device-manager` 会话注册，目标限 `learning-companion` / `energy-saving`。传输先用 OpenClaw 公共策略检查 A2A 白名单和会话可见性，再通过插件公开的 `runtime.subagent.run` 启动、`waitForRun` 等待、`getSessionMessages` 读取本轮新回复。普通本地插件不能调用受限的 `runtime.gateway.request`（该接口仅供内置/受信任官方插件）；因此不得通过把项目插件伪装成官方插件来绕过权限边界。

客户端只允许学习伴学 Agent 返回 Event、或节能 Agent 返回 Task/严格的 `NO_ACTION` 结果；回复必须是严格 JSON，并通过公共契约 schema、来源/目标 Agent 和相同 `trace_id` 校验。输入拒绝认证信息及原始图片/视频字段；幂等键传递给运行时；发起 run 后的超时/错误不会自动重试。通用 `call_independent_agent` 只返回候选结果；另有 `evaluate_energy_event_with_independent_agent` 会把标准 Event 交给独立节能 Agent：`NO_ACTION` 正常结束、不创建计划；Task 则送入设备管家 `executeEnergyTask`，由其重读设备清单和状态、建立计划并走原有确认/执行/回读流程。对话工具输入不是已认证传感器事件，因此 Task 不获得可信事件自动执行资格。此接入使用设备管家计划策略工作流，不代表它已进入 `MultiAgentScheduler` 的内存事件队列。

**2026-10-15 状态更新：**独立节能 Agent 调用链已在隔离 OpenClaw `2026.7.1-2` profile 上完成一次 DeepSeek V4 Flash 合成联调，返回 `NO_ACTION / OCCUPANCY_NOT_CONFIRMED`，没有创建设备计划或执行设备动作。此前“仅 fake Gateway、未触发真实 Agent”的描述属于较早阶段记录，已由本仓库 `docs/openclaw-independent-agent-orchestration-v0.1.md` 的 2026-10-15 根因修复与复验记录取代。真实 HA、传感器和家电仍未联调。

学习伴学→节能的独立 Agent 组合工作流已补上 Node.js 层的结构化观测认证入口、Event 一致性校验、置信度/复核/课堂范围/持续时间/时效门禁与跨 Agent trace/幂等。它目前尚未注册成对话工具：本机还没有能向该入口提供“由受信任视觉/传感器适配器认证”的真实结构化观测源，聊天文字和工具参数不能自行获得此认证。相关本地测试不调用模型、不连接 HA。

## 接入真实视觉识别

现有 `learning-behavior/src/vision.js` 的 DeepSeek 兼容客户端可以直接注入：

```js
import { createDeepSeekVisionClient } from "../../learning-behavior/src/vision.js";
import { LearningCompanionAgent } from "./src/learning-agent.js";

const visionClient = await createDeepSeekVisionClient();
const learningAgent = new LearningCompanionAgent({ visionClient });
const singleFrameEvent = await learningAgent.analyzeImage("path/to/image.jpg", {
  area: "living_room",
});

// 单张图片不能证明持续时间，事件会进入人工复核，不能触发自动节能控制。
// 以下时间仅说明字段格式；真实运行必须换成实际采集时间。
const sequenceEvent = await learningAgent.analyzeSequence([
  { imagePath: "path/to/frame-1.jpg", capturedAt: "2026-09-24T12:00:00Z" },
  { imagePath: "path/to/frame-2.jpg", capturedAt: "2026-09-24T12:02:00Z" },
  { imagePath: "path/to/frame-3.jpg", capturedAt: "2026-09-24T12:04:00Z" },
  { imagePath: "path/to/frame-4.jpg", capturedAt: "2026-09-24T12:06:00Z" },
  { imagePath: "path/to/frame-5.jpg", capturedAt: "2026-09-24T12:08:00Z" },
  { imagePath: "path/to/frame-6.jpg", capturedAt: "2026-09-24T12:10:00Z" },
], { area: "living_room" });
```

图片只在视觉客户端请求阶段使用，不会写入跨 Agent Event。行为标签和在位状态分开判断：`standing` 本身不会触发关灯；稳定多帧视觉离位、此前 60 秒内实际收到的同区域 HA 无人事件、时长与置信度门槛几项同时成立后，才会进入节能规则。来源未列入白名单、区域不匹配或传感器事件过期时失败关闭；伪造学习事件 payload 不能自带佐证。白名单必须由受信任运行时配置；真实系统还要认证事件来源，单凭 Event 中的字符串不能证明身份。该佐证只缓存在当前 Agent 进程，重启后清空。

因此，独立 `occupancy_changed` 事件必须先被同一个调度器/节能 Agent 实例处理，再送入学习事件；进程默认没有可信来源白名单时只会观察、不执行学习触发的动作。`npm run demo` 使用的是明确配置白名单和 Mock HA 事件的本地演示，不代表真实传感器已接入。

### 课堂场景结果如何进入 Agent

`LearningCompanionAgent.analyzeSceneImage()` 是给当前 SCB 课堂场景试验用的适配入口：它用 `learning-behavior/src/scene-vision.js` 的提示词识别 `activity[]`、`posture`、`orientation`，再形成带 `annotation_scope: "classroom_scene"` 的 Event。它明确不是目标儿童识别：`target_child_specified: false`、`presence: "unknown"`、`duration_ms: 0`、`needs_review: true`；原始图片路径不会进入 Event。格式缺字段或标签无效时会保守映射为 `unknown` 并附复核原因。

节能 Agent 有额外的范围保护：课堂整体 Event 不作为儿童离位信号，不生成设备任务，即便事件其他字段意外带有 `away_from_desk` 或较长持续时间。当前只是本地探索适配，不代表跨组公共契约已经定稿。

运行 `npm test` 可在本地用模拟视觉结果验证“场景识别结果 → Event → 调度器 → 节能 Agent 明确不动作”；这些测试不发送图片、不调用 DeepSeek，也不会操作真实设备。

也可以使用真实视觉接口跑一张图片（只需在当前 PowerShell 临时设置 Key，不要写入文件）：

```powershell
$key = Read-Host "请输入 DeepSeek API Key"
$env:DEEPSEEK_API_KEY = $key
Remove-Variable key
$env:DEEPSEEK_MODEL = "deepseek-v4-flash-vision-exp"
node src/run-image.js "..\learning-behavior\data\scb\images\reading\示例.jpg" living_room
```

该单图命令会调用一次真实视觉模型并显示识别事件和调度 trace，但事件固定需要人工复核，设备执行仍使用 Mock HA，不会因为单帧自动关灯。模型 API 每分析一帧都会产生一次请求和可能的费用。

若要测试多帧时间窗，请准备本地 JSON 清单，图像路径相对于清单文件：

```json
{
  "area": "living_room",
  "frames": [
    { "image": "frame-1.jpg", "captured_at": "2026-09-24T12:00:00Z" },
    { "image": "frame-2.jpg", "captured_at": "2026-09-24T12:02:00Z" },
    { "image": "frame-3.jpg", "captured_at": "2026-09-24T12:04:00Z" },
    { "image": "frame-4.jpg", "captured_at": "2026-09-24T12:06:00Z" },
    { "image": "frame-5.jpg", "captured_at": "2026-09-24T12:08:00Z" },
    { "image": "frame-6.jpg", "captured_at": "2026-09-24T12:10:00Z" }
  ]
}
```

上面的时间仅为格式示例，运行前必须替换成这批图像实际采集时间，并确保末帧是在最近 5 分钟内采集的。默认需要至少 6 帧、相邻帧间隔不超过 2 分钟、总跨度不少于 10 分钟。然后运行 `node src/run-sequence.js <清单路径>`。该脚本逐帧调用视觉模型，按真实时间戳计算观察跨度；只有满足样本数、时间跨度、最大帧间隔和一致性阈值时，才可能产生节能任务。每一帧都会发送到配置的 DeepSeek 视觉接口并产生一次 API 请求；只使用许可和隐私审批允许外发的图片，勿上传可识别的私人儿童画面。设备执行仍只发生在 Mock HA。不要为测试伪造时间戳或把儿童图片提交到仓库。

节能 Agent 另会拒绝超过 5 分钟的旧事件和超出 1 分钟时钟偏差的未来事件；`occurred_at` 表示事件确认/产生时刻，行为持续时间应单独由多帧时间戳计算。

## 调度规则

1. `P0` 优先于 `P1`，依次优先于 `P2`、`P3`、`P4`；同优先级按截止时间排序；
2. 同一个 `event_id` 的同内容事件只路由一次；同 ID 不同内容会拒绝并记录 `EVENT_ID_CONFLICT`；
3. 同一个 `idempotency_key` 只进入一次队列；如果复用键但任务内容不同，拒绝并记录 `IDEMPOTENCY_KEY_CONFLICT`；
4. 本地 MVP 将 `deadline_ms` 解释为“从首次入队起允许的最大毫秒数”；过期任务不会派发，会收到 `TIMEOUT / DEADLINE_EXCEEDED`。这一定义仍需与其他组确认后才能升级为公共契约；
5. `RETRYABLE` 表示目标 Agent 明确返回可安全重试；调度器生成的执行超时默认为不可重试，因为设备动作可能已经发生但回执未返回。只有 Agent manifest 声明 `timeout_retry_safe: true` 才允许超时后重试；普通抛错也不自动重试；
6. `handlerTimeoutMs` 和 `taskTimeoutMs` 可单独配置。超时无法取消正在运行的 Agent 代码，所以 trace 会记录 `side_effects_unknown: true`，这不是设备动作回滚保证；
7. 目标 Agent 不可用时返回失败回执；
8. 每次事件、Agent 调用、任务入队、任务派发、重试和任务完成都写入同一个 `trace_id`；
9. 学习伴学 Agent 只产生事件，节能 Agent 只生成任务，设备管家 Agent 才能执行设备动作。
10. 同一设备、同一互斥动作组的待执行任务会进行冲突仲裁：优先级更高的任务胜出并使较低优先级任务以 `TASK_SUPERSEDED_BY_HIGHER_PRIORITY` 结束；同优先级互斥任务全部拒绝执行并记录 `TASK_CONFLICT`。默认冲突组覆盖电源、门锁、位置、温度、亮度、色温、HVAC 模式和风速；其他动作可通过 Task `metadata.conflict_group` 声明共享冲突组，未声明时仅相同动作名互相冲突；

第一版使用确定性规则和 Mock 执行节点，后续可替换为消息队列、真实 ResourceStatus 和其他小组的 Agent，不改变事件和任务边界。

冲突仲裁只针对尚在本地队列中的任务，不撤销已经开始执行的物理动作；冲突组映射及“同优先级全部拒绝”的策略是 A-09 本地 MVP 约定，须在接入其他组 Task/PolicyDecision 后共同评审。它不是基于 LLM 的动态 Agent 选择或完整多目标调度算法。

## OpenClaw 注册与仓库 Mock 调度的区别

本机 OpenClaw profile 中注册 `learning-companion`、`energy-saving`、`device-manager`，只说明 OpenClaw
知道这些 Agent 工作区及其配置；通过 `skills list` 发现 Skill，也只证明 Skill 文件可见。
它们本身不证明独立 Agent 间已经互相调用或通过远程消息总线通信。

本目录的 `npm test` 和 `npm run demo` 在一个 Node.js 进程中直接实例化学习伴学桩、节能规则 Agent、
调度器、设备管家运行时和 Mock Home Assistant。Demo 的 `registered_agents` 是这个临时调度器里的注册项，
不是 `openclaw agents list` 的输出；学习伴学在该 Demo 中是事件来源/模拟分析器，节能与设备管家是本地处理器。
因此 Demo 能证明当前规则与结构化接口闭环可重复，不证明 OpenClaw Gateway 实际调用了三个独立 Agent，
也不使用真实模型 API、HA 或家具。

设备管家 OpenClaw 插件提供 `dispatch_agent_event` 作为 Gateway 工具入口；实际从 OpenClaw 对话调用该工具，
和直接运行 `node src/agent-event-demo.js` 是不同的验收证据。前者验证 Gateway/插件工具接入，后者只验证同一
进程内桥接逻辑和 Mock 设备结果。

超时与截止时间测试覆盖了不自动重试的副作用不确定场景。`npm test` 可验证重复投递、ID 冲突、过期任务及超时重试策略。

## 平台级 OpenClaw 多 Agent 编排入口（新增）

上面既有的 `MultiAgentScheduler` 和设备管家内部 OpenClaw 工具仍用于原有事件链路。本项目另增加平台级入口，避免把设备管家误当成总调度器：

```text
OpenClaw 主对话模型
  → orchestrate_household_agents（本平台插件）
  → 登记表/能力校验/依赖调度/冲突与澄清门
  → 一个或多个已登记 Agent 的 OpenClaw Gateway 会话
  → 汇总结果回到 OpenClaw 主对话
```

- `src/platform-agent-registry.js` 登记 Agent 及其能力；未登记 ID 或能力不能调用。新增只读/规划 Agent 可通过插件 `additionalAgents` 配置登记。只有 `device-manager` 可声明 `device_action` 能力。
- `src/platform-orchestrator.js` 根据 OpenClaw 提交的计划校验步骤和依赖；不同 Agent 的独立分析可以并发，同一 Agent 会话串行。一个请求中的多项设备操作必须合并成一个设备管家步骤；若错误拆成多个步骤，平台在任何 Agent 调用前拦截，OpenClaw 可自动合并重提一次。
- `src/openclaw-platform-adapter.js` 使用 OpenClaw `runtime.subagent` 公共运行接口，并检查 Agent-to-Agent 白名单和会话可见性；适配器不连接 HA，不自动重试已发送但结果不明的调用。
- `src/openclaw-platform-plugin.js` 向配置的用户主 Agent（默认 `dev`）提供 `orchestrate_household_agents` 工具。OpenClaw 现有模型负责理解自然语言和提出计划；插件不新增 DeepSeek API。
- OpenClaw 可提交 `dispatch`、`clarify` 或 `unsupported` 决定：信息不足时自然语言追问；没有已登记能力时明确说明暂不支持；即便模型误写了未登记的 Agent/能力，也会在任何 Agent/Gateway 调用前返回 `UNSUPPORTED`。这些路径不会猜造能力或执行设备动作。
- 用户目标不清、设备动作冲突或业务 Agent 要求确认时，工具返回结构化问题/状态并停止后续步骤；OpenClaw 再用自然语言询问用户。仅计划错误地拆分设备动作时，OpenClaw 可按工具返回的专用结构码合并后自动重提一次，无需把内部错误暴露给用户。用户回复后应提交新计划；此 MVP 不跨 Gateway 重启恢复待答计划。
- 设备管家的原 `talk_to_device_manager` 仍保留供旧部署兼容；部署器会在主 Agent 上显式禁用它，并只允许使用 `orchestrate_household_agents`，避免固定直达设备管家的旧路径。

见 [`docs/openclaw-platform-multi-agent-orchestration-v0.1.md`](../docs/openclaw-platform-multi-agent-orchestration-v0.1.md) 获取完整流程与边界。运行新增 Mock 验证：

```powershell
node --test test/platform-orchestrator.test.js test/openclaw-platform-adapter.test.js
```

这组测试使用模拟 Agent/Gateway，不表示新插件已经安装到实际 OpenClaw Gateway。部署还需安装本插件、授权 OpenClaw A2A/会话可见性，并在 `dev` 上确认工具可见；Gateway 实际调用测试需在安装后单独完成。
