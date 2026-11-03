# 智慧家庭多 Agent 编排：研究复核与实验设计

**状态：方案未定案，实验继续。** 本文用于把老师的 `AGENTS.md` 路由、项目编排器和公开框架中的常见模式放到同一组智慧家庭约束下比较。公开文档说明可用的设计模式，不代表某种模式拥有市场份额优势，也不单独证明它适合本项目。

## 1. 复核现有实验记录

本公开提交不包含首轮原始模型轨迹或旧汇总文件；原始轨迹可能含模型对话或推理字段。这里仅记录一致性审计后的问题和定性观察，不能从公开副本还原原始模型回复。

仓库已有 A/B/C 八个合成场景的 DeepSeek/OpenClaw 试跑记录，但当前汇总文件不能作为完整的公平对照：

- `results/REPORT.md` 和 `results/strategy-summary.csv` 保存的是首轮汇总；当前 `results/comparison.csv` 的 A、B 行引用 `r2` 原始文件，C 行仍引用 `r1` 文件。因此不能把这张表当成同一批次。
- 当前 CSV 中 B、C 的专家 token 列为空。按 CSV 重算只能得到 B 34,715、C 26,592 个已填 token，而首轮报告写的是 B 66,930、C 82,120。缺项不能用旧汇总补齐，也不应猜测。
- `comparison.csv` 记录了零设备写入尝试，但它不等于行为质量、运行开销或资源的完整评估。既有报告也没有重复样本、并发、CPU/RSS 或可核对的 API 费用。

结论：首轮足以暴露有价值的问题（例如简单任务是否被多调 Agent、复杂任务是否传递依赖数据、冲突能否停止），但不足以做最终架构排名。新的汇总必须从同一批原始轨迹生成，并把缺失指标留空。

补查 24 个原始结果后，S01–S08 的 A/B/C 用户输入逐条完全相同，主模型均记录为 `deepseek-v4-flash`。这说明旧结果可以作为探索性行为样本保留，但 A/B 标记为 `r2`、C 为 `r1`，且专家 token、资源指标和重复样本不全，仍不能据此宣布胜负。可复核的路由倾向是：A 在 8 个场景里 7 次直接 `sessions_send`（包括低可信事件和越界维修）；B 的主 Agent 8 次都提交编排工具，由代码回传不同业务状态；C 在模糊、冲突和低可信场景中多次串联设备与安全专家。它们是需要重复验证的现象，不是普遍规律。

## 2. 官方资料能支持的判断

### OpenClaw 的原生调用方式

OpenClaw 的会话工具区分两类工作：`sessions_send` 在同一个 Gateway 上向另一个会话发送任务；`sessions_spawn` 创建隔离的后台子 Agent 会话。子会话有隔离的上下文和工具策略，但仍共享 Gateway 进程资源；后台子任务启动返回的是已受理状态，不等于任务结果已经完成。因此“所有任务都 spawn 子 Agent”可能带来额外等待和上下文成本，且不适合作为用户交互同步完成的默认路径。参见 [OpenClaw Session tools](https://docs.openclaw.ai/concepts/session-tool)、[OpenClaw Sub-agents](https://docs.openclaw.ai/tools/subagents)、[Concurrency, recovery, and stopping](https://docs.openclaw.ai/tools/subagents/operations)。

OpenAI Agents SDK 的官方设计资料把 Manager（专家作为工具）和 Handoff（把当前对话交给专家）作为两种常见模式，也单独描述按代码组织的确定性流程；文档说明可以按任务组合这些方式，但没有说哪一种对所有应用最好。智慧家庭需要始终保留统一的安全检查和用户答复时，Manager/前门 Agent 更容易保留对话控制；专家接管则适合专家应直接负责剩余交互的任务。参见 [Agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/) 和 [Agents](https://openai.github.io/openai-agents-python/agents/)。这是模式层面的参考，不是本项目使用 OpenAI 模型的要求。

### 智慧家庭的设备边界

Home Assistant 对 Assist 暴露实体时建议只暴露需要控制的实体，并指出暴露过多会有性能代价；LLM 调用脚本可以更灵活，但需要清楚的描述，且要更谨慎地定义其权限。由此可见，家庭系统不应把“模型能看见 Gateway 上所有工具/实体”当作可扩展性的目标，而应按 Agent 能力登记和家庭授权范围给出最小工具面。参见 [Home Assistant Best practices with Assist](https://www.home-assistant.io/voice_control/best_practices/) 和 [Exposing entities to Assist](https://www.home-assistant.io/voice_control/voice_remote_expose_devices)。

## 3. 方案比较：围绕同一实际问题

所有方案都要回答这几件事：谁理解自然语言；什么时候需要一个或多个 Agent；陌生或缺信息时如何反馈；设备动作前谁做最终校验；失败后怎样停止并告诉用户。

| 候选 | 执行链路 | 家庭场景的优势 | 主要风险/代价 |
|---|---|---|---|
| A 老师 `AGENTS.md` 直接路由 | OpenClaw 主 Agent 根据文档规则，直接把请求发给指定 Agent | 简单请求链路短、提示词和老师现有接入方式直观 | 规则外的新 Agent/新能力容易漏路由；单靠提示文本不能代替程序层的能力、依赖和动作校验 |
| B 项目平台编排器 | 主 Agent 提交步骤计划；代码校验登记能力、依赖、冲突和停止状态；适配器派发 | 多步骤可追踪；代码能统一拒绝未登记能力或不安全计划 | 简单请求也可能付出计划/工具开销；计划是否完整仍受模型输入理解影响，需验证上下文传递 |
| C Manager/Agent-as-tools | 主 Agent 把专家作为工具按需调用并汇总 | 主 Agent 保持对话，专家适合回答有边界的子问题 | 多次专家调用的 token/延迟可能累积；若没有共同执行门，模型选择工具不能当成安全授权 |
| D B 的按需计划变体（待验证） | 清楚、单领域请求提交一个步骤；确实依赖多领域时提交多步骤；能直接澄清/说明不支持时不启动 Agent；所有实际派发仍经过 B 的同一校验器 | 目标是减少没有业务价值的模型/Agent 调用，同时保留统一安全门和扩展路径 | 它不是新的框架；主要检验 B 的提示与调用粒度是否能降低开销而不损失正确率。若与 B 的表现无差异，就没有理由另设 D |

D 仅是一个可被否定的优化假设，不是“已选方案”，也不预设一定优于 A/B/C。它是有意控制范围的 B 对照变体，不把老师规则、自由 Manager 和代码工作流机械拼成第四套架构。

## 4. 面向家庭的设计目标

实验要支持或否定下面这条候选链路，而不是假设“规则表能覆盖所有家庭情况”：

```text
用户或事件
  → OpenClaw 主 Agent 理解意图、判断缺失信息并拟出当前请求所需的最小工作
  → 只有需要专业能力时，调用唯一的家庭 Agent 编排入口
  → 编排代码按登记能力、输入完整性、依赖、冲突和权限校验
  → 适配器调用一个或多个 Agent；独立只读任务才并行
  → 设备管家按设备策略负责动作授权、执行和状态回读
  → 编排代码把完成、未完成、阻止原因或澄清要求交回主 Agent
  → 主 Agent 用日常语言回应用户
```

设计约束：

1. 不要求每条家庭事件都遍历 Agent。聊天/知识问题可以直接回答；清楚的单领域只读请求走一个已登记能力；只有目标本身跨领域或有真实数据依赖时才调用多个 Agent。
2. 模型负责理解、提出计划和自然语言交互；程序负责校验并执行安全边界。提示词中的“不要开锁”不是最终门禁。
3. 不确定或冲突时，反馈必须有用：指出缺什么、哪些要求互相冲突、用户可以怎么选择。若信息可通过只读 Agent 查到，先查后反馈；若涉及有风险动作或关键事实不可靠，则停止相关动作并明确说明。
4. 设备动作只允许通过设备管家和它的现有授权/确认机制；编排器不直接控制 HA。Agent 调用成功、计划通过校验和设备动作成功是不同状态，最终回复不得混淆。
5. 用能力注册/契约扩展新 Agent，而不是不断增加 prompt 中的硬编码分支；未登记能力必须诚实返回，不编造 Agent。
6. 资源与成本分开算：DeepSeek 云推理不算作边缘网关本机 CPU/GPU；OpenClaw session、插件和适配器仍消耗本地资源。Gateway 子 Agent 共享进程资源，不能把并发数配置上限误当成硬件容量。

## 5. 新增的智慧家庭研究证据

- **SimuHome** 使用可执行的家庭模拟器，任务含初始设备状态、目标状态、自然语言请求和所需动作；对控制任务直接检查模拟器最终状态，对自然语言回答另设评审。它指出仅做静态“指令到 API”映射无法检验动态状态、时间依赖和执行后验证。我们应把 Mock 家庭状态和结果校验纳入下一版，而不只比较文字回答。
- **SMH-Bench** 包含 1,100 项、7 大类任务，覆盖 8 到 135 台设备的不同家庭规模；论文报告模型在自动化调度、歧义处理和个性化推理上仍有明显弱点。它提醒我们把复杂度和场景类别分层，不能只用几个简单设备查询代表家庭能力。
- **HearthNet**（ACM CAIS 2026 论文）提出面向边缘家庭的持续事件处理、共享状态和根级动作授权。它不是本项目必须照搬的现成产品，但支持一个重要设计判断：长时间运行的家庭事件不能只靠一次聊天或临时子 Agent；需要可恢复的任务状态和独立的动作授权边界。
- **Home Assistant 官方文档**建议只暴露需要给语音助手使用的实体；LLM 可调用的脚本应有清楚的用途、参数说明，并返回成功或失败原因，以便验证工具是否被正确调用。它支持最小能力暴露和显式回执，也说明单靠工具描述并不能替代执行后的状态核验。

这些资料支持的是测试方法和边界设计，不能直接替代本项目对 A/B/C/D 的实测，也不能证明某一种框架“市场上最优”。

## 6. 修订后的实验设计

只跑 B/D 的 60 轮实验无法选出整体方案，因为它不比较老师方案 A 和经理式 C。最终决策前应先做一轮 A/B/C/D 同场筛选，再针对接近的候选做更深的重复。

### 阶段一：同条件筛选

- **方法**：A 老师的 `AGENTS.md` 直接路由；B 当前编排工具；C Manager-as-tools；D 按需派发但仍经过 B 的登记、校验和适配器。
- **场景**：原 S01–S08，再把“用户问当前状态、需要从设备能力读取状态”和“可信状态已在事件上下文中、无须重复查询”拆开；加入一个明确、低风险的模拟设备动作，用来验证动作计划和回读。
- **样本**：各方法、各场景 3 个独立会话起步，运行顺序随机或轮换；这是工程筛选，不宣称统计显著。若候选质量接近，再对关键场景扩到 5 次。
- **一致性**：使用同一 OpenClaw `2026.7.1-2`、同一模型、Agent 清单、能力说明、超时与家庭状态。用户只说日常语言；传感器数据放在 Mock 适配器或可信事件上下文里，不要求用户把 entity ID 或状态抄进对话。
- **安全**：禁用 HA 和真实设备工具。动作只进入本地 Mock 状态机，记录 proposed action、校验结果和模拟后的状态；门锁等敏感动作只测阻断和反馈。
- **失败样本**：连接错误、HTTP 503、超时和 Gateway 拒绝都保留为环境失败，不冒充模型答错，也不把失败样本静默替换。模型回执、Agent 回执、设备状态回读分别记账。

### 阶段二：分层指标与判定

每条轨迹由结构化数据和人工盲审共同评分：意图是否理解；需要查询时是否拿到最新状态；Agent 路由是否必要；跨 Agent 依赖是否正确；该澄清时是否问清；不支持时是否诚实说明；设备动作是否通过授权、冲突和状态核验；最终答复是否与实际结果一致。把安全违规作为硬门槛，不与 token 节省抵消。

资源指标分开报告：OpenClaw Gateway 进程 CPU、RSS、SQLite/插件开销属于边缘侧；DeepSeek token、API 延迟和可核验费用属于云推理侧。云端模型不可用时，另测系统是否停止相关动作并给出明确反馈。当前只有 Windows 诊断环境；它不能作为 Linux 边缘资源数据。

只有候选在关键安全场景无动作越权、正确率和澄清质量不下降、必要依赖没有回退，并在多次运行中稳定减少无价值派发，才继续作为优先方案。单纯的 token 或延迟最低不够。

### B/D 定向对照的用途

此前拟定的 B/D 六场景、各 5 次（60 轮）只回答“D 的按需调用能否改善 B”，可以作为阶段一后的定向实验；即使 D 胜出，也只能证明这一个调用粒度优化，不等于 A/B/C/D 的总体方案已经定案。

## 7. 当前运行结果与阻塞

本机 OpenClaw `2026.7.1-2` 的隔离 B/D Gateway 已做本机健康检查。修复实验配置时确认了三个运行条件：OpenClaw 状态目录应为每个 profile 下的 `state` 子目录；`models.providers.deepseek: null` 会触发插件安装预检；将既有 API 凭据映射到实验专用环境变量后，Gateway 进程应移除被 OpenClaw 用来自动发现 provider 插件的原始环境变量。此处只修正隔离配置，不修改日常 Profile。

实际请求中，B 的一个 S01 主 Agent 调用已使用 7,495 token 并调用编排工具；设备管家只读步骤随后因 DeepSeek 返回 503 而失败。编排工具返回 `FAILED`，且 `device_action_agent_invoked=false`，所以它提供了“模型/Agent 后端失败时没有进入设备动作”的有限证据，但不是成功完成的场景样本。另有一次初始连接错误、一次配对范围不匹配；D Profile 在启动时触发了自动 heartbeat，而不是用户实验请求。Gateway 已停止，避免更多非试验请求。费用字段显示 0 不能证明真实免费；兼容接口没有提供可核验费用时应记为未知。

截至目前没有成功的 B/D 配对样本。DeepSeek 域名 TCP 握手可以通过，但本次推理接口返回 503 “Service is too busy”，所以暂停继续调用，不做方案判断。有效试验恢复前，应在隔离 Gateway 启动环境设置 `OPENCLAW_SKIP_CRON=1`，禁止自动心跳污染用量；任何记录都放在 `experiments/orchestration-comparison-v2/results/windows-pilot/`，不覆盖 v1，也不与 Linux 性能数据混算。

另一个影响有效性的设计问题是：旧的 `S01_simple_device_read.txt` 把 `25.4 °C` 直接写在用户输入里，模型可以不查设备就答对。修订后的协议要求将日常口语和 Mock 家庭状态分离；但共享 Mock 状态查询能力还没有接入 A/B/C/D 所有隔离 Profile，因此当前 S01 以及任何类似上下文泄漏的样本都不用于“实时设备查询”比较。最近本地 136 项代码测试和 Mock 演示通过，只验证现有编排/授权代码的固定输入路径，不代表模型路由有效。

## 8. 参考资料

- OpenClaw 官方：[Session tools](https://docs.openclaw.ai/concepts/session-tool)、[Sub-agents](https://docs.openclaw.ai/tools/subagents)、[Sub-agent operations](https://docs.openclaw.ai/tools/subagents/operations)。
- OpenAI Agents SDK 官方：[Agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/)、[Agent patterns](https://openai.github.io/openai-agents-python/agents/)。
- Home Assistant 官方：[Best practices with Assist](https://www.home-assistant.io/voice_control/best_practices/)、[Expose entities to Assist](https://www.home-assistant.io/voice_control/voice_remote_expose_devices)。
- Home Assistant 官方：[Exposing scripts to LLM conversation agents](https://www.home-assistant.io/voice_control/exposing_scripts_to_llms/)。
- SimuHome：[A Temporal- and Environment-Aware Benchmark for Smart Home LLM Agents](https://arxiv.org/abs/2509.24282)。
- SMH-Bench：[Benchmarking LLM Agents for Environment-Grounded Reasoning and Action in Smart Homes](https://arxiv.org/abs/2606.01912)。
- HearthNet：[Edge Multi-Agent Orchestration for Smart Homes](https://arxiv.org/abs/2604.09618)。
- LangGraph 官方：[Multi-agent network](https://langchain-ai.github.io/langgraph/how-tos/multi-agent-network/)。
