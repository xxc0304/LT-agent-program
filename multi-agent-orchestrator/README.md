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

第一版使用确定性规则和 Mock 执行节点，后续可替换为消息队列、真实 ResourceStatus 和其他小组的 Agent，不改变事件和任务边界。

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
