import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { createAgentToAgentPolicy, createSessionVisibilityRowChecker, resolveEffectiveSessionToolsVisibility } from "openclaw/plugin-sdk/session-visibility";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";

import { createOpenClawPlatformAgentInvoker } from "../../../../../multi-agent-orchestrator/src/openclaw-platform-adapter.js";

const FRONTDOOR_DEFAULT = "dev";
const TARGET_DEFAULTS = Object.freeze({
  device_steward: "device-specialist-tool",
  safety_review: "safety-review-tool",
  energy_manager: "energy-specialist-tool",
  learning_companion: "learning-specialist-tool",
});
const TOOL_SPECS = Object.freeze([
  {
    name: "call_device_specialist",
    logicalAgent: "device_steward",
    capability: "inspect_household",
    label: "咨询设备专家",
    description: "需要查询合成设备快照、设备属性或澄清设备请求时调用。只读或生成 dry-run 动作意图，不执行设备写入。",
  },
  {
    name: "call_safety_review",
    logicalAgent: "safety_review",
    capability: "review_safety",
    label: "咨询安全评估专家",
    description: "遇到状态可信度、过期事件、指令冲突或敏感动作时调用。返回风险分析，不操作设备。",
  },
  {
    name: "call_energy_specialist",
    logicalAgent: "energy_manager",
    capability: "analyze_energy",
    label: "咨询能源专家",
    description: "需要依据已提供的合成设备参数和电价作能耗或费用分析时调用；不得启动设备。",
  },
  {
    name: "call_learning_specialist",
    logicalAgent: "learning_companion",
    capability: "analyze_learning_event",
    label: "咨询学习事件专家",
    description: "需要规范化合成学习事件或读取明确提供的学习上下文时调用；不得推断未提供的数据。",
  },
]);

const INPUT_SCHEMA = Type.Object({
  request: Type.String({ minLength: 1, maxLength: 4_000 }),
  scenario_id: Type.String({ minLength: 1, maxLength: 128 }),
  synthetic_context: Type.Optional(Type.Record(Type.String(), Type.Any())),
  dependency_results: Type.Optional(Type.Record(Type.String(), Type.Any())),
  constraints: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 20 })),
  trace_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});

function resolvedTargets(config = {}) {
  const configured = config.targets ?? {};
  const targets = Object.fromEntries(Object.entries(TARGET_DEFAULTS).map(([key, fallback]) => {
    const value = configured[key] ?? fallback;
    if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value.trim())) {
      throw new Error(`Invalid target Agent ID for ${key}`);
    }
    return [key, value.trim()];
  }));
  if (new Set(Object.values(targets)).size !== Object.keys(targets).length) {
    throw new Error("Each logical expert must map to a distinct Agent ID");
  }
  return targets;
}

function createInvoker({ api, config, toolContext, targets, requesterId }) {
  const runtimeConfig = toolContext?.getRuntimeConfig?.()
    ?? toolContext?.runtimeConfig
    ?? toolContext?.config
    ?? api.config;
  return createOpenClawPlatformAgentInvoker({
    subagentRun: api.runtime.subagent.run.bind(api.runtime.subagent),
    subagentWaitForRun: api.runtime.subagent.waitForRun.bind(api.runtime.subagent),
    subagentGetSessionMessages: api.runtime.subagent.getSessionMessages.bind(api.runtime.subagent),
    requesterAgentId: requesterId,
    requesterSessionKey: toolContext.sessionKey,
    config: runtimeConfig,
    agentIds: Object.values(targets),
    timeoutMs: config.timeoutMs ?? 120_000,
    authorizeTarget({ requesterAgentId, requesterSessionKey, targetAgentId, targetSessionKey, action }) {
      if (requesterAgentId !== requesterId || !requesterSessionKey.startsWith(`agent:${requesterId}:`)) {
        return { allowed: false, error: "The caller is not the configured manager Agent session" };
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
}

function createExpertTool({ api, config, toolContext, spec }) {
  const requesterId = config.frontdoorAgentId?.trim() || FRONTDOOR_DEFAULT;
  if (toolContext?.agentId !== requesterId
    || typeof toolContext.sessionKey !== "string"
    || !toolContext.sessionKey.startsWith(`agent:${requesterId}:`)) return null;

  let targets;
  let invoke;
  try {
    targets = resolvedTargets(config);
    invoke = createInvoker({ api, config, toolContext, targets, requesterId });
  } catch {
    return null;
  }

  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: INPUT_SCHEMA,
    async execute(toolCallId, params, signal) {
      signal?.throwIfAborted();
      const targetAgentId = targets[spec.logicalAgent];
      const traceId = params.trace_id?.trim() || `trace-manager-tools-${randomUUID()}`;
      try {
        const response = await invoke({
          agentId: targetAgentId,
          capability: spec.capability,
          traceId,
          stepId: toolCallId,
          task: `场景 ${params.scenario_id}：${params.request}`,
          originalRequest: params.request,
          input: {
            scenario_id: params.scenario_id,
            synthetic_context: params.synthetic_context ?? {},
            constraints: params.constraints ?? ["dry_run_only", "no_real_ha", "no_device_writes"],
          },
          dependencyResults: params.dependency_results ?? {},
          context: { orchestration_strategy: "C_manager_agent_as_tools" },
        });
        return jsonResult({
          strategy: "C",
          logical_agent_id: spec.logicalAgent,
          configured_agent_id: targetAgentId,
          trace_id: traceId,
          response,
          tool_call_id: toolCallId,
        });
      } catch (error) {
        return jsonResult({
          strategy: "C",
          logical_agent_id: spec.logicalAgent,
          configured_agent_id: targetAgentId,
          trace_id: traceId,
          status: "FAILED",
          error: {
            code: error?.code ?? "MANAGER_EXPERT_CALL_FAILED",
            message: error instanceof Error ? error.message : "Expert call failed",
            sent_before_error: error?.sentBeforeError === true,
          },
          retry_instruction: "Do not automatically resend. Check the expert session and trace first.",
          tool_call_id: toolCallId,
        });
      }
    },
  };
}

const plugin = defineToolPlugin({
  id: "manager-agent-tools",
  name: "Orchestration Comparison Manager Agent Tools",
  description: "Provides callable expert tools for experiment strategy C; it does not generate a DAG or perform plan validation.",
  configSchema: Type.Object({
    frontdoorAgentId: Type.Optional(Type.String({ minLength: 1 })),
    targets: Type.Optional(Type.Object({
      device_steward: Type.Optional(Type.String({ minLength: 1 })),
      safety_review: Type.Optional(Type.String({ minLength: 1 })),
      energy_manager: Type.Optional(Type.String({ minLength: 1 })),
      learning_companion: Type.Optional(Type.String({ minLength: 1 })),
    }, { additionalProperties: false })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 120_000 })),
  }, { additionalProperties: false }),
  tools: (tool) => TOOL_SPECS.map((spec) => tool({
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: INPUT_SCHEMA,
    factory: (context) => createExpertTool({ ...context, spec }),
  })),
});

export { INPUT_SCHEMA, TARGET_DEFAULTS, TOOL_SPECS, createExpertTool };
export default plugin;
