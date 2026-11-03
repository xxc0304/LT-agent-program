# 项目进度：多 Agent 编排方案研究与实验准备

**状态：方案尚未定案；对比实验尚无足够有效样本。**

## 已完成

- 将老师提供的 `AGENTS.md` 路由作为 A 组基线，与项目平台编排器 B、Manager/Agent-as-tools C 进行定义对齐；把 B 的“按需提交最小计划”列为 D 组待验证变体。
- 调研 OpenClaw、Home Assistant 及智慧家庭任务评测相关资料，明确比较时需要关注意图和路由质量、设备安全边界、任务状态验证、Agent 调用开销、延迟，以及边缘网关资源。
- 复核 A/B/C 首轮探索性记录，发现样本只有每场景一次、汇总引用轮次不一致、专家 token 缺失等问题。旧结果不能用于排名或定案。
- 完成 A/B/C/D 实验协议草案，规定共同的合成家庭场景、统一 Mock 初始状态、安全门、重复运行、资源采集和停止条件。
- 记录 B/D Windows pilot 的失败原因：没有形成有效配对场景结果；DeepSeek 503 和连接失败按环境故障处理，不计为模型方案表现。
- 保留旧模型原始轨迹仅在本机。公开仓库不提交包含模型对话/推理字段的原始记录、旧版 Word 报告或含本机路径的运行日志。

## 当前结论

目前没有证据证明 A、B、C 或 D 中任何一个普遍更优。现阶段推荐的是继续按统一协议做对照验证，而不是提前确定架构。固定输入的编排器 Mock 验证只能说明代码校验路径的行为，不能代替自然语言理解和 Agent 路由实验。

## 下一步

1. 让所有候选共用可重置的 Mock 家庭状态读取、模拟动作和动作后回读能力。
2. 先完成不调用模型的离线检查，确认输入、状态、动作日志和最终状态能对应起来。
3. 服务可用后按协议运行小样本 A/B/C/D 对照；遇到服务端错误时暂停当前波次并单独记录。
4. 对通过安全门且结果完整的候选增加重复样本，并采集目标 Linux 环境下的 Gateway CPU/RSS；模型云端推理资源与本地资源分开统计。
5. 根据质量、安全、必要调用、延迟和资源的实际数据再形成方案建议，并说明适用范围与未验证项。

详细方案和审计记录见 [`multi-agent-orchestration-decision-v1.md`](multi-agent-orchestration-decision-v1.md)、[`multi-agent-orchestration-research-review-2026-11-03.md`](multi-agent-orchestration-research-review-2026-11-03.md) 和 [`../experiments/orchestration-comparison-v2/EXPERIMENT-PROTOCOL.md`](../experiments/orchestration-comparison-v2/EXPERIMENT-PROTOCOL.md)。
