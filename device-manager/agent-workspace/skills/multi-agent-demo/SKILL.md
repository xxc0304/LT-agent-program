---
name: multi-agent-demo
description: 用户明确要求演示或模拟多 Agent 协作时，用自然语言发起本地 Mock 事件链路。
user-invocable: true
---

# 多 Agent 协作演示

仅在用户明确请求“演示”“模拟”或“展示多 Agent 协作链路”时使用。自然语言理解由 OpenClaw Agent 完成；然后调用 `run_mock_agent_chain_demo`，`scenario: "learning_departure"`。

## 演示流程

1. 用户可用自然语言描述，例如：“演示一下孩子离开书桌十分钟后，能源管家如何和设备管家协作关灯。”
2. 调用演示工具后，简洁说明链路阶段、涉及 Agent、任务回执和灯具最终状态。
3. 明确指出运行于 Mock HA；占用与学习事件是工具临时生成的合成样例，不是模型识图结果、真实儿童行为或 HA 传感器事件；未访问或控制真实家电。

## 边界

- 本 Skill 是演示入口，不是生产自动化。不得在没有用户明确演示请求时自动调用。
- 不得把用户的自然语言陈述当作真实视觉/传感器佐证。生产事件必须来自可信适配器，再交由 `dispatch_agent_event`。
- 当前只支持 `learning_departure` 演示场景。其他请求应说明暂不支持，不得临时拼造设备动作或场景。
