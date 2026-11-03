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

## 下一步门槛

1. 先修好共享 Mock 状态查询与模拟动作回读接口，并保证每个场景运行前可重置。
2. 先做离线协议检查，确认“用户文本不泄露传感器值、状态从 Mock 工具取得、动作只变更模拟状态”。
3. 服务恢复后先运行单次配对健康样本；服务端 503/超时就停止当前波次，不自动重发。
4. B/D 子实验完成后仍需按 `EXPERIMENT-PROTOCOL.md` 运行 A/B/C/D 全面对照，才讨论整体架构选择。
