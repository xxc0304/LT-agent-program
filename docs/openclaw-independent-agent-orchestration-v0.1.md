# OpenClaw 独立 Agent 协作接入方案 v0.1

> **历史方案，已被平台级动态编排取代。** 本文记录较早的固定转发结构（`dev` → `talk_to_device_manager`）；当前实现和部署以 [`openclaw-platform-multi-agent-orchestration-v0.1.md`](openclaw-platform-multi-agent-orchestration-v0.1.md) 为准。不要据本文配置主 Agent 的家庭请求入口。

## 目标与当前结论

2026-10-11 的自然语言 Mock 验证证明：DeepSeek 能在 `device-manager` 会话中选择 `run_mock_agent_chain_demo`，由插件运行一条本地 Node.js Mock 协作链。该工具内部直接创建学习事件、调用进程内节能逻辑和设备管家运行时；它没有调用 OpenClaw 中独立注册的 `learning-companion`、`energy-saving` Agent。

若验收要求“多个独立 OpenClaw Agent 实际协作”，需要在一次新的专用验证中，分别调用已注册 Agent 并把结构化结果交给下一环节。真实传感器、真实视觉事件和真实 HA 不在该验证范围内。

## 建议分工与运行链路

```text
用户自然语言
          ↓
OpenClaw `dev` 主对话（用户始终在此交互）
          ↓ `talk_to_device_manager`
OpenClaw `device-manager` Agent（使用设备清单、计划、安全策略和设备工具）
   ├── 必要时请求 learning-companion 产出 Event
   ├── 把已校验 Event 交给 energy-saving 产出 Task
   └── 校验/确认后执行设备动作并回读
                                  ↓
                    Node.js 契约/策略/确认门禁
                                  ↓
                      专用 Mock Home Assistant
```

- OpenClaw LLM：理解口语、选择需要调用的 Agent、传递结构化上下文；不能自行批准风险动作。
- `learning-companion`：只输出符合公共契约的学习行为 Event；单帧或不可信输入标为待复核，不自带可信传感器证明。
- `energy-saving`：只根据已校验状态/Event 生成 canonical Task，不控制设备。
- `device-manager`：唯一设备写操作入口；仍经 Node.js 风险策略、设备白名单、确认要求和动作后回读。
- Node.js 调度/策略层：验证 Event/Task Schema、可信来源、时效/幂等、冲突和确认策略；任何无效或来源不明的 Agent 输出均拒绝向下游传递。

首个独立 Agent 测试宜使用**纯合成输入**：由 `learning-companion` 产出一个带 `needs_review`、`confidence`、`source` 的 Event；在条件满足时由 `energy-saving` 返回关灯 Task；最后用仅连接 Mock 的设备管家测试适配器验证执行与回读。测试期间不发送儿童图片、不接真实 HA、不读取家庭记忆。

## OpenClaw 会话工具与权限边界

本机 `2026.7.1-2` profile 初始只读检查结果：`tools.profile` 为 `coding`，没有显式设置 `tools.agentToAgent` 或 `tools.sessions.visibility`；Agent 顺序为 `dev`、`device-manager`、`learning-companion`、`energy-saving`。依据该机安装包内与 `2026.7.1-2` 对齐的 schema/runtime 源码，未配置时 `tools.agentToAgent.enabled` 不生效（跨 Agent 默认关闭），`tools.sessions.visibility` 默认是 `tree`，不是 `all`。跨 Agent 会话调用需同时启用 agent-to-agent、将可见性设为 `all`，并按该版本运行时行为在 `tools.agentToAgent.allow` 中包含发送方和接收方 Agent ID。该版本 schema 中没有 `tools.agentToAgent.send` 字段。

本项目当前将 OpenClaw `dev` 设为用户面向的自然语言入口，`device-manager` 作为设备执行与安全策略 Agent；`dev` 不直接获得设备写工具，而是通过插件工具 `talk_to_device_manager` 将家庭请求送入设备管家会话。设备管家继续通过受限入口调用 `learning-companion` / `energy-saving`；不新增第四个 `home-orchestrator` Agent，也不开放 `sessions_spawn`。

- `tools.sessions.visibility = "all"`：这是该版本跨 Agent `sessions_send` 所需的会话可见性设置；因为范围较宽，必须同时收紧各 Agent 的会话工具权限。
- `tools.agentToAgent = { enabled: true, allow: ["dev", "device-manager", "learning-companion", "energy-saving"] }`：`2026.7.1-2` 运行时会检查发送方和接收方是否都在集合中。设备管家仍只能由项目插件的固定转接工具触发；业务 Agent 是否可被调用还受工具工厂身份校验和会话工具 deny 列表限制。
- `dev` 只额外开放 `talk_to_device_manager`；其 `sessions_send`、`sessions_spawn` 等会话工具仍禁用。`device-manager` 保留业务 Agent 调用所需的能力，`learning-companion`、`energy-saving` 不开放会话枚举/读取/转发，也不开放 `sessions_spawn`。
- `device-manager` 保留已有设备管家插件工具，但独立 Agent 仍不能直接写设备；设备动作继续通过 Node.js 契约、策略和 Mock 后端。
- 若将来确需 `sessions_spawn`，再另行配置精确的 `subagents.allowAgents`、超时与并发上限，并复核目标 Agent 工具权限。

**初始三 Agent A2A 配置**此前已备份并应用到 `%USERPROFILE%\.openclaw-2026.7.1-2\openclaw.json`，默认 `%USERPROFILE%\.openclaw` 未触碰。2026-10-18 为满足“用户直接与 OpenClaw 对话”的验收要求，在该配置上增加 `dev` 前台 Agent 和只向 `device-manager` 的转接入口；Gateway 重载后的真实对话验收需单独记录。`sessions.visibility=all` 仍与较窄的 Agent allow 集合及逐 Agent `tools.deny` 配合使用；不得将 `dev` 的设备写工具直接放开。

## 验收标准

1. 日志可区分 OpenClaw 会话调用：协调入口、学习伴学 Agent、能源管家、设备管家 Agent，各有独立 `agentId`/调用记录。
2. `learning-companion` 输出通过 Event Schema；`energy-saving` 输出通过 canonical Task Schema；错误 JSON、过期/低置信度/未认证事件不得产生设备动作。
3. 同一 `trace_id` 贯穿各 Agent 调用、Node.js 校验和设备回执；重复事件不会重复控制。
4. 高风险或证据不足任务 fail closed；设备写操作只由设备管家处理，并在执行后回读。
5. 设备管家实际连接为隔离 Mock；最终灯态与 Task 一致，HA 真实凭据不被读取。
6. 记录模型、请求次数和 token 回执；不把一次 Mock 测试称作真实传感器、视觉准确率或家具联调验收。

## 下一步顺序

1. **结构调整：**以 OpenClaw `dev` 为用户自然语言入口，经 `talk_to_device_manager` 转给设备管家；设备管家仍是业务协调者和唯一设备写操作方。
2. **已完成：**隔离 7.1 profile 最小权限配置已 dry-run、备份、应用并通过 `openclaw config validate`；默认 profile 未修改。
3. **已完成：**新增 `multi-agent-orchestrator/src/openclaw-agent-client.js` 和模拟 Gateway client 测试，覆盖严格 JSON、Event/Task schema、来源与 trace、目标 Agent、审批字段隔离、拒绝/超时和幂等；测试不调用模型。
4. **已完成：OpenClaw 独立 Agent 合成联调（2026-10-11）：**分别为 `learning-companion` 与 `energy-saving` 配置 DeepSeek 认证后，通过 `device-manager` 的 `sessions_send` 顺序调用两个独立 Agent，两个请求均返回 `status: ok`。合成输入是 `study_room` 离位事件，置信度 0.60、`needs_review=true`、来源 `synthetic_test`；学习伴学 Agent 返回规范化事件摘要，能源管家返回 `NO_ACTION`，未生成 Task。其理由包括低置信度、待复核、缺少可信且近期的独立 HA 无人事件佐证。本次只使用合成输入，没有调用 HA、Mock 演示工具或设备控制工具，没有产生设备动作。学习伴学 Agent 声称其契约校验通过；由于回执只保留了规范化摘要而非完整 Event JSON，本记录不将其视为独立的本地 schema-validator 复核。
5. **已完成：Node.js 插件 Gateway transport 代码接线（2026-10-15）：**新增受限 `call_independent_agent` 工具、7.1 Gateway transport 与 fake Gateway/插件工厂单测；覆盖可信调用上下文、固定 Agent 白名单、A2A/会话可见性拒绝、严格 Event/Task 契约、幂等键传递和发送后不重试。`multi-agent-orchestrator` 79 项测试、`device-manager` 181 项测试通过；`openclaw plugins validate --root . --entry ./src/openclaw-plugin.js` 通过。本项是代码与 Mock transport 验证，不是本机 Gateway 真实请求。

### 本轮新增的本地边界适配器

`OpenClawAgentClient` 使用依赖注入的 `sendMessage`，消息参数含目标 Agent、JSON 请求、超时与幂等键；接收到的 `status: "ok"` 回复必须是严格 JSON。学习 Agent 的 Event 由仓库 Event schema 校验；能源管家的 Task 会先统一别名，再校验 Task schema、调度器必填字段、目标必须是 `device-manager`，并拒绝 Agent 自行写入 `policy_decision`。输入侧拒绝认证字段和原始图片/视频字段。客户端不会自己调用 HA 或执行 Task。

项目新增 `multi-agent-orchestrator/src/openclaw-gateway-transport.js`，最初尝试通过插件 `runtime.gateway.request` 访问会话方法；设备管家插件提供通用 `call_independent_agent` 和业务编排入口 `evaluate_energy_event_with_independent_agent`。直接 Gateway RPC 不会自动执行内置 `sessions_send` 工具里的调用方 A2A 检查，因此插件用 ToolPluginFactory 提供的可信 `agentId/sessionKey`，复用 OpenClaw 公共 `createAgentToAgentPolicy` / `createSessionVisibilityRowChecker` 校验。该 transport 后经本机运行时验证发现：`runtime.gateway.request` 仅供内置/受信任官方插件使用，普通本地项目插件调用会在发送前被拒绝；现已改为插件公开的 `runtime.subagent.run`、`waitForRun` 和 `getSessionMessages`。目标仍只允许 `learning-companion` 与 `energy-saving`；发起 run 后的超时或错误不自动重试。通用工具只返回经契约校验的候选结果；业务入口将标准 Event 交给独立能源管家，`NO_ACTION` 正常结束且不建计划，Task 则进入设备管家现有 `executeEnergyTask` 计划工作流，重新读取设备清单/状态、走确认策略，再由设备管家执行和回读。来自对话工具的 Event 未认证为 HA 传感器事件，因此不会获得可信传感器自动执行白名单。

本节原始记录当时只完成了 fake Gateway/Mock 验证；之后的修复和真实隔离联调见下方“调用失败根因修复与端到端复验”。业务入口复用设备管家计划/策略工作流，不代表独立 Task 已进入 `MultiAgentScheduler` 内存事件队列。

### 2026-10-11 真实模型 + 本地 Mock 联合验证

- 在隔离的 OpenClaw `2026.7.1-2` profile 中实际调用 `learning-companion`，模型为 `deepseek/deepseek-v4-flash`。首次模型回复缺少必填 `event_id` 且 `source` 不符合 Schema；本地验证器拒绝该输出，没有向下游传递。随后模型按错误反馈修正，Event 通过仓库 `event.schema.json` 校验，包含 `confidence=0.96`、`needs_review=false`、`presence=away_from_desk`、`duration_ms=600000`，并标明为 synthetic test。
- 单独调用 OpenClaw `energy-saving` Agent，并在同一会话先后提供独立 Mock HA 占用事件与上述学习事件。该 LLM Agent 返回 `NO_ACTION / UNTRUSTED_OCCUPANCY_CORROBORATION`，没有生成 Task。这是正确的安全拒绝：CLI 对话里的合成传感器描述不能自行成为可信 HA 证明。
- 为验证仓库里的正向执行逻辑，测试程序另建仅含 `light.study_room` 的内存 Mock HA（初始灯态 `on`），通过**仅测试使用的内部可信适配器注入**独立 Mock HA 无人 Event 和已通过 Schema 的学习 Event。项目内规则型 `EnergySavingAgent` 生成 `P3 turn_off` Task，既有 `MultiAgentScheduler` / `device-manager` Task runtime 执行并回读到 `off`；回执 `SUCCEEDED`、`verified=true`，trace `trace-mock-e2e-20261011-1554`，涉及 `learning-companion`、`energy-saving`、`device-manager`。
- 低置信度反例也通过 Mock 复核：`confidence=0.60` 且 `needs_review=true` 时，状态为 `NO_ACTION`，Task 数为 0，灯仍为 `on`，控制审计数为 0。
- 以上正向设备执行使用的是项目内规则型能源管家；不是 OpenClaw `energy-saving` LLM 生成并直接执行的 Task。测试夹具显式模拟可信内部适配器，不表示任意 `source_agent` 字段已在生产环境完成认证。整个验证没有连接真实 HA、摄像头、传感器或家电，也不代表视觉准确率测试。
- 回归测试：`device-manager` 157/157、`energy-saving` 23/23、`multi-agent-orchestrator` 73/73 通过；公共契约样例 17 个有效、4 个无效样例均按预期通过/拒绝。

**阶段结论（截至上述记录）：**此前已验证“DeepSeek 学习 Agent 输出 → Event Schema 拦截/修正 → 独立 HA 佐证门禁 → 项目规则能源管家规划 → 设备管家在 Mock 执行和回读”的混合链路，以及低置信度拒绝路径。独立 OpenClaw Agent 的 Node.js Gateway transport 接线随后先通过 fake Gateway 与 Mock HA 测试；当时真实 Gateway 联调仍待进行，后续完成情况见 2026-10-15 根因修复与端到端复验章节。

### 2026-10-15 独立能源管家结果接入 Mock 计划流程

- 新增 `evaluate_energy_event_with_independent_agent`，仅向 `device-manager` 会话注册；把标准 Event 通过 Gateway 送给独立 `energy-saving` Agent。
- `NO_ACTION` 被作为合法终态返回，不创建设备计划；Task 通过契约/trace 校验后进入 `executeEnergyTask`，再经设备清单、状态证据、风险策略和确认流程。
- fake Gateway 验证了 `NO_ACTION` 路径；Mock HA 端到端验证了候选关灯 Task 在未确认前不执行，灯状态保持开启。新增单测覆盖幂等重复投递、幂等键内容冲突及非法 Event 拦截。
- 本次设备管家 `npm run verify`：187 项测试通过，Mock acceptance 11/11，插件静态验证和契约样例验证通过；`multi-agent-orchestrator`：85 项测试通过。
- 未重启 Gateway、未调用真实模型/DeepSeek、未连接真实 HA。独立 Task 进入的是设备管家的计划/策略工作流，不是 `MultiAgentScheduler` 内存队列；Gateway 真实合成联调仍待进行。

### 2026-10-15 独立 Agent 调用失败根因修复与端到端复验

- **根因：**设备管家本地插件用 `api.runtime.gateway.request` 调用 Gateway。OpenClaw `2026.7.1-2` 的运行时代码将该接口限制给内置或受信任官方插件；项目本地插件不在该信任范围内，因此在向能源管家发消息之前被拒绝。原适配器把底层异常收敛为通用 `AGENT_CALL_FAILED`，只留下 `sent_before_error=false`，导致错误看起来像会话或模型问题。
- **修复：**改用 OpenClaw 为普通插件公开的 `api.runtime.subagent.run`、`waitForRun` 与 `getSessionMessages`。仍由可信工具上下文验证调用方、限定目标 Agent、执行 A2A/会话可见性校验，并在 run 发起后禁止盲目重试；首次读取目标会话时，仅对精确“目标会话不存在”错误按首次使用处理。
- **代码回归：**相关 transport、插件工厂、独立节能工作流及调度器测试共 96 项通过（0 失败），覆盖权限拒绝、会话首次使用、契约校验、NO_ACTION、确认/执行边界与幂等行为。
- **隔离运行：**重启后 `2026.7.1-2` Gateway RPC 健康，插件清单显示 `device-manager` 从本仓库 `device-manager/src/openclaw-plugin.js` 加载；`device-manager`、`energy-saving` 均使用 `deepseek/deepseek-v4-flash`。本次工具输入为 `evt-synthetic-energy-acceptance-20261015`，来源为未认证合成对话事件，房间占用标为 `true`。
- **实际返回：**OpenClaw 调用 `evaluate_energy_event_with_independent_agent`；独立 `energy-saving` Agent 经 `runtime.subagent` 返回 `NO_ACTION`、`reason_code=OCCUPANCY_NOT_CONFIRMED`，`execution_performed=false`。设备管家没有调用 `list_devices`、`control_device` 或 `run_scene`，没有创建设备计划或执行设备动作。
- **安全边界：**该验收仅证明“隔离 OpenClaw + DeepSeek V4 Flash + 项目插件 + 独立能源管家+ 契约化 NO_ACTION 回传”真实联通；它不证明真实 HA/家电、传感器可信来源或视觉识别已接入，也不代表能源管家可以直接控制设备。Gateway 启动时另有 bundled iMessage/Telegram setup-entry 路径告警；它们未阻断 Gateway RPC 或本次 Agent 调用。

### 2026-10-15 学习伴学 → 节能独立 Agent 组合门禁

- 新增 `device-manager/src/independent-learning-energy-workflow.js`，组合调用独立 `learning-companion` 与 `energy-saving`；复用现有独立节能工作流处理 `NO_ACTION`、候选 Task 和设备管家确认/执行边界。
- 入口仅接受白名单结构化观测字段，不收图片/视频/文件路径；调用方必须从本地代码注入 `isTrustedObservation` 认证器。会话文本或模型自报的来源字段无法自行通过认证。当前 OpenClaw 插件尚未暴露此组合入口，因为开发机没有已接线的可信视觉/传感器观测适配器。
- 学习 Agent 的 Event 必须与输入观测的时间、区域、行为、在位状态、持续时长和目标范围一致；不得提升上游置信度、清除复核标记或降低隐私级别。Event 还要通过公共 Schema、来源 Agent 和统一 `trace_id` 校验。
- 只有个体目标明确、非课堂场景、无待复核、置信度达到 0.8、明确离位且持续至少 10 分钟、观测不超过 2 分钟时，才会继续调用能源管家。时间过期、来源未认证、目标未指定或事件不满足门槛时 fail closed。
- 即使生成 Task，仍以 `trustedEventSource: false` 交给设备管家既有计划门禁；本工作流不会将学习事件提升成可信 HA 事实，不会授予模型审批权或绕过用户确认。
- 本地 Node.js 单元测试覆盖来源未认证、低置信度/待复核/课堂场景/目标缺失/持续时间不足/过期、Event 篡改、`NO_ACTION` 和候选 Task 确认边界。当前 `device-manager` 全量 `npm run verify` 的 196 项单测通过、Mock acceptance 11/11、插件校验通过，公共契约 17 个有效及 4 个预期无效样例通过；`multi-agent-orchestrator` 88 项测试通过。它们是代码级模拟，不调用 DeepSeek、不连接 HA、不代表视觉识别能力已接入。
- 后续增加 `npm run demo:independent-agent-chain`，在隔离内存 Mock HA 上展示未认证拒绝、待复核拦截、`NO_ACTION` 以及候选关灯进入 `CHALLENGE` 四条分支。模拟结果中设备保持 `on`，设备动作数为 0；Agent 回复仍是测试夹具，不是 OpenClaw Gateway 实际调用证据。

### 2026-10-16 DeepSeek 配置与 Gateway 状态核验

- 在隔离 `2026.7.1-2` profile 中，用 `device-manager` Agent、`deepseek/deepseek-v4-flash`、thinking off 和唯一测试会话执行了一次 `openclaw agent --local` 最小调用。会话记录包含预期固定回复，且没有认证或模型错误标记；这证明本地 DeepSeek API 调用可用，不证明 Gateway 插件工具链可用。
- 对同一隔离 profile 运行只读状态探测：Gateway 计划任务已注册但状态为 stopped；18789 端口由一个 `node.exe` OpenClaw Gateway 监听；RPC 可连接，但能力状态为 `connected_no_operator_scope`。
- 经用户同意后执行 `openclaw gateway restart --safe --json`。命令退出码为 0，但重启后计划任务仍显示 stopped、端口仍被占用、RPC scope 未改变；进一步 `gateway probe` 明确返回 `missing scope: operator.read`，提示需配对设备身份或使用具有 `operator.read` 的凭据。没有强杀进程、修改令牌/配置或批准设备配对。
- `openclaw plugins list --enabled --json` 的只读核验显示 `device-manager` 与 `deepseek` 已启用，`qwen` 不在启用清单中；无需安装或切换 Qwen。
- DeepSeek 已是 `device-manager` / `energy-saving` 使用的模型；Qwen 提示来自另一个被跳过的全局插件，不是本项目依赖，不需要为本项目安装或切换到 Qwen。
- **后续：**由用户在本机 OpenClaw Control UI 确认并完成可信设备身份配对（只批准自己识别的本机客户端），然后重新运行 Gateway probe 和项目插件/独立 Agent 验收。真实 HA、传感器和家电仍未接入。

### 2026-10-16 Control UI 配对与独立能源管家Gateway 复验

- 用户按隔离 profile 路径启动 Dashboard 后，在本机浏览器完成 Control UI 连接。`devices list` 可见本机 `openclaw-control-ui` 已配对，获授的 operator scopes 包含 `operator.read`、`operator.write`、`operator.approvals` 和 `operator.pairing`；不在项目文档记录设备 ID、公钥或认证令牌。
- CLI 的 `openclaw gateway probe` 仍报告 `connected_no_operator_scope` / `missing scope: operator.read`，但这不代表浏览器 Control UI 未连接，也未阻断后面的 Gateway Agent 调用。CLI 探测凭据上下文与已配对浏览器身份表现不一致，CLI 专用 scope 诊断仍待处理；本次没有修改 Gateway 配置或升级版本。
- 在隔离 `2026.7.1-2` profile 对 `device-manager` 发起一条 Gateway Agent 验收，使用 `deepseek/deepseek-v4-flash`、thinking off 和专用合成会话。OpenClaw 运行时实际调用了项目插件工具 `evaluate_energy_event_with_independent_agent`，并成功委派给独立 `energy-saving` Agent。
- 合成 Event 表示 `study_room` 有人在场、持续时间为 0、置信度 0.4、`needs_review=true`，来源未认证。插件工具返回 `status=NO_ACTION`、`reason_code=OCCUPIED_PRESENCE_NO_ENERGY_SAVING_ACTION`、`source_agent=energy-saving`、`execution_performed=false`；OpenClaw 运行记录显示该插件工具调用成功且无工具失败。
- 本次没有调用设备查询、设备控制或场景工具，没有创建待执行计划，没有连接真实 HA、传感器或家电，也没有执行设备动作。此项补齐了“浏览器连接后，经隔离 Gateway → 设备管家插件 → 独立能源管家→ 契约化 NO_ACTION 返回”的真实联调证据；不代表候选 Task 的 Gateway 正向确认分支、学习 Agent 组合入口或真实设备链路已验收。
- 随后尝试用 `call_independent_agent` 走“设备管家 → learning-companion → energy-saving”链路。第一跳收到 `INVALID_AGENT_EVENT`：学习 Agent 返回了带 `protocol`、`contract`、`producer_agent` 等包装字段、缺少必需 Event 字段的对象；本地严格契约校验拒绝它，因此没有调用能源管家，也没有设备动作。
- 为修复该问题，已把 Event 必需字段、`trace_id` 原样回传、观察字段放入 `payload`、禁止回显请求信封及不得补造时间/置信度等约束写进 `OpenClawAgentClient.response_rule` 和学习 Agent 工作区 `AGENTS.md`，并增加 response-rule 回归断言。`multi-agent-orchestrator` 全量测试通过；`device-manager` 当前 218 项测试通过、Mock acceptance 11/11、插件校验通过、公共契约 17 个有效及 4 个预期无效样例通过。
- **2026-10-16 重启后的三 Agent 合成复验通过：**用户授权后，对隔离 Gateway 执行 `--safe` 重启；Gateway 安全检查显示队列、待回复、嵌入式运行、定时任务及活动任务均为 0，重启后监听 PID 由 `127188` 变为 `151404`。随后使用 `device-manager` 的独立合成会话、DeepSeek V4 Flash、thinking off，顺序调用 `learning-companion` 与 `energy-saving`；追踪号为 `trace-tri-agent-synthetic-20261016`。学习 Agent 返回标准裸 Event；本地 Event Schema 校验通过，必需字段齐全，`trace_id` 一致，`confidence=0.4`、`needs_review=true` 原样保留。能源管家返回严格 `NO_ACTION`，`reason_code=LEARNING_BEHAVIOR_WITHOUT_TRUSTED_OCCUPANCY_WINDOW`。两次 Agent 调用均为 `status=ok`；未调用设备查询/控制工具、未连接 HA、未执行设备动作（0 次），也未重试。此前“重启并复验待完成”的记录已由本条结果取代。
- 该次验证使用的是专门构造的合成离位观察，不是摄像头、真实儿童行为、可信传感器或 HA 事件；它证明本机隔离 Gateway 上的三 Agent 结构化协作、契约拦截及安全 NO_ACTION 分支可运行，不代表真实设备/传感器接入、节能正向 Task 执行或真实学习识别准确率已验收。DeepSeek API 用量已产生，具体费用未核对。
- Control UI 的本机浏览器身份已配对并显示 operator scopes；CLI `gateway probe` 仍单独报告 `missing scope: operator.read`，不影响本次成功的 `openclaw agent` Gateway 调用。CLI 探测凭据差异另行跟进，不改 token、不升级版本。

### 2026-10-18 OpenClaw 主对话家庭请求转接验收

- 根因是隔离 profile 的用户主 Agent 为 `dev`，但原先家庭工具白名单只配置在 `device-manager`；用户在 OpenClaw 默认对话中看不到设备管家调用入口，因此演示时误以为必须切换 Agent。
- 新增插件工具 `talk_to_device_manager`，仅在可信 `dev` 会话注册，并经 OpenClaw A2A/会话可见性策略把本轮自然语言请求转到 `device-manager` 的主会话。请求和自然语言答复留在同一 OpenClaw 对话；设备查询/控制/确认仍由设备管家完成。疑似含 API Key、密码、Bearer token 或常见 token 格式的文本在发起 Gateway 调用前会被拒绝。
- 隔离 `2026.7.1-2` 配置已备份后，仅为 `dev` 增加 `talk_to_device_manager` 的 `tools.alsoAllow`，并把 `dev` 加入既有 `tools.agentToAgent.allow`。原有 `sessions.visibility=all`、`dev` 对 `sessions_send` 的 deny、设备管家的业务工具白名单及默认 profile 均未改变。配置验证通过；安全重启前预检为 0 个活动任务，Gateway 已安全重启。
- 为避免模型只声称转接而未调用工具，首次合成测试后在 `dev` 工作区追加了“家庭设备请求必须调用转接工具”的路由规则，并重新验证。OpenClaw `dev` 主会话 `agent:dev:frontdoor-smoke-20261018b` 的本地会话记录确认实际调用工具 `talk_to_device_manager`；Gateway 回执为 1 次工具调用、0 次失败。设备管家返回“家庭转接测试成功”，并由 OpenClaw 主对话带回。

### 2026-10-25 低谷排程委派给独立能源管家（隔离 Gateway 运行验收完成）

- 调整 `plan_energy_optimization`：设备管家会话通过 `OpenClawAgentClient` 与公开 `runtime.subagent` 适配器调用独立 `energy-saving` Agent；新增专供能源管家会话的只读 `calculate_energy_optimization` 工具。
- 适配器固定评估时刻，并用确定性排程函数重算 Agent 报告；字段不完全一致即拒绝。通过后才由设备管家继续核查设备清单和安全条件，待机动作仍走确认工作流。
- Linux/Windows 部署安装器均为能源管家添加低价优化、能耗分析、前后用量比较和预算估算工具 allowlist；设备管家入口保留排程委派工具，并拒绝直接使用能源分析工具。运行时按会话身份过滤能源专属工具。
- 代码回归已通过：能源管家 46/46、设备管家 279/279、多 Agent 编排器 129/129、部署安装器 13/13；设备管家 Mock acceptance 11/11，OpenClaw 插件静态校验通过。测试涵盖能源优化专用契约、工具会话隔离、确定性报告校验及篡改拒绝。
- 隔离 profile 已备份并追加所需工具 allowlist，OpenClaw 配置校验通过。初次只读排查曾误判 PID 97064 不存在；后续确认它是监听 `127.0.0.1:18789` 的 `2026.7.1-2` Gateway 进程，锁记录配置路径指向隔离 profile。经用户同意，旧进程通过控制台中断信号正常退出；随后从隔离 profile 启动新实例。状态探测确认配置有效、无插件版本漂移、`device-manager` 插件已加载，Gateway 已就绪。
- 使用独立会话 `agent:device-manager:energy-optimization-e2e-20261025` 发送自然语言低谷排程请求。DeepSeek V4 Flash 的 `device-manager` Agent 实际调用 `plan_energy_optimization`；OpenClaw `runtime.subagent` 将任务交给独立 `energy-saving` Agent，后者实际调用 `calculate_energy_optimization`。设备管家返回 `success=true`、`delegated_to=energy-saving`；报告通过 `OpenClawAgentClient` 的契约校验及确定性重算比对。
- 计算建议为北京时间 2026-10-25 22:00 至 2026-10-26 00:00，预计费用 0.42 CNY，20:15 最早启动窗口估算 0.89 CNY，差额 0.47 CNY。没有调用设备控制工具、查询 HA、启动设备或安装定时任务；工具回执为 `action_taken=false`、`NO_ACTION_CANDIDATE`、`execution_performed=false`。
- 此次完成的是隔离 Gateway 的 CLI Agent 端到端委派验收，不是网页聊天界面或真实 HA 设备验收。Gateway 当前通过本机隐藏进程手动运行；系统重启后的自动恢复尚未验证。启动日志中的 iMessage/Telegram bundled channel 路径警告未影响本次 `device-manager` CLI 会话。

### 2026-10-16 独立能源管家正向候选与设备管家门禁复验

- 在隔离 `2026.7.1-2` Gateway 的专用合成会话中，使用 DeepSeek V4 Flash、thinking off 调用独立 `energy-saving` Agent。模型根据合成的“离家模式 + 客厅灯亮”事件返回了契约化 `device_action` 候选：目标 `light.living_room`、动作 `turn_off`、优先级 `P3`，trace 为 `trace-energy-task-positive-20261016`。该调用只生成候选 Task，没有调用设备执行工具。
- 随后将该候选 Task 回放到仓库本地 Mock：`MockHomeAssistant` 中客厅灯初始为 `on`，`createIndependentEnergyWorkflow` 将 Task 交给 `createOrchestratorBridge(...).agentPlanTools.executeEnergyTask`，并保持 `trustedEventSource: false`。结果为 `CHALLENGE`、`confirmation_required=true`、`execution_performed=false`；灯仍为 `on`，候选提交前后设备动作审计增量为 0，未批准该候选。
- Gateway 返回记录对幂等键做了脱敏；Mock 回放采用本地合成幂等键，其他用于门禁判断的 Task 字段保持候选内容。回放本身不再调用模型或 Gateway。
- 将该 Gateway 返回的 Task 形状固化为 `device-manager/test/independent-energy-workflow.test.js` 回归样例；并在隔离 Mock 中依次模拟“暂缓”和“拒绝”：暂缓后确认项继续留在待处理列表；明确拒绝后项目移除、回执 `REJECTED`。随后用临时审批状态文件模拟设备管家进程重建：待确认任务恢复为 `RECOVERY_REQUIRED`，旧 approval 的 `approve` 请求仍被拒绝，灯保持 `on`、动作审计增量为 0。两条路径均不模拟批准执行；进程重建测试不是实际 Gateway 重启。
- 另补两条失败关闭回归：候选 Task 即使自称包含可信 HA 事件佐证仍需确认；独立 Agent 调用失败或返回错误状态时不得调用设备管家。独立节能工作流定向测试 8/8、`device-manager` 全量 `npm test` 221/221、`npm run verify`、Mock acceptance 11/11 通过；根目录 `Verify-Agent-Stack.ps1` 的跨模块/演示检查 10/10 通过。上述均为本地/Mock 验证，不连接真实 HA、未操作真实设备，也未在本轮调用模型；不等于已验证用户确认后的设备执行、可信 HA 事件自动执行或真实家庭数据链路。

### 2026-10-25 OpenClaw 主对话入口再次联调

- `dev` 主会话轨迹记录了一次成功的 `talk_to_device_manager` 调用；设备管家随后调用 `plan_energy_optimization`，并由 `runtime.subagent` 委派到独立 `energy-saving` 会话；能源管家调用 `calculate_energy_optimization`。三段会话状态均为成功，设备管家与能源管家工具回执均无错误。
- 低谷排程建议为北京时间 2026-10-26 20:00–22:00，估算费用 0.42 CNY；按白天电价估算为 0.96 CNY，差额 0.54 CNY。费用基于用户提供的耗电量、电价及均匀耗能假设。
- 轨迹只显示 `talk_to_device_manager`、`plan_energy_optimization`、`list_devices` 和 `calculate_energy_optimization`；没有设备控制或定时工具调用。结果明确未执行设备动作、未安装预约。Mock 清单没有洗碗机实体，所以本次只验证了依据用户参数进行排程分析。
- Gateway 会话元数据标记 `messageProvider` / `messageChannel` 为 `webchat`。本次验收依据 Gateway 轨迹，不包含浏览器画面检查；不能据此宣称已完成网页 UI 的视觉验收。
- 这次证明当前隔离 Gateway 的固定入口 `dev → talk_to_device_manager → device-manager → energy-saving` 可完成该类自然语言排程请求。它没有调用 `orchestrate_household_agents`，因此不构成新版平台级动态编排插件已部署或验收的证据；两种入口不能混为一谈。

### 2026-10-25 能耗分析编排超时复盘与修正

- 合成读数分析轨迹 `energy-sample-analysis-20261025-2304` 中，`dev` 实际调用了新版 `orchestrate_household_agents`，但能源管家的结果超过当时 45 秒默认等待时间。能源管家先收到两次 `INSUFFICIENT_DATA`，后来才返回 `ANALYZED`；其最终结果晚于主对话超时响应，因此这次端到端验收判定为失败。主对话随后自行补算并猜测设备故障，结论没有得到工具结果支持。
- 已将平台默认 Agent 等待窗口调整为 OpenClaw 公开接口允许的上限 120 秒，并在平台能力清单分别登记能源管家的能耗分析、前后用量比较、预算估算和电价排程能力。
- 已强化主 Agent 与能源管家的失败边界：分析失败、超时或数据不足时，不得自行计算、猜测故障原因或重复盲目调用；能源管家依据工具返回的拒绝字段向用户澄清。未自动重发原请求。
- 本地平台适配器、主入口规则和合成编排定向回归通过 17/17。
- 初次重启请求被安全审查阻止后，用户明确确认 `18789` 属于隔离 Gateway 并授权重启；随后通过 OpenClaw 官方 `gateway restart` 命令完成重启。状态探测确认 Gateway RPC 可用，版本为 `2026.7.1-2`。
- **在线复验通过：**新建 `dev` 验收会话，trace 为 `energy-acceptance-20261025-2329`。主 Agent 调用 `orchestrate_household_agents` 一次，只规划 `energy-saving:analyze_energy_usage`；能源管家实际调用 `analyze_energy_usage`，返回 `ANALYZED`，平台步骤状态为 `COMPLETED`，用时约 9.6 秒。三条合成读数合计 1.00 kWh，按设备/区域分组与输入一致。没有调用设备操作 Agent（`device_action_agent_invoked=false`），没有执行设备控制。
- 回复正确说明数据只代表提供的读数，没有猜测电器故障原因；但它额外点名了两条读数可能存在计量重叠，这个具体配对没有被输入数据或工具结果证明。计量口径未知的通用提醒有依据，具体配对应视为待改进的表达，不应当作已发现的数据问题。本轮验收通过编排与计算链路，不代表网页 UI 视觉验收。
- 随后为主对话补充自然、简短中文及“计量口径未知时不得点名推测具体重叠读数”的规则，再次重启隔离 Gateway 并复验。新 trace `energy-readings-20261025-2336` 使用 `dev → orchestrate_household_agents → energy-saving:analyze_energy_usage`，平台状态 `COMPLETED`，能源分析步骤约 8.5 秒完成；回复按日常语言给出 1.00 kWh 汇总和三个地点的分项，只作一般性计量口径提醒，没有再点名具体读数配对。设备操作 Agent 未调用。该次仍通过 Gateway CLI 新会话验收，不是网页 UI 视觉检查。

### 2026-10-25 能源管家平台能力补充验收

- 前后效果比较 trace `energy-effect-20261025-2341`：`dev` 只调用一次 `orchestrate_household_agents`，计划 `energy-saving:evaluate_energy_effect`；能源管家工具返回 `COMPARABLE`，平台步骤 `COMPLETED`，观测到 0.15 kWh、25% 的下降，回复说明不能据此证明因果。缺少后测读数的 trace `energy-effect-20261025-2343` 返回 `NEEDS_CLARIFICATION`，工具状态为 `INSUFFICIENT_OR_MISMATCHED_DATA`，没有估算，也没有调用设备操作 Agent。
- 电价排程 trace `dishwasher-20261026-2346`：平台将主对话请求直接路由到 `energy-saving:plan_energy_optimization`，步骤 `COMPLETED`，建议北京时间 2026-10-26 22:00–次日 00:00，费用估算 0.42 元。没有调用设备操作 Agent、启动设备或设置定时。
- 至此，平台 `dev → orchestrate_household_agents → energy-saving` 链路下已在线验证能耗分析、预算估算、前后效果比较和电价排程四类登记能力；调用均通过隔离 OpenClaw `2026.7.1-2` Gateway 与 DeepSeek V4 Flash 完成。以上为显式提供的合成数据分析，不是网页 UI 验收，也不表示真实电表数据自动采集。

## 官方资料

- [OpenClaw 会话工具](https://docs.openclaw.ai/concepts/session-tool)
- [OpenClaw 跨 Agent、会话及子 Agent 配置](https://docs.openclaw.ai/gateway/config-tools/sessions-and-subagents)
- [OpenClaw 工具与 Agent 权限](https://docs.openclaw.ai/gateway/security/tool-permissions)
