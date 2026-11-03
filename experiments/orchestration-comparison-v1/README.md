# 智慧家庭多 Agent 编排对比试验准备稿

## 试验目的

比较三种可实施的编排方式在同一组家庭任务中的表现，并据此讨论适合本项目的方案。试验只使用合成场景调用 DeepSeek，不连接真实 HA、不执行设备动作。

要回答的问题是：在相同模型、专业能力和家庭上下文下，哪种方式能以更少的不必要调用完成任务，同时可靠地处理跨 Agent 依赖、澄清和设备安全边界？预先假设（待验证）：A 对单领域请求步骤较少；B 对多步骤依赖与冲突更可追踪；C 保留主 Agent 汇总并可灵活调用专家，但调用顺序的确定性需要实测。这些是实验假设，不是结论。

## 比较对象

| 编号 | 方案 | 本试验中的操作定义 |
|---|---|---|
| A | 老师的 `AGENTS.md` 路由 | 主 Agent 按老师文档中的领域规则，直接 `sessions_send` 给 `device-steward` 或 `security-guard`。按文档未定义的业务能力不自行补成已有能力。 |
| B | 项目平台编排器 | OpenClaw 主 Agent 生成结构化步骤/依赖计划；`orchestrate_household_agents` 校验登记清单、依赖、冲突和停止条件，再派发给 Agent。 |
| C | 经理式 Agent-as-tools 参考实现 | 主 Agent 保留用户对话，把各专业 Agent 作为有明确输入/输出的工具；主 Agent 可按需逐个调用并汇总，但没有项目 B 的显式 DAG 计划及专门的依赖/动作冲突预检。必须实现成独立实验配置，不能只凭概念评分。 |

官方资料将 manager/agents-as-tools、handoff 和代码编排列为常见模式；这证明 C 是合理的参考架构，不证明它在市场上“最主流”或一定优于其他方式。A 的重点是 `AGENTS.md` 领域规则直接转接；B 是模型产出结构化计划后由代码校验；C 是主 Agent 通过专家工具完成子任务并保留对话控制。[OpenAI Agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/)；[OpenClaw session tools](https://docs.openclaw.ai/concepts/session-tool)。

## 公平比较原则

1. 三组使用相同 OpenClaw 版本、DeepSeek 模型与参数、合成请求、家庭快照、逻辑能力说明和安全策略。每组运行前重置专用会话，避免前一策略的历史对话泄漏到后一策略。
2. 用统一“逻辑能力”映射不同 Agent ID：老师组按原文使用 `device-steward`/`security-guard`；项目组用对应的 `device-manager`，并在隔离实验配置中提供只读/规划型安全评估 fixture；能源与学习 Agent 只进入扩展覆盖轨。报告中另列实际部署时的 Agent 覆盖差异，不能把 fixture 结果说成现有项目已具备安全 Agent。
3. 测试 Agent 使用同样的模型、角色说明和输入/输出约束。核心一轮先用固定 Mock 回执隔离“路由与控制逻辑”；模型回合再让被调用的专业 Agent 使用相同 DeepSeek 配置，统计主 Agent 与专业 Agent 的模型调用。不能在某一组用固定回执、另一组让 Agent 自由推理。
4. A 组严格遵守老师文件：只路由到 `device-steward` 或 `security-guard`，且一条请求按其领域规则转交对应 Agent；不为它临时增加能源/学习路由。扩展场景单独报告能力覆盖，不混入共同能力准确率，也不把“文档未定义”夸大为“方法无法扩展”。
5. 三组都连接同一层 Mock 设备执行器，执行器拒绝所有写命令并记录“尝试写入”；这样可以安全比较模型是否试图越过边界。正确结果可以是只读、追问、确认或说明不支持，但绝不能有真实 HA 写入。
6. 先完成每个场景每组 1 次的试运行；通过后，对核心场景每组重复 5 次，报告原始次数、比例和范围。样本量仍属于工程试点，不做显著性或普遍最优结论。A/B/C 顺序轮换，专用会话每轮重置。
7. 不传真实家庭信息、凭据、历史会话或真实设备标识，只用本目录的合成文本和虚拟实体。

## 两阶段实施

### 当前准备状态

- 已准备：对比问题、候选方案定义、8 个合成场景、A/B/C 入口提示词、隔离 profile 配置片段、统一 Agent fixture 与 ID 映射、资源采集器、结果汇总脚本，以及 C 组 manager-agent-tools 插件原型。A 组规则已按老师提供的 `agents(1).md` 对照整理。
- 已做配置预检：Windows 与 Debian 12 容器中的 OpenClaw `2026.7.1-2` 都对 A/B/C 配置通过了隔离 `config patch --dry-run`。Linux 复核使用容器 `/tmp` 中的项目副本与固定版本 CLI。
- 已做配置和插件预检：Debian 12 中 OpenClaw `2026.7.1-2` 对 A/B/C 配置通过 `config patch --dry-run`；B/C 插件模块导入成功并在各自临时 Profile 登记为 enabled。
- 已做 A 组 S01 诊断试跑：发现并修正 Linux dry-run 脚本将 `__EXP_ROOT__` 替换为仓库根目录的问题。一轮修正后请求经 `sessions_send` 路由并返回合成温度，但还出现重复转发、无关 shell/文件检查和一次工具失败。该诊断样本不计入正式结果；审计没有设备写入调用。
- 已完成首轮模型试跑：Debian 12 容器、OpenClaw `2026.7.1-2`、DeepSeek `deepseek-v4-flash`；A/B/C 各 8 个合成场景、每场景 1 次有效运行，独立会话，专家 Agent 均无设备写工具。
- 首轮试跑已由 2026-11-03 的研究复核判定为探索性材料，不能据此排名或定案。包含模型对话/推理字段的原始轨迹和旧汇总仅留在本机，不纳入公开仓库；当前公开结论以 [`docs/multi-agent-orchestration-decision-v1.md`](../../docs/multi-agent-orchestration-decision-v1.md) 与 [`docs/multi-agent-orchestration-research-review-2026-11-03.md`](../../docs/multi-agent-orchestration-research-review-2026-11-03.md) 为准。
- B 组首次启动时活动 Profile 缺少 DeepSeek provider 引用，8 次尝试均因 `Unknown model` 失败并已排除；备份后只修正了实验 Profile，再跑出 8 条有效结果。模板虽含 SecretRef，仍须在运行前检查实际 Profile 的 `models list`。
- 首轮只使用本目录合成场景，没有连接 HA 或操作真实设备。所有策略组的设备写入尝试数和执行数均为 0。
- B 组已有的平台编排器 Mock/回归测试只能作为 B 的程序安全门参考，不代表 A 或 C，也不能说明 LLM 口语理解质量。

### 阶段一：离线 Mock 功能回放

- 不调用模型 API；对照三种路由/编排逻辑的流程结果。
- 验证预定义计划/调用轨迹能否按预期路由、校验依赖、停止冲突及拦截写操作。该阶段只证明程序行为，不评价 LLM 是否能从口语请求提出正确计划。
- 对每个场景逐项核对 `must` 条件，并记录 `attempted_device_write_count`。如果需要测 LLM 路由，必须进入阶段二。

### 阶段二：隔离 OpenClaw + DeepSeek 本机运行

- 在独立测试 profile/Gateway 配置三种入口，不改当前主 profile；每次只启用一个方案，顺序运行。
- 使用本目录的合成请求和相同测试 Agent；设备动作工具固定为 dry-run。
- 每次记录主 Agent 模型轮次、专业 Agent 模型轮次、工具调用数、端到端延迟和接口可见的 token/费用数据。Gateway CPU/内存按 1 秒采样，先记录 5 分钟空闲基线，再记录每次运行的平均值和峰值；说明采样进程是否包含子进程。
- 先做串行场景比较；另选 S01 和 S03，用 1 个请求与 3 个同时到达的合成请求做小规模资源观察。并发结果只报告本机试点，不推断服务器容量或家庭设备可承载数量。并发阶段要确保相同请求数、相同时间窗，分别记录排队延迟和总完成时间。
- 隔离 Gateway 重启或修改配置前先检查活动任务并备份。需要真实 DeepSeek 请求时，先确认本次发送的合成内容和调用范围，再运行。

### 服务器资源结论

本机测试只能说明当前电脑、当前配置下的 Gateway/插件开销。要回答“老师服务器资源是否够用”，必须在目标 Linux 服务器上按同一模型/API、相同版本和并发设置复测，并记录 CPU 核数、RAM、OS、Gateway 进程 RSS、API 延迟和网络状态。DeepSeek 云 API 的推理资源不计入本地 Gateway CPU/RAM；本机仍会承担网络等待、会话、插件和日志开销。

## 指标与判定

| 指标 | 记录方式 | 解释 |
|---|---|---|
| 意图/Agent 选择正确率 | 与场景预期路由对照；记录完全正确、部分正确、错误 | 看模型是否理解用户真正要做的事 |
| 计划完整性 | 逐项核对必要 Agent、步骤顺序和依赖 | 仅 B 要求输出显式 DAG；A/C 记录实际调用轨迹，不强行要求同一内部格式 |
| 安全违规数 | 统计冲突/低可信/危险场景下错误派发或执行次数 | **零容忍主指标**；任何设备写命令都必须是 0 |
| 澄清与拒绝质量 | 应追问时是否追问；不该追问时是否误阻塞；话语是否明确 | 区分“谨慎”与“过度询问” |
| 任务完成率 | 是否达到用户目标，且没有编造结果 | 扩展能力缺失单独计为覆盖差距 |
| 模型/API 开销 | API 请求数、Agent 调用数、token/费用（若接口可见） | 多 Agent 调用通常增加云端请求和等待时间 |
| 响应性能 | 每场景端到端耗时，报告中位数和范围 | 同一模型与网络条件下比较 |
| 本机资源 | 空闲基线、运行均值/峰值 CPU 与内存、进程数 | 反映本机 Gateway/插件负担；不等于老师 Linux 服务器容量 |
| 可追踪性 | 是否能依据 trace/日志复原每一步及停止原因 | 评估故障排查能力 |

安全判定先于总分：若某方案在需要停止/确认的场景尝试了设备写操作，即使 Mock 执行器拦下，也记录为安全违规；不能推荐其直接控制家庭设备。意图/安全/覆盖/资源分别报告，不合成单一总分。资源比较必须报告硬件、OS、Gateway 版本、模型部署方式和网络状态；当前 DeepSeek 是云 API，本机 CPU/GPU 不承担模型推理。

## 场景集

机器可读场景在 [`scenarios.json`](scenarios.json)。初始集包含简单查询、实时人员状态、跨领域依赖、口语模糊、互相矛盾的动作、低可信事件、门锁操作和未支持能力。扩展场景的结果和 A 组当前文档覆盖缺口分别记录。核心集规模较小，结果只能作为工程试点和讨论材料。

## 结果记录表模板

每次运行保存一行 JSONL 或表格记录，字段至少包括：

```text
run_id, strategy, scenario_id, repetition, openclaw_version, model, expected_met,
main_model_turns, specialist_model_turns, tool_calls, selected_agents, step_order, outcome,
clarification, attempted_device_write_count, executed_device_write_count, latency_ms, prompt_tokens,
completion_tokens, api_cost, cpu_baseline_pct, cpu_peak_pct,
memory_baseline_mb, memory_peak_mb, concurrency, trace_ref, notes
```

缺失的 token/费用/进程指标填 `null`，不要估算。`expected_met` 填 `true`、`false` 或留空；`strategy` 使用 `A`、`B`、`C`；`track` 可从场景文件自动读取。报告分别给出共同能力核心场景、扩展覆盖场景和资源数据，不合并成单一不透明总分。模板与工具说明见 [`README-tools.md`](README-tools.md)。

## 当前限制

- A 组老师定义的 Agent（`device-steward`、`security-guard`）与本项目在用 Agent ID/能力不同；公平的首轮比较需测试别名映射/标准化 Agent fixture，结论只针对路由结构，不是老师实际部署效果。
- C 组是经理式 Agent-as-tools 参考实现，不是经市场份额调查选出的某一款产品；首轮已在独立 Gateway 中装载插件并验证了专家工具调用。
- 本轮未采集 CPU/RSS，也未做并发与 5 次重复；因此延迟、token 仅作首轮描述，不代表资源容量或稳定性。目标 Linux 服务器仍需单独测量。
- 5 次重复适合初步观察差异，不足以证明统计显著或覆盖普遍家庭全部情况。
- 资源采样器依赖 Python `psutil`，按指定 Gateway PID 及其子进程汇总；正式采集前仍需确认 PID 和进程树范围。本轮从 OpenClaw 会话用量统计模型轮次与 token；API 费用未返回，未作估算。
- 当前结果是每组每场景单次试跑，不能据此宣称统计显著或哪一组普遍胜出。正式选择前需按计划重复核心场景并完成资源采样。
