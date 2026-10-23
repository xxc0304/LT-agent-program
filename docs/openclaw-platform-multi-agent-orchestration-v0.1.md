# OpenClaw 平台级多 Agent 编排设计与实现（v0.1）

## 目标

让 OpenClaw 用户主对话成为统一入口：由 OpenClaw 当前配置的大模型理解用户表达、判断需要哪些 Agent、整理步骤和依赖；平台调度器只按登记清单校验并调用 Agent；设备操作仍由设备管家按既有设备策略处理。这里没有为每个业务 Agent 另配一套大模型 API。

## 业务链路

```text
家庭用户自然语言
        ↓
OpenClaw 主对话模型：理解意图，提出 Agent 计划
        ↓ orchestrate_household_agents
平台调度器：检查 Agent/能力登记、步骤依赖、设备动作冲突
        ├── 已登记的分析 Agent：按需并行或依赖顺序调用
        ├── 不清楚：返回自然语言问题，零 Agent 调用
        ├── 当前无匹配能力：明确说明暂不支持，零 Agent 调用
        ├── 矛盾/需确认/被阻断：返回问题或停止原因，停止后续步骤
        └── 设备任务：只调用设备管家 Agent，由其执行原有安全策略
        ↓
OpenClaw 主对话：汇总结果，或用日常语言向用户提问
```

## 谁负责什么

| 组件 | 职责 | 不负责 |
|---|---|---|
| OpenClaw 主对话模型 | 理解用户自然语言；选择一个或多个已登记 Agent；将任务拆成步骤；根据调度结果答复或追问 | 不能凭模型计划绕过代码门禁或把建议当成设备授权 |
| 平台调度器 `multi-agent-orchestrator` | Agent/能力白名单；计划和依赖校验；并行/顺序派发；设备动作冲突拦截；汇总 Trace；在澄清、确认、失败或阻断时停止后续步骤 | 不连接 Home Assistant，不直接操作设备，不单独调用 DeepSeek |
| 业务 Agent | 在登记的能力范围内分析或处理任务，并返回有类型的 JSON 结果 | 不能自行声明已获得设备策略批准 |
| 设备管家 Agent | 查询设备；负责唯一的设备操作入口；继续执行设备登记、风险策略、必要确认、动作和状态回读 | 不承担所有业务 Agent 的通用总调度职责 |

## 编排策略

- Agent 不是按固定顺序全部调用。OpenClaw 根据本轮任务提交一个或多个步骤及依赖。
- OpenClaw 主对话模型负责理解用户意图并动态组合已登记能力；调度器不要求每种说法都预先写一条规则，但也不会因此创造新能力或放行任意工具调用。
- 当需求可能由现有能力完成但缺少信息时，OpenClaw 可提交 `decision=clarify` 和面向用户的问题；当登记能力确实无法完成时，可提交 `decision=unsupported` 和诚实说明。这两种决定均不需要 Agent 步骤，且不会调用 Agent 或设备。
- 未登记的 Agent 或能力引用会在派发前返回 `UNSUPPORTED`、稳定原因码和面向用户的通用说明；不会把内部 ID 暴露给用户，也不会产生 Agent 调用。重复步骤、缺失依赖或依赖循环仍属于计划格式错误，会在派发前拒绝。
- 没有依赖关系的分析/规划 Agent 可以并行；同一个 OpenClaw Agent 会话的调用串行，避免互相读到对方的回复。
- 存在设备动作时，先完成同一轮中可运行的分析/规划步骤；设备管家动作独立派发，不与分析 Agent 并发。
- 同一请求涉及多项设备操作时，OpenClaw 必须把完整设备意图放在一个 `device_action` 步骤中交给设备管家。设备管家使用已登记清单、候选计划校验器、冲突策略及既有确认流程，一次性核对整组动作；不得将多个潜在副作用步骤拆成独立调用。
- 如果 OpenClaw 提交了多个 `device_action` 步骤，调度器先用已明确的动作/目标元数据检查可见的互斥冲突；发现冲突则在派发前询问用户。无冲突但有多条设备动作、或其中动作信息不完整时，调度器返回专用 `BLOCKED` 结构码且零 Agent 调用。OpenClaw 主对话应把动作合并为一个设备管家步骤后自动重提一次；若设备目标/用户意图仍不清楚，再询问用户。
- 调度器提供的动作元数据仅用于计划结构和冲突预检，不构成授权，也不代替真实设备解析。设备管家仍须核验真实清单、能力、家庭策略、确认要求，并按工具结果回读验证。
- Agent 返回 `NEEDS_CLARIFICATION`、`CONFLICT`、`NEEDS_CONFIRMATION`、`BLOCKED` 或 `FAILED` 时，调度器停止所有尚未开始的步骤，包括同一并发批次中尚未派发的排队任务。已经发出的并行调用不能撤销，调度器会等待其完成并把结果一并返回；不会再启动新步骤。OpenClaw 用普通语言向用户说明；收到用户答复后重新生成一份计划，不复用未经持久化的旧计划。
- 如果并行 Agent 同时返回多个停止结果，顶层状态按保守优先级选择：`FAILED` > `BLOCKED` > `CONFLICT` > `NEEDS_CONFIRMATION` > `NEEDS_CLARIFICATION`；同级按计划中的原始步骤顺序决定顶层问题，所有 Agent 的停止结果都保留在 `results` 中。
- Agent 超时或调用结果不明时不自动重发；如果调用已发出，结果会标记副作用可能未知，避免重复动作。

### 没有现成规则或能力时

这套设计不是“为每句话预写一条 if/else”。OpenClaw 模型可以把日常表达映射到已登记能力，并将多个能力组合成计划；比如用户说“孩子写完作业后提醒我关灯”，模型可先分析是否涉及学习/节能，再把明确设备任务交给设备管家。调度器只验证这些 Agent/能力确实存在、步骤关系合理且安全门禁通过。

如果模型无法判断用户目标，返回 `NEEDS_CLARIFICATION` 并请用户补充；如果目标明确但当前登记能力做不到，返回 `UNSUPPORTED` 并说明暂时无法处理；如果模型意外提交不存在的 Agent/能力，调度器同样在执行前拦截，并确保零 Agent/设备调用。新出现的能力缺口需要开发并登记相应 Agent/能力，模型不能靠“猜”来补齐。该机制不能保证识别所有罕见情况，但确保未覆盖场景不会因模型临时编造路由而误执行。

## 示例：用户说“客厅没人了，看看能不能省点电”

1. OpenClaw 理解需求，选择节能 Agent 评估节能机会；如确实需要看设备状态，再安排设备管家查询。它不会因为固定规则就依次调用全部 Agent。
2. 调度器先验证这两个 Agent 和所选能力已经登记，再验证依赖关系；互相独立的分析可以并行。
3. 如果节能 Agent 发现占用信息过期或结果不确定，它返回一个具体问题，调度器停止设备任务。OpenClaw 会问用户是否继续检查或暂不处理。
4. 如果分析清楚且涉及设备变化，OpenClaw 将明确的设备请求交给设备管家。设备管家重新检查设备、家庭策略及确认要求；调度器本身不直接调用 HA。
5. 如果设备管家需要确认或返回执行结果不确定，问题/状态回到 OpenClaw 主对话；用户回答后由 OpenClaw 重新规划。

平台结果中的 `COMPLETED` 表示本次计划中的 Agent 调用均完成，不代表平台自己执行过物理设备操作。设备是否实际改变只能根据设备管家工具返回的执行与状态回读证据说明；`device_action_agent_invoked` 仅表示请求已交给设备管家。

## Agent 返回契约

每个 Agent 被调用后必须返回一个裸 JSON 对象，不得使用 Markdown 包裹。`source_agent` 和 `trace_id` 必须与本次请求一致，`result` 可省略或为空对象：

```json
{
  "status": "COMPLETED",
  "source_agent": "energy-saving",
  "trace_id": "trace-01",
  "summary": "当前没有需要处理的节能机会。",
  "result": { "opportunity": false }
}
```

Agent 返回状态包括 `COMPLETED`、`PROPOSED`、`NO_ACTION`、`NEEDS_CLARIFICATION`、`NEEDS_CONFIRMATION`、`CONFLICT`、`BLOCKED`、`FAILED`。需要澄清/确认/冲突时必须包含面向用户的 `question` 或 `message`，可附 `options`；身份、追踪号或结果结构不合规则按失败处理。另有平台顶层结果 `UNSUPPORTED`：表示模型明确判断无已登记能力，或调度器拦截了未登记的 Agent/能力；它不是 Agent 返回状态，也不触发 Agent 调用。设备管家返回设备任务时仍需由它自己的执行与策略流程决定是否操作。

## 新增 Agent

基础登记包含学习伴学、节能和设备管家。增加其他业务 Agent 时，在 `platform-orchestrator` 插件配置的 `additionalAgents` 中登记 `agent_id`、名称及能力和影响类型，并确保该 Agent 已在 OpenClaw 配置、A2A 策略和会话可见性策略中获准。插件只允许新增 `read_only` 或 `planning` 能力；`device_action` 始终只允许设备管家声明。调度器不会扫描 Gateway 中的所有 Agent，也不会调用用户计划里临时编造的 ID。

## 代码位置

- `multi-agent-orchestrator/src/platform-agent-registry.js`：平台 Agent/能力登记。
- `multi-agent-orchestrator/src/platform-orchestrator.js`：步骤校验、并发/依赖派发、冲突检测和停止/追问门。
- `multi-agent-orchestrator/src/openclaw-platform-adapter.js`：以 OpenClaw `runtime.subagent.run`、`waitForRun`、`getSessionMessages` 调用已登记 Agent，并执行 A2A/会话可见性校验。
- `multi-agent-orchestrator/src/openclaw-platform-plugin.js`：注册给 OpenClaw 用户主 Agent 的 `orchestrate_household_agents` 工具。
- `multi-agent-orchestrator/openclaw.plugin.json`：OpenClaw 插件清单。
- `multi-agent-orchestrator/test/platform-orchestrator.test.js`、`openclaw-platform-adapter.test.js`：核心调度和 Gateway 接口 Mock 测试。

## Agent 会话上下文

适配器默认将 Agent 请求发往 `agent:<agent_id>:<session.mainKey>` 会话，`mainKey` 未配置时为 `main`。因此，同一目标 Agent、同一 mainKey 下的多次请求共享该 Agent 的会话历史；请求正文仍只转发本次任务及必要输入/依赖结果。若未来需要多家庭、多用户隔离或无历史上下文的完全独立调用，应先明确会话键策略并补相应验收。

## 验证与边界

当前自动化测试验证登记/能力校验、依赖图、并行分析、设备动作隔离、多个设备动作步骤被预检拦截、缺少动作元数据时零派发、同设备冲突询问、单个自然语言设备任务仍可由设备管家自行核实/澄清、Agent 不确定时停止后续执行、Agent 身份/trace 校验、Gateway 授权拒绝和不自动重发。验证使用 Mock Gateway 与 Mock Agent 回答，不等于本机 OpenClaw Gateway 已加载新插件，也不等于对真实 Agent、HA 或设备完成联调。

澄清回复按 MVP 处理：插件不跨 Gateway 重启保存待答计划；用户回复后 OpenClaw 根据新信息重新规划并再次提交。通用调度规则覆盖登记能力和明确场景，不宣称可穷举所有家庭罕见情况；无法判断时通过 Agent 的追问/阻断结果交还用户。

## OpenClaw 安装提示

该插件是 `multi-agent-orchestrator` 下独立的平台插件，不是设备管家插件里的总调度函数。部署时应将此插件安装到 Gateway，并在用户主 Agent（默认 `dev`）允许使用 `orchestrate_household_agents`；同步配置 Gateway 的 Agent-to-Agent 白名单和会话可见性。主 Agent 的工作区指令必须将 `orchestrate_household_agents` 设为家庭请求的唯一入口；旧的固定 `talk_to_device_manager` 入口应停用，不能继续在指令里要求主 Agent 调用它。

部署器会安装独立的平台插件、把 `orchestrate_household_agents` 开放给主 Agent、显式禁用旧固定转发入口，并通过目标 Gateway CLI 生成插件元数据。代码包本轮没有自动修改当前正在运行的 OpenClaw Profile 或重启 Gateway。
