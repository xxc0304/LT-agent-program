import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { createAgentToAgentPolicy, createSessionVisibilityRowChecker, resolveEffectiveSessionToolsVisibility } from "openclaw/plugin-sdk/session-visibility";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";

import { PlatformAgentRegistry } from "./platform-agent-registry.js";
import { createPlatformOrchestrator } from "./platform-orchestrator.js";
import { createOpenClawPlatformAgentInvoker } from "./openclaw-platform-adapter.js";

const FRONTDOOR_TOOL = {
  name: "orchestrate_household_agents",
  label: "家庭多 Agent 协作",
  description: [
    "这是家庭用户主对话的通用多 Agent 调度入口。先理解用户本轮真实需求，再根据已登记 Agent 及能力拆成一个或多个步骤，设置必要依赖后一次提交。",
    "你应按任务内容动态选择 Agent，不要固定每次只调用设备管家，也不要把所有 Agent 机械地依次调用。可并行的独立分析步骤可以并行；设备管家操作放在分析之后。",
    "只可使用插件当前登记清单中的 Agent 和能力，不得编造 Agent ID 或能力名。若目标不清楚，但补充信息后可能由现有能力完成，提交 decision=clarify 和一句面向用户的日常语言 question，不提交执行步骤；若确认当前能力清单没有能完成目标的功能，提交 decision=unsupported 和简短、诚实的 message，不提交执行步骤。用户回答澄清问题后，再结合新信息重新规划。多个现有能力可以组合完成的任务，应正常提交 dispatch 计划，不要因为没有一条完全同名的规则就判定不支持。",
    "多设备操作必须作为一个完整任务交给设备管家，由它统一解析设备清单、校验候选计划和动作冲突；不要拆成多个可能各自执行的 device_action 步骤。",
    "工具会校验 Agent 白名单、能力、步骤依赖和设备动作冲突。若 BLOCKED 的 reason_code 是 DEVICE_ACTION_DETAILS_REQUIRED 或 MULTIPLE_DEVICE_ACTION_STEPS_REQUIRE_AGGREGATION，这是计划结构问题：不要把内部错误转述给用户；将完整设备意图合并成单个设备管家操作步骤，只自动重提一次。若仍被阻断，或用户目标本身不清楚，再用自然语言向用户解释/澄清。其他需要澄清、确认或报告冲突的结果，必须用自然、简短的日常语言询问并等待答复。其他 BLOCKED 或 FAILED 结果应说明安全停止原因，不得绕过限制。",
    "业务 Agent 只提供各自职责内的分析或建议；只有设备管家可以执行设备操作，并且必须遵守其已有设备登记、授权、确认、执行和状态回读规则。不得把模型给出的计划当作执行授权。",
    "若工具返回 UNSUPPORTED，使用返回的 message 向用户说明目前缺少相应功能；不要尝试编造别的 Agent/能力或绕过平台调度器。",
    "Agent 没有登记、Gateway 拒绝、结果不确定或执行失败时，如实告知用户，不得声称成功或自动重复可能已经产生副作用的调用。",
  ].join(" "),
  inputSchema: Type.Object({
    request: Type.String({ minLength: 1, maxLength: 4_000, description: "用户本轮的原始家庭需求，不要附带无关聊天历史。" }),
    plan: Type.Object({
      decision: Type.Optional(Type.Union([
        Type.Literal("dispatch", { description: "按 steps 调用已登记 Agent；省略时也按 dispatch 处理。" }),
        Type.Literal("clarify", { description: "目标可能可由现有能力完成，但缺少关键信息；先向用户提问，不执行步骤。" }),
        Type.Literal("unsupported", { description: "当前登记能力无法完成该目标；如实告知，不执行步骤。" }),
      ])),
      trace_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      question: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000, description: "decision=clarify 时给用户看的简短自然语言问题。" })),
      message: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000, description: "decision=unsupported 时给用户看的简短说明，不要提内部 Agent 名称或状态码。" })),
      steps: Type.Optional(Type.Array(Type.Object({
        step_id: Type.String({ minLength: 1, maxLength: 128 }),
        agent_id: Type.String({ minLength: 1, maxLength: 64 }),
        capability: Type.String({ minLength: 1, maxLength: 128 }),
        task: Type.String({ minLength: 1, maxLength: 4_000 }),
        input: Type.Optional(Type.Record(Type.String(), Type.Any())),
        depends_on: Type.Optional(Type.Array(Type.String())),
        action: Type.Optional(Type.Object({
          name: Type.Optional(Type.String({ minLength: 1 })),
          action: Type.Optional(Type.String({ minLength: 1 })),
          target_ref: Type.Optional(Type.Object({ device_id: Type.String({ minLength: 1 }) }, { additionalProperties: false })),
          resource_id: Type.Optional(Type.String({ minLength: 1 })),
          conflict_group: Type.Optional(Type.String({ minLength: 1 })),
          parameters: Type.Optional(Type.Record(Type.String(), Type.Any())),
        }, { additionalProperties: false })),
      }, { additionalProperties: false }), { maxItems: 12 })),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
};

const DEFAULT_AGENTS = Object.freeze([
  {
    agent_id: "learning-companion",
    name: "儿童学习伴学 Agent",
    description: "分析学习活动并反馈学习相关信息，不执行设备操作。",
    capabilities: [{ name: "analyze_learning_activity", description: "分析明确提供的学习活动或学习事件", effect: "planning" }],
  },
  {
    agent_id: "energy-saving",
    name: "节能 Agent",
    description: "分析能耗与节能机会，提出节能建议，不执行设备操作。",
    capabilities: [{ name: "evaluate_energy_opportunity", description: "评估家庭节能机会并给出建议", effect: "planning" }],
  },
  {
    agent_id: "device-manager",
    name: "设备管家 Agent",
    description: "查询、规划或执行家庭设备任务；设备操作继续受设备管家自身的安全和确认流程约束。",
    capabilities: [
      { name: "inspect_household", description: "查询家庭设备和状态", effect: "read_only" },
      { name: "manage_household_devices", description: "处理设备操作请求并执行设备管家安全流程", effect: "device_action" },
    ],
  },
]);

function agentDefinitions(pluginConfig) {
  const additions = pluginConfig?.additionalAgents ?? [];
  if (!Array.isArray(additions)) throw new Error("additionalAgents must be an array");
  return [...DEFAULT_AGENTS, ...additions];
}

function frontdoorDescription(registeredAgents) {
  const inventory = registeredAgents.map((agent) => {
    const capabilities = (agent.capabilities ?? []).map((capability) =>
      `${capability.name} (${capability.effect ?? "read_only"})${capability.description ? `：${capability.description}` : ""}`,
    ).join("；");
    return `- ${agent.agent_id}（${agent.name}）：${capabilities}`;
  }).join("\n");
  return `${FRONTDOOR_TOOL.description}\n当前可用 Agent 和能力清单：\n${inventory}`;
}

function createFrontdoorTool({ api, config: pluginConfig, toolContext }) {
  const frontdoorAgentId = pluginConfig?.frontdoorAgentId?.trim() || "dev";
  if (toolContext?.agentId !== frontdoorAgentId
    || typeof toolContext.sessionKey !== "string"
    || !toolContext.sessionKey.startsWith(`agent:${frontdoorAgentId}:`)) return null;

  const runtimeConfig = toolContext.getRuntimeConfig?.()
    ?? toolContext.runtimeConfig
    ?? toolContext.config
    ?? api.config;
  const registeredAgents = agentDefinitions(pluginConfig);
  const invoke = createOpenClawPlatformAgentInvoker({
    subagentRun: api.runtime.subagent.run.bind(api.runtime.subagent),
    subagentWaitForRun: api.runtime.subagent.waitForRun.bind(api.runtime.subagent),
    subagentGetSessionMessages: api.runtime.subagent.getSessionMessages.bind(api.runtime.subagent),
    requesterAgentId: frontdoorAgentId,
    requesterSessionKey: toolContext.sessionKey,
    config: runtimeConfig,
    agentIds: registeredAgents.map((agent) => agent.agent_id),
    authorizeTarget({ requesterAgentId, requesterSessionKey, targetAgentId, targetSessionKey, action }) {
      if (requesterAgentId !== frontdoorAgentId
        || !requesterSessionKey?.startsWith(`agent:${frontdoorAgentId}:`)) {
        return { allowed: false, error: "The caller is not the configured OpenClaw frontdoor session" };
      }
      const a2aPolicy = createAgentToAgentPolicy(runtimeConfig);
      const visibility = resolveEffectiveSessionToolsVisibility({
        cfg: runtimeConfig,
        sandboxed: toolContext.sandboxed === true,
      });
      return createSessionVisibilityRowChecker({
        action,
        requesterSessionKey,
        visibility,
        a2aPolicy,
      }).check({ key: targetSessionKey, agentId: targetAgentId });
    },
  });

  const registry = new PlatformAgentRegistry();
  for (const agent of registeredAgents) {
    registry.registerAgent({ ...agent, invoke });
  }
  const orchestrator = createPlatformOrchestrator({ registry });

  return {
    name: FRONTDOOR_TOOL.name,
    label: FRONTDOOR_TOOL.label,
    description: frontdoorDescription(registeredAgents),
    parameters: FRONTDOOR_TOOL.inputSchema,
    async execute(toolCallId, params, signal) {
      signal?.throwIfAborted();
      const traceId = params.plan.trace_id?.trim() || `trace-platform-${randomUUID()}`;
      try {
        const result = await orchestrator.run({
          request: params.request,
          plan: { ...params.plan, trace_id: traceId },
        });
        return jsonResult({ ...result, tool_call_id: toolCallId });
      } catch (error) {
        return jsonResult({
          status: "FAILED",
          trace_id: traceId,
          execution_performed: false,
          error: {
            code: error?.code ?? "PLATFORM_ORCHESTRATION_FAILED",
            message: error instanceof Error ? error.message : "Platform orchestration failed",
          },
          tool_call_id: toolCallId,
        });
      }
    },
  };
}

const toolPlugin = defineToolPlugin({
  id: "platform-orchestrator",
  name: "家庭多 Agent 平台调度器",
  description: "为 OpenClaw 用户主对话提供可扩展的 Agent 注册、动态计划校验、多 Agent 调用、冲突检测和用户澄清入口。",
  configSchema: Type.Object({
    frontdoorAgentId: Type.Optional(Type.String({ minLength: 1 })),
    additionalAgents: Type.Optional(Type.Array(Type.Object({
      agent_id: Type.String({ minLength: 1, maxLength: 64 }),
      name: Type.String({ minLength: 1 }),
      description: Type.Optional(Type.String()),
      capabilities: Type.Array(Type.Object({
        name: Type.String({ minLength: 1 }),
        description: Type.Optional(Type.String()),
        effect: Type.Union([Type.Literal("read_only"), Type.Literal("planning")]),
      }, { additionalProperties: false }), { minItems: 1 }),
    }, { additionalProperties: false }))),
  }, { additionalProperties: false }),
  tools: (tool) => [tool({
    name: FRONTDOOR_TOOL.name,
    label: FRONTDOOR_TOOL.label,
    description: FRONTDOOR_TOOL.description,
    parameters: FRONTDOOR_TOOL.inputSchema,
    factory: (context) => createFrontdoorTool(context),
  })],
});

export { DEFAULT_AGENTS, FRONTDOOR_TOOL, createFrontdoorTool };
export default toolPlugin;
