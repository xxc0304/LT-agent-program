# Windows pilot 状态记录

**日期：2026-11-03**
**结论：没有有效的 B/D 配对场景结果，不作方案判断。**

## 已记录的尝试

| 方法 / 场景 | 结果 | 是否有效样本 |
|---|---|---|
| B / S01 / `r2` | Gateway 配对升级未获批准，CLI 回退后连接关闭；请求未形成完整场景轨迹 | 否 |
| B / S01 / `r3` | DeepSeek 返回 HTTP 503 `Service is too busy` | 否 |
| B / S01 / `r4` | DeepSeek 再次返回 HTTP 503 `Service is too busy` | 否 |
| B / S01 / 主 Agent + 只读专家步骤 | 主 Agent 曾生成编排计划、累计约 7,495 token；只读专家步骤随后遇到 503，顶层结果为 `FAILED`，没有完成设备状态查询 | 否；仅保留为失败链路观察 |
| D / S01 | 尚无有效用户场景样本；隔离 Gateway 曾触发非实验 heartbeat，随后已停止 | 否 |

配对失败请求、服务端错误和未完成的主 Agent 轨迹都保留在本目录，不作为模型语义错误或成功率分母。OpenClaw 费用字段的 0 / 空值不能证明实际没有费用；服务商可核验账单尚未取得，费用未知。

## 本地可复核的结果

- `multi-agent-orchestrator` 的 Node 测试：136 项通过、0 项失败。
- `npm run demo:plan-validation`：Mock 低风险计划按依赖执行；冲突设备计划在执行前拦截；未登记 Agent 被拒绝。
- `npm run demo:plan-workflow`：首次提交后等待明确确认，没有调用 handler；模拟授权后重新校验并只调用进程内 Mock handler。
- 以上只证明当前校验/授权代码在固定输入和 Mock handler 下按预期工作。没有调用大模型，不证明 A/B/C/D 的自然语言理解和路由效果。

## 运行环境和限制

- 本轮是 Windows 诊断 pilot，不是 Linux 性能试验。
- Docker API pipe 当前未连接，无法启动 Debian 12 容器。
- B/D 隔离 Gateway 已停止；后续启动前要设置 `OPENCLAW_SKIP_CRON=1`，阻止心跳和定时任务污染实验流量。
- 正确状态目录为隔离 profile 自身的 `state` 子目录。错误目录里出现过 `operator.write` / `operator.admin` 配对升级请求；不要批准或复用它。
- S01 的旧输入文件把合成温度直接告诉主 Agent，不能用来证明设备状态查询有效。正式对照应只向模型输入用户口语，并让共享 Mock 状态工具/可信上下文提供家庭状态。
- DeepSeek 503 后没有自动重试。当前已有的 API 授权仅适用于先前明确指定的一次调用；本记录不把它延伸为后续批量调用授权。

## 2026-11-07 后续进展

- 已完成原先待办的阶段 0：新增六个可重置 Mock fixture、动作/readback 审计报告和 Linux CI 检查入口；本机 Node 测试 9/9 通过，CLI fixture 6/6 通过。
- 补齐 A/B/C/D 配置矩阵：A/C 沿用已审阅的 v1 入口提示和专家 fixture，统一配置到 B/D 相同的模型 endpoint、模型 ID、限制和密钥引用。静态契约检查与阶段 0 测试合计 16/16 通过（配置契约 7 项、Mock 测试 9 项）。
- 新增四个配置的 Linux/OpenClaw 固定版本 CLI dry-run 脚本并接入 workflow；当前机器未在 Linux 运行，且本地改动尚未推送，所以该步骤还没有新的 Ubuntu 执行结果。
- 新增 Linux Secret Service API Key helper：支持隐藏录入一次、后续命令启动时把密钥仅放入该子进程的 `LT_EXPERIMENT_API_KEY` 环境；不写仓库/配置文件。合成 helper 测试已加入 Ubuntu workflow，本地 Windows 会跳过这两项 Linux 专属测试。
- 这些代码和配置检查不产生模型对比样本，不能据此排名 A/B/C/D；隔离 Gateway 的插件加载、工具可见性和会话派发仍未端到端复核。

## 后续门槛

1. 在 Ubuntu CI 运行四个 profile 的固定版本 OpenClaw CLI dry-run；这不需要 API Key，也不启动 Gateway。
2. 之后在隔离 Gateway 验证插件加载、工具可见性、会话权限和 Mock 状态工具接线，仍不连接 HA。
3. 只有在模型服务健康并明确授权具体调用范围后才运行模型样本；服务端 503/超时就停止当前波次，不自动重发。
4. 按 `EXPERIMENT-PROTOCOL.md` 完成 A/B/C/D 同场对照和重复样本后再讨论整体架构选择。
