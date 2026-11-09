# 编排候选 B/D 定向验证

本目录用于验证一个窄问题：相对 B 当前的“家庭请求均提交编排工具”，D 的“只在需要能力派发时提交；简单问题一步，澄清/明确不支持时直接反馈”能否减少无用开销且不损害任务与安全结果。它是 A/B/C/D 全面对照前的子实验，不能单独决定最终架构。

配置文件是路径已脱敏的模板。使用前把 `__EXP_ROOT__` 替换为本目录绝对路径，把 `__REPO_ROOT__` 替换为仓库根目录；只在全新隔离的实验 Profile 中进行 dry-run 和运行。

## 候选定义

- **B**：复用 v1 的平台编排器提示、Agent 注册表、能力校验、依赖校验与 OpenClaw 适配器。
- **D**：保持 B 的插件、模型、Agent 清单、系统工具权限和结构校验完全相同；只替换主 Agent 的入口提示，增加“只在确需 Agent 能力时调用工具”和“单一明确请求只交一个步骤”的规则。多 Agent 步骤、冲突/低可信/敏感操作仍走同一编排工具与安全 Agent fixture。

D 是提示调用粒度的消融候选，不是已定的第四种框架。若质量不变且成本/延迟没有可重复改善，保留 B，不创建新分支。

完整 A/B/C/D 首轮所需的 v2 配置矩阵已补齐：A/C 复用 v1 中审过的教师路由与 Agent-as-tools 入口提示和专家 fixture，四种策略各自的统一配置片段均位于本目录；四者使用同一 DeepSeek OpenAI-compatible endpoint、模型 ID、token/context 上限和 `LT_EXPERIMENT_API_KEY` SecretRef。矩阵见 [`candidate-matrix.json`](candidate-matrix.json)，静态一致性检查不会调用 OpenClaw 或模型。

Linux 实验密钥也有单次录入入口：`bash experiments/orchestration-comparison-v2/tools/experiment-api-key-linux.sh store` 在隐藏终端输入后存入当前 Linux 用户的 Secret Service；后续启动进程用 `bash .../experiment-api-key-linux.sh with-key -- <command>` 读取，并只通过 `LT_EXPERIMENT_API_KEY` 环境变量传给该子进程。`check` 只报告是否可取用。它不写 profile、仓库或普通文件；没有已登录且可用的 Secret Service 时失败关闭。Windows DPAPI 中保存的密钥不会自动迁移到 Linux，需要在目标 Linux 用户会话中录入一次。

## 预定测试

S01、S03、S04、S05、S06、S07；B 与 D 各 5 次独立会话，共 60 轮。共享模型 alias 为 `dscompat/deepseek-v4-flash`（DeepSeek V4 Flash），OpenClaw `2026.7.1-2`。同一场景内 B/D 顺序交替；设备写入工具不进入任何 Agent 工具白名单。只用 v1 的合成场景和 fixture，不接 HA。

完整的家庭场景、共享 Mock 状态、评分标准和实验阶段见 [`EXPERIMENT-PROTOCOL.md`](EXPERIMENT-PROTOCOL.md)。通过条件、指标和限制也见 [`../../docs/multi-agent-orchestration-research-review-2026-11-03.md`](../../docs/multi-agent-orchestration-research-review-2026-11-03.md)。

## 当前状态

候选定义和原始结果一致性审计已完成，但当前没有有效的 B/D 配对场景样本。此前 B 的一次 S01 主 Agent 调用产生了计划并使用约 7,495 token，之后只读专家步骤遇到 DeepSeek 503，未形成完整结果；另有一次配对授权失败和两次 503 失败请求。D 没有有效用户场景结果，隔离 Gateway 已停止。费用字段为 0 或缺失均不能证明实际免费，费用记为未知。

最近的本地验证是代码级 Mock 验证：多 Agent 编排器 `npm test` 136/136 通过；计划校验和授权工作流两个 Mock 演示均通过，展示了依赖执行、冲突拦截、未登记 Agent 拒绝、确认前不执行及确认后只调用 Mock handler。它验证现有代码的流程和安全门，不是 A/B/C/D 的自然语言效果对比。Docker daemon 当前不可用，因此没有 Debian/Linux 实验结果。

试验记录见 [`results/windows-pilot/STATUS.md`](results/windows-pilot/STATUS.md)。后续重启隔离 Gateway 时需在进程环境设置 `OPENCLAW_SKIP_CRON=1`，防止心跳或定时任务发起非实验模型请求；每个 profile 的状态目录使用 `<profile>\state`，不得复用旧错误目录中的未批准配对请求。DeepSeek 503 后不自动重试。

### 离线 Mock 阶段 0

已补齐可在 Linux CI 和本机 Node.js 直接运行的确定性 Mock 检查入口：

```sh
node --test \
  experiments/orchestration-comparison-v2/candidate-profile-contract.test.mjs \
  experiments/orchestration-comparison-v2/mock-household-harness.test.mjs \
  experiments/orchestration-comparison-v2/experiment-api-key-linux.test.mjs
node experiments/orchestration-comparison-v2/mock-household-harness.mjs
# Include full state snapshots and audit logs
node experiments/orchestration-comparison-v2/mock-household-harness.mjs --json
# On Linux with the pinned OpenClaw CLI, validate all four isolated config patches
bash experiments/orchestration-comparison-v2/tools/dry_run_profiles_linux.sh all
# On Linux, store once in Secret Service; later wrap each model-calling process
bash experiments/orchestration-comparison-v2/tools/experiment-api-key-linux.sh store
bash experiments/orchestration-comparison-v2/tools/experiment-api-key-linux.sh check
# For model calls, wrap only a command already pointed at an isolated experiment profile.
bash experiments/orchestration-comparison-v2/tools/experiment-api-key-linux.sh with-key -- <isolated-command>
```

六个 fixture 覆盖最新状态读取、低风险模拟动作与回读、预置冲突/低置信场景中的越权写拦截、敏感解锁授权拦截和合成 503 故障。每个候选/重复轮次从同一初态创建独立 Mock；摘要保留动作尝试及失败码、成功审计记录、最终状态和逐项检查，并明确声明未调用模型、网络或真实 Home Assistant。Mock 阶段 0 测试为 9/9 通过，CLI 六个场景为 6/6 通过；Linux CI 工作流已加入该检查，本地尚未在 Linux 环境运行。该阶段不是 A/B/C/D 的语义对比样本，也不填补有效模型轨迹不足。

四候选静态配置契约检查目前为 **7/7 通过**，连同 Mock 阶段 0 测试共 **16/16 通过**。API Key helper 的两项隔离测试只在 Linux 执行；本机 Windows 上显示为跳过。Linux dry-run 脚本会为每种策略建立临时 profile，解析仓库根目录替换路径，并在调用 OpenClaw 前确认所有 Agent workspace 都存在；随后只运行配置 schema dry-run，不启动 Gateway、不要求 API Key、不调用模型。CI 工作流已接入 Bash 语法检查、helper 合成密钥测试和四 profile dry-run；路径修复后的 Ubuntu run 仍待执行。
