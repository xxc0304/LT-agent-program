# 实验准备工具与文件说明

此目录包含实验模板、隔离 Profile 和离线分析工具。运行前先阅读主 [`README.md`](README.md) 的公平比较和安全边界。模型阶段只使用合成场景，不连接真实 HA 或操作设备。

## 目录

- `profiles/A|B|C/AGENTS.md`：各策略的主 Agent 入口提示词草案。
- `profiles/A|B|C/openclaw-config.patch.json`：新建隔离 profile 使用的配置片段。`__EXP_ROOT__` 是本实验目录的占位符；先替换为实验目录绝对路径，再仅对新 profile 执行 `openclaw config patch --file ... --dry-run`。配置中的 `agents.list` 是数组，OpenClaw 合并补丁时数组会替换，因此**不得用于已有/日常 profile**。
- `profiles/*/profile-manifest.json`：配置意图、所需 Agent 和工具范围的机器可读清单；不是 OpenClaw 配置文件。
- `profiles/C/expert-tool-contract.json`：C 组专家工具桥接契约。
- `plugins/manager-agent-tools/`：C 组专家工具桥接插件原型；只暴露单专家调用工具、不做 B 组显式计划校验。仍需在隔离 profile 中装载并用目标 OpenClaw 版本验证。
- `fixtures/agents.json`：共同能力和扩展能力的标准 Agent 角色、输入输出契约与 Mock 回执。
- `fixtures/mock-agent-replies.json`：阶段一离线 Mock 回放的标准专家回执；阶段二使用同一份角色说明但让相同模型生成结果，不能混用固定回执和模型生成回执。
- `fixtures/agent-id-mapping.csv`：A/B/C 方案到统一逻辑角色的 ID 映射。`fixture` 表示实验桩，不代表项目已登记同名 Agent。
- `results-template.csv`：逐轮记录模板。
- `tools/collect_gateway_resources.py`：按 Gateway PID 和进程树采集 CPU、RSS 与进程数。
- `tools/summarize_results.py`：从结果 CSV 和资源 CSV 生成 Markdown 汇总；不做显著性检验，也不自动判定方案胜出。
- `tools/dry_run_profiles_linux.sh`：在 Linux 上对 A/B/C 模板运行隔离配置 dry-run；只创建 `/tmp` 下的临时配置，不启动 Gateway、不写入日常 Profile。

## 隔离配置要求

1. 在目标机器使用与对比一致的 OpenClaw 版本，A/B/C 分别使用全新的 profile 名称和状态目录。保留当前日常 profile 不变。
2. 每组配置都显式使用同一模型 `deepseek/deepseek-v4-flash`；`OPENCLAW_PROFILE`、`OPENCLAW_CONFIG_PATH`、`OPENCLAW_STATE_DIR` 指向实验专用配置和状态目录。配置片段不含模型凭据；真实模型运行时通过目标环境的 `DEEPSEEK_API_KEY` 安全注入，不要把密钥写入仓库或 profile patch。
3. 先复制配置片段到临时目录并把 `__EXP_ROOT__` 替换成 `experiments/orchestration-comparison-v1` 的绝对路径，随后在对应 profile 下执行 `openclaw config patch --file <patch> --dry-run`。检查预览中 Agent 列表仅含本轮所需 Agent、没有真实 HA 凭据和设备写工具。dry-run 通过后再在该实验 profile 内应用。
4. 所有设备动作工具均须替换成只记录意图的 dry-run fixture；不得把真实 HA 写入工具或凭据接入实验 profile。模型调用阶段另行确认发送范围。
5. A 按老师的 `sessions_send` 路由语义；B 使用项目插件 `orchestrate_household_agents`；C 使用 `manager-agent-tools` 暴露单专家工具，让主 Agent 保留对话并按需取回专家结果。C 桥接底层也使用 OpenClaw 公共 subagent API，但不提交 B 组结构化计划，也不运行 B 组计划验证器。模板不代表 Gateway 已经配置或可以直接启动。B 插件的注册 Agent 清单要和 `agent-id-mapping.csv` 对齐；在安全评估 fixture 尚未装载为实验 Agent 前，不可把 B 的该项标为实际 Agent 调用。

6. 每个 profile 的主 Agent `tools.allow` 仅列出该策略所需工具，专家 Agent 的工具 allowlist 为空。所有 workspace 共用实验版 `SOUL.md`、`USER.md`、`TOOLS.md`、`HEARTBEAT.md`，避免首次启动引导、偏好写入和无关 shell/文件工具影响结果。变更这些隔离策略后须重新执行 Linux config dry-run。

Linux 配置预检命令：

```shell
bash experiments/orchestration-comparison-v1/tools/dry_run_profiles_linux.sh all
```

脚本要求 OpenClaw `2026.7.1-2`、Bash 和 Node.js；仅生成临时 profile 文件并执行 `openclaw config patch --dry-run`，不启动 Gateway。Debian 12 首轮已进一步启动隔离 Gateway，验证 A/B/C 的模型调用和策略工具。配置 schema dry-run 本身仍不验证插件加载或模型可用性；应用到实际 Profile 后，还要运行 `openclaw models list` 确认 `deepseek/deepseek-v4-flash` 可见，再开始调用。

在新环境复现 C 组时，若插件依赖尚未安装，先进入插件目录安装：

```shell
cd experiments/orchestration-comparison-v1/plugins/manager-agent-tools
npm install --omit=dev --legacy-peer-deps
```

随后再在隔离 Gateway 中安装/链接插件。B 使用 `openclaw plugins install --link <repo>/multi-agent-orchestrator`，C 使用 `openclaw plugins install --link <repo>/experiments/orchestration-comparison-v1/plugins/manager-agent-tools`。插件只链接到对应实验 profile，不要在日常 profile 下安装。若启动检查仍失败，先检查插件目录内是否存在 `node_modules/typebox`，再看 OpenClaw 的插件加载日志；不要把配置 schema 预检通过当作插件运行验证。

## 资源采集

依赖安装：

```shell
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r experiments/orchestration-comparison-v1/requirements-resources.txt
```

Linux 上先人工确认 Gateway PID，例如查看 `pgrep -af openclaw` 的输出后选择实际 Gateway PID；不要把命令行输出上传到报告，因为参数可能含敏感信息。Windows 上可用任务管理器“详细信息”页核对 `node.exe` 对应 PID。

单次采样示例（把占位参数换成真实值）：

```shell
python experiments/orchestration-comparison-v1/tools/collect_gateway_resources.py \
  --pid <GATEWAY_PID> --run-id <RUN_ID> --strategy B --scenario-id S01_simple_device_read \
  --phase run --duration-seconds 60 --output resources.csv
```

空闲基线用 `--phase baseline --strategy baseline --scenario-id baseline` 采 300 秒；每轮场景结束后用 `--phase run` 单独采集。脚本每秒读取一次根进程及子进程的累计 CPU 时间和 RSS，不记录命令行、环境变量或其他进程信息。`cpu_pct_host_capacity` 按整机逻辑 CPU 容量归一化；`cpu_pct_one_core` 按单核归一化，可能超过 100%。

## 汇总

```shell
python experiments/orchestration-comparison-v1/tools/summarize_results.py \
  --results experiments/orchestration-comparison-v1/results-template.csv \
  --resources resources.csv \
  --output orchestration-comparison-summary.md
```

汇总脚本会忽略 `expected_met` 为空的模板行，并显式报告有效样本数、预期行为达成率、设备写入尝试/执行数、模型/工具调用、延迟分位数和资源采样摘要。结果是描述性统计；样本量和硬件条件不支持泛化時，报告也不会作此推断。

## 当前已知的待确认项

- A 的 Agent ID 来自老师文档；A 中未定义的能源/学习场景按能力覆盖缺口记录。
- B 的 `security-review-fixture` 是统一安全评估 fixture，不是项目已登记的正式安全 Agent。阶段一可用固定 Mock 回执；阶段二需把同一角色以相同模型配置成独立 Agent。
- C 的专家工具桥接已在隔离 Gateway 中加载；首轮确认 `dev` 可见 `call_device_specialist`、`call_safety_review` 和 `call_energy_specialist`，其余专家 Agent 工具白名单为空。
- 首次实际启动 B 时，活动 Profile 缺少 `models.providers.deepseek` 的环境 SecretRef，导致模型报 `Unknown model`。备份后在 B/C 临时 Profile 补齐与 A 相同的引用并重启，才完成有效运行；不要只依赖 patch 模板或 schema dry-run，必须检查活动配置的模型列表。
- 首轮模型原始记录和旧汇总保留在本机，不纳入公开仓库。它们仅为探索性历史材料，不能据此排名；公开的复核结论见 [`docs/multi-agent-orchestration-research-review-2026-11-03.md`](../../docs/multi-agent-orchestration-research-review-2026-11-03.md)。
- 配置片段是隔离 profile 的起始草稿，必须用安装版本 dry-run 并检查 schema/工具权限；不能因 JSON 格式正确就视为配置有效。
