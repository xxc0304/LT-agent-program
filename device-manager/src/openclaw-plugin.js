import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { createAgentToAgentPolicy, createSessionVisibilityRowChecker, resolveEffectiveSessionToolsVisibility } from "openclaw/plugin-sdk/session-visibility";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Type } from "typebox";

import { createDeviceToolRuntime, DEVICE_TOOL_DEFINITIONS } from "./tools.js";
import { createInventoryGuardedDeviceRuntime, DeviceInventory } from "./device-inventory.js";
import { DEVICE_INVENTORY_TOOL_DEFINITIONS } from "./device-inventory-tools.js";
import { createOrchestratorBridge } from "./orchestrator-bridge.js";
import { ORCHESTRATOR_TOOL_DEFINITIONS } from "./orchestrator-tools.js";
import { defaultMemoryDatabasePath, PreferenceMemoryStore } from "../../agent-memory/src/memory-store.js";
import { createHomeAssistantDeviceActionObserver } from "../../agent-memory/src/home-assistant-device-action-observer.js";
import { createHouseholdMemoryTools, HOUSEHOLD_MEMORY_TOOL_DEFINITIONS } from "./memory-tools.js";
import { createHouseholdRoutineNotificationTools, ROUTINE_NOTIFICATION_TOOL_DEFINITIONS } from "./routine-notification-tools.js";
import { createScenePlanningTools, SCENE_PLANNING_TOOL_DEFINITIONS } from "./scene-planning-tools.js";
import { executeMockAgentChainTool, MOCK_AGENT_CHAIN_TOOL_DEFINITION } from "./mock-agent-chain-tool.js";
import { executeMockMemoryLearningTool, MOCK_MEMORY_LEARNING_TOOL_DEFINITION } from "./mock-memory-learning-tool.js";
import { executeMockMaintenanceReminderTool, MOCK_MAINTENANCE_REMINDER_TOOL_DEFINITION } from "./mock-maintenance-reminder-tool.js";
import { AGENT_PLAN_TOOL_DEFINITIONS } from "./agent-plan-tools.js";
import { SCENES } from "./scenes.js";
import { createAdaptiveEnergySceneTools, ADAPTIVE_ENERGY_SCENE_TOOL_DEFINITIONS } from "./adaptive-energy-scene-tools.js";
import { createHouseholdDeviceMonitorTools, DEVICE_MONITOR_TOOL_DEFINITIONS } from "./device-monitor-tools.js";
import { AgentApprovalStateStore } from "./agent-approval-state-store.js";
import { OpenClawAgentClient, OPENCLAW_AGENT_TARGETS } from "../../multi-agent-orchestrator/src/openclaw-agent-client.js";
import { createOpenClawGatewaySendMessage } from "../../multi-agent-orchestrator/src/openclaw-gateway-transport.js";
import { createOpenClawFrontdoorTransport } from "../../multi-agent-orchestrator/src/openclaw-frontdoor-transport.js";
import { createIndependentEnergyWorkflow } from "./independent-energy-workflow.js";
import { createEnergyOperationsTools, ENERGY_OPERATIONS_TOOL_DEFINITIONS } from "./energy-operations-tools.js";
import { MaintenanceScheduleStore } from "./maintenance-store.js";
import { createMaintenanceReminderTools, MAINTENANCE_REMINDER_TOOL_DEFINITIONS } from "./maintenance-reminder-tools.js";
import { MaintenanceReminderInbox } from "./maintenance-reminder-inbox.js";

function readDurationMs(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error(`${name} 必须是 1 到 2147483647 之间的整数毫秒`);
  }
  return value;
}

function configureMemoryStoreFromPluginConfig(store, pluginConfig = {}) {
  const hasBackend = Object.hasOwn(pluginConfig, "memoryBackend");
  const hasDatabasePath = Object.hasOwn(pluginConfig, "memoryDatabasePath");
  if (!hasBackend && !hasDatabasePath) return;

  const backend = pluginConfig.memoryBackend;
  if (backend !== "json" && backend !== "sqlite") {
    throw new TypeError("device-manager memoryBackend must be 'json' or 'sqlite'");
  }
  if (hasDatabasePath && backend !== "sqlite") {
    throw new TypeError("device-manager memoryDatabasePath requires memoryBackend='sqlite'");
  }

  let databasePath;
  if (backend === "sqlite") {
    databasePath = hasDatabasePath
      ? pluginConfig.memoryDatabasePath
      : defaultMemoryDatabasePath({ ...process.env, FAMILY_MEMORY_DB_PATH: undefined });
    if (typeof databasePath !== "string" || !databasePath.trim() || !path.isAbsolute(databasePath)) {
      throw new TypeError("device-manager memoryDatabasePath must be an absolute SQLite file path");
    }
  }
  store.configurePersistence({ backend, ...(databasePath ? { databasePath } : {}) });
}

const criticalOfflineEntityIds = (process.env.DEVICE_MANAGER_CRITICAL_MONITOR_ENTITIES ?? "")
  .split(",")
  .map((entityId) => entityId.trim())
  .filter(Boolean);
const householdMemoryObserverUserIds = (process.env.HOUSEHOLD_HA_OBSERVATION_USER_IDS ?? "")
  .split(",")
  .map((userId) => userId.trim())
  .filter(Boolean);

const baseRuntime = createDeviceToolRuntime();
const deviceInventory = new DeviceInventory({
  deviceClient: { listDevices: () => baseRuntime.invoke("list_devices") },
});
const approvalStateStore = new AgentApprovalStateStore();
const runtime = createInventoryGuardedDeviceRuntime(baseRuntime, deviceInventory, { scenes: SCENES });
const orchestrator = createOrchestratorBridge(runtime, { deviceInventory, approvalStateStore });
const agentPlans = orchestrator.agentPlanTools;
const memoryStore = new PreferenceMemoryStore({
  // Existing installations keep their JSON store unless deployment opts in.
  // Shared deployment configuration selects SQLite before Gateway startup.
  backend: process.env.FAMILY_MEMORY_BACKEND ?? "json",
  ...(process.env.FAMILY_MEMORY_DB_PATH ? { databasePath: process.env.FAMILY_MEMORY_DB_PATH } : {}),
});
const maintenanceStore = new MaintenanceScheduleStore();
const maintenanceReminderInbox = new MaintenanceReminderInbox();
const energyOperations = createEnergyOperationsTools({ maintenanceStore, reminderInbox: maintenanceReminderInbox });
const maintenanceReminders = createMaintenanceReminderTools({
  scheduleStore: maintenanceStore,
  inbox: maintenanceReminderInbox,
  pollIntervalMs: readDurationMs("DEVICE_MANAGER_MAINTENANCE_REMINDER_POLL_MS", 60 * 60_000),
});
let homeAssistantStateMonitor = null;
const householdDeviceActionObserver = createHomeAssistantDeviceActionObserver({
  store: memoryStore,
  deviceInventory,
  timeZone: process.env.HOUSEHOLD_TIME_ZONE,
});
const householdMemory = createHouseholdMemoryTools(memoryStore, {
  onDeviceActionObservationConsentChanged(enabled) {
    homeAssistantStateMonitor?.setUserActionObserver(enabled
      ? (event) => householdDeviceActionObserver.observe(event)
      : null);
  },
});
const householdRoutineNotifications = createHouseholdRoutineNotificationTools({ store: memoryStore });
const scenePlanning = createScenePlanningTools({
  deviceRuntime: runtime,
  getHouseholdPreference: householdMemory.get_household_preference,
});
const adaptiveEnergyScenes = createAdaptiveEnergySceneTools({
  deviceRuntime: runtime,
  deviceInventory,
});
const householdDeviceMonitor = createHouseholdDeviceMonitorTools({
  deviceInventory,
  diagnoseDevice: (params) => baseRuntime.invoke("diagnose_device", params),
  recordDiagnosticAlert: (diagnosis) => baseRuntime.homeAssistant.recordDiagnosticAlert?.(diagnosis),
  recordDiagnosticSharedInfrastructure: (incident) => baseRuntime.homeAssistant.recordDiagnosticSharedInfrastructure?.(incident),
  recordDiagnosticSharedInfrastructureResolved: (resolution) => baseRuntime.homeAssistant.recordDiagnosticSharedInfrastructureResolved?.(resolution),
  recordDiagnosticTransient: (transient) => baseRuntime.homeAssistant.recordDiagnosticTransient?.(transient),
  recordDiagnosticRecovery: (recovery) => baseRuntime.homeAssistant.recordDiagnosticRecovery?.(recovery),
  recordDiagnosticTrackingEnded: (resolution) => baseRuntime.homeAssistant.recordDiagnosticTrackingEnded?.(resolution),
  offlineGraceMs: readDurationMs("DEVICE_MANAGER_OFFLINE_GRACE_MS", 120_000),
  criticalOfflineGraceMs: readDurationMs("DEVICE_MANAGER_CRITICAL_OFFLINE_GRACE_MS", 15_000),
  criticalOfflineEntityIds,
  createMonitor: typeof baseRuntime.homeAssistant.createStateMonitor === "function"
    ? (options) => {
        homeAssistantStateMonitor = baseRuntime.homeAssistant.createStateMonitor({
          ...options,
          trustedUserIds: householdMemoryObserverUserIds,
        });
        return homeAssistantStateMonitor;
      }
    : null,
  prepareMonitor: async (monitor) => {
    const consent = await memoryStore.getDeviceActionObservationConsent();
    monitor.setUserActionObserver?.(consent.enabled === true
      ? (event) => householdDeviceActionObserver.observe(event)
      : null);
  },
});

const TOOL_DEFINITIONS = [
  ...DEVICE_TOOL_DEFINITIONS,
  ...ORCHESTRATOR_TOOL_DEFINITIONS,
  ...AGENT_PLAN_TOOL_DEFINITIONS,
  MOCK_AGENT_CHAIN_TOOL_DEFINITION,
  MOCK_MEMORY_LEARNING_TOOL_DEFINITION,
  MOCK_MAINTENANCE_REMINDER_TOOL_DEFINITION,
  ...HOUSEHOLD_MEMORY_TOOL_DEFINITIONS,
  ...ROUTINE_NOTIFICATION_TOOL_DEFINITIONS,
  ...SCENE_PLANNING_TOOL_DEFINITIONS,
  ...ADAPTIVE_ENERGY_SCENE_TOOL_DEFINITIONS,
  ...DEVICE_MONITOR_TOOL_DEFINITIONS,
  ...DEVICE_INVENTORY_TOOL_DEFINITIONS,
  ...ENERGY_OPERATIONS_TOOL_DEFINITIONS,
  ...MAINTENANCE_REMINDER_TOOL_DEFINITIONS,
  {
    name: "talk_to_device_manager",
    label: "talk_to_device_manager",
    description:
      "旧版兼容入口，仅在平台级 orchestrate_household_agents 工具未安装时使用。若通用平台调度器已可用，所有家庭请求必须先交给 orchestrate_household_agents，由 OpenClaw 按任务选择一个或多个已登记 Agent；不要绕过平台调度而固定转给设备管家。仅兼容旧部署时，本工具才把本轮原话转给设备管家 Agent。不要转交 API Key、密码、令牌、认证内容、图片/视频或无关聊天记录。调用结果不代表操作成功，必须依据 Agent 实际回复如实回应。",
    inputSchema: Type.Object({
      request: Type.String({
        minLength: 1,
        maxLength: 4_000,
        description: "只包含用户本轮的家庭设备请求或对设备管家追问的回复；不要附带凭据或无关历史对话。",
      }),
    }, { additionalProperties: false }),
  },
  {
    name: "call_independent_agent",
    label: "call_independent_agent",
    description:
      "通过 OpenClaw Gateway 同步调用一个已注册的独立业务 Agent，并严格校验其 Event/Task JSON 输出。仅设备管家 Agent 会话中可用，目标限学习伴学或节能 Agent；此工具只生成/返回候选结果，不执行设备动作、不授予策略批准，也不替代后续调度器校验。输入只放完成该任务所需的最少 JSON 数据，不要传 API Key、认证信息、原始图片/视频或无关日常对话。",
    inputSchema: Type.Object({
      agent_id: Type.Union(OPENCLAW_AGENT_TARGETS.map((agentId) => Type.Literal(agentId))),
      input: Type.Record(Type.String(), Type.Any(), { description: "发送给指定 Agent 的最小 JSON 输入。" }),
      trace_id: Type.Optional(Type.String({ minLength: 1 })),
      idempotency_key: Type.Optional(Type.String({ minLength: 1 })),
    }, { additionalProperties: false }),
  },
  {
    name: "evaluate_energy_event_with_independent_agent",
    label: "evaluate_energy_event_with_independent_agent",
    description:
      "把一个标准 Event 交给独立 energy-saving Agent 评估。若返回严格校验的 NO_ACTION，则正常结束且不操作设备；若返回 Task，则由设备管家送入现有计划校验/确认/执行/回读流程。对话输入不是已认证传感器来源，因此候选设备动作必须经用户确认；本工具不允许独立节能 Agent 直接控制 HA。",
    inputSchema: Type.Object({
      event: Type.Record(Type.String(), Type.Any(), { description: "符合公共 event.schema.json 的事件对象；不要伪造传感器认证，也不要包含图片、视频或认证数据。" }),
      trace_id: Type.Optional(Type.String({ minLength: 1 })),
      idempotency_key: Type.Optional(Type.String({ minLength: 1 })),
    }, { additionalProperties: false }),
  },
];

function createAuthorizedHouseholdFrontdoor({ api, config: pluginConfig, toolContext }) {
  const frontdoorAgentId = typeof pluginConfig?.frontdoorAgentId === "string" && pluginConfig.frontdoorAgentId.trim()
    ? pluginConfig.frontdoorAgentId.trim()
    : "dev";
  if (toolContext?.agentId !== frontdoorAgentId
    || typeof toolContext.sessionKey !== "string"
    || !toolContext.sessionKey.startsWith(`agent:${frontdoorAgentId}:`)) return null;
  const runtimeConfig = toolContext.getRuntimeConfig?.()
    ?? toolContext.runtimeConfig
    ?? toolContext.config
    ?? api.config;
  const requesterSessionKey = toolContext.sessionKey;

  return createOpenClawFrontdoorTransport({
    subagentRun: api.runtime.subagent.run.bind(api.runtime.subagent),
    subagentWaitForRun: api.runtime.subagent.waitForRun.bind(api.runtime.subagent),
    subagentGetSessionMessages: api.runtime.subagent.getSessionMessages.bind(api.runtime.subagent),
    requesterAgentId: frontdoorAgentId,
    requesterSessionKey,
    config: runtimeConfig,
    authorizeTarget({ requesterAgentId, requesterSessionKey: activeSessionKey, targetAgentId, targetSessionKey, action }) {
      if (requesterAgentId !== frontdoorAgentId || !activeSessionKey?.startsWith(`agent:${frontdoorAgentId}:`)) {
        return { allowed: false, error: "调用方不是 OpenClaw 用户主 Agent 会话" };
      }
      const a2aPolicy = createAgentToAgentPolicy(runtimeConfig);
      const visibility = resolveEffectiveSessionToolsVisibility({
        cfg: runtimeConfig,
        sandboxed: toolContext.sandboxed === true,
      });
      return createSessionVisibilityRowChecker({
        action,
        requesterSessionKey: activeSessionKey,
        visibility,
        a2aPolicy,
      }).check({ key: targetSessionKey, agentId: targetAgentId });
    },
  });
}

function createHouseholdFrontdoorTool(definition, context) {
  const relay = createAuthorizedHouseholdFrontdoor(context);
  if (!relay) return null;

  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.inputSchema,
    async execute(toolCallId, params, signal) {
      signal?.throwIfAborted();
      const result = await relay({
        request: params.request,
        idempotencyKey: `openclaw-household:${toolCallId || randomUUID()}`,
      });
      return jsonResult({ ...result, tool_call_id: toolCallId });
    },
  };
}

function createAuthorizedIndependentAgentClient({ api, toolContext }) {
  // ToolPluginFactoryContext is populated by OpenClaw for the active agent
  // invocation; never accept a caller identity from model-supplied arguments.
  if (toolContext?.agentId !== "device-manager"
    || typeof toolContext.sessionKey !== "string"
    || !toolContext.sessionKey.startsWith("agent:device-manager:")) return null;
  const runtimeConfig = toolContext.getRuntimeConfig?.()
    ?? toolContext.runtimeConfig
    ?? toolContext.config
    ?? api.config;
  const requesterSessionKey = toolContext.sessionKey;

  const sendMessage = createOpenClawGatewaySendMessage({
    subagentRun: api.runtime.subagent.run.bind(api.runtime.subagent),
    subagentWaitForRun: api.runtime.subagent.waitForRun.bind(api.runtime.subagent),
    subagentGetSessionMessages: api.runtime.subagent.getSessionMessages.bind(api.runtime.subagent),
    requesterAgentId: toolContext.agentId,
    requesterSessionKey,
    config: runtimeConfig,
    authorizeTarget({ requesterAgentId, requesterSessionKey: activeSessionKey, targetAgentId, targetSessionKey, action }) {
      if (requesterAgentId !== "device-manager"
        || !activeSessionKey?.startsWith("agent:device-manager:")) {
      return { allowed: false, error: "调用方不是设备管家 Agent 会话" };
      }
      const a2aPolicy = createAgentToAgentPolicy(runtimeConfig);
      const visibility = resolveEffectiveSessionToolsVisibility({
        cfg: runtimeConfig,
        sandboxed: toolContext.sandboxed === true,
      });
      return createSessionVisibilityRowChecker({
        action,
        requesterSessionKey: activeSessionKey,
        visibility,
        a2aPolicy,
      }).check({ key: targetSessionKey, agentId: targetAgentId });
    },
  });
  return new OpenClawAgentClient({ sendMessage });
}

function createIndependentAgentTool(definition, context) {
  const client = createAuthorizedIndependentAgentClient(context);
  if (!client) return null;

  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.inputSchema,
    async execute(toolCallId, params, signal) {
      signal?.throwIfAborted();
      const traceId = params.trace_id?.trim() || `trace-openclaw-${randomUUID()}`;
      const idempotencyKey = params.idempotency_key?.trim()
        || `openclaw:${params.agent_id}:${traceId}`;
      try {
        const result = await client.invoke({
          agentId: params.agent_id,
          traceId,
          idempotencyKey,
          input: params.input,
        });
        return jsonResult({ ...result, tool_call_id: toolCallId });
      } catch (error) {
        return jsonResult({
          status: "error",
          error: {
            code: error?.code ?? "INDEPENDENT_AGENT_CALL_FAILED",
            message: error instanceof Error ? error.message : "独立 Agent 调用失败",
            ...(error?.details ? { details: error.details } : {}),
          },
        });
      }
    },
  };
}

function createIndependentEnergyWorkflowTool(definition, context) {
  const client = createAuthorizedIndependentAgentClient(context);
  if (!client) return null;
  const workflow = createIndependentEnergyWorkflow({
    agentClient: client,
    executeEnergyTask: (task) => agentPlans.executeEnergyTask(task, { trustedEventSource: false }),
  });

  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.inputSchema,
    async execute(toolCallId, params, signal) {
      signal?.throwIfAborted();
      try {
        const result = await workflow.evaluate({
          event: params.event,
          traceId: params.trace_id,
          idempotencyKey: params.idempotency_key,
        });
        return jsonResult({ ...result, tool_call_id: toolCallId });
      } catch (error) {
        return jsonResult({
          success: false,
          execution_performed: false,
          status: "ERROR",
          error: {
            code: error?.code ?? "INDEPENDENT_ENERGY_WORKFLOW_FAILED",
            message: error instanceof Error ? error.message : "独立节能 Agent 编排失败",
            ...(error?.details ? { details: error.details } : {}),
          },
          tool_call_id: toolCallId,
        });
      }
    },
  };
}

const toolPlugin = defineToolPlugin({
  id: "device-manager",
  name: "家庭设备管家",
  description: "为家庭微脑提供设备查询/控制、多 Agent 事件调度、家庭偏好记忆，以及经用户确认后执行并回读的场景工具，支持 Mock 与真实 Home Assistant REST 后端。",
  configSchema: Type.Object({
    frontdoorAgentId: Type.Optional(Type.String({ minLength: 1 })),
    memoryBackend: Type.Optional(Type.Union([Type.Literal("json"), Type.Literal("sqlite")])),
    memoryDatabasePath: Type.Optional(Type.String({
      minLength: 1,
      description: "SQLite 家庭记忆库的绝对路径；仅当 memoryBackend 设置为 sqlite 时填写。",
    })),
  }, { additionalProperties: false }),
  tools: (tool) =>
    TOOL_DEFINITIONS.map((definition) =>
      definition.name === "talk_to_device_manager"
        ? tool({
            name: definition.name,
            label: definition.label,
            description: definition.description,
            parameters: definition.inputSchema,
            factory: (context) => createHouseholdFrontdoorTool(definition, context),
          })
        : definition.name === "call_independent_agent"
        ? tool({
            name: definition.name,
            label: definition.label,
            description: definition.description,
            parameters: definition.inputSchema,
            factory: (context) => createIndependentAgentTool(definition, context),
          })
        : definition.name === "evaluate_energy_event_with_independent_agent"
          ? tool({
              name: definition.name,
              label: definition.label,
              description: definition.description,
              parameters: definition.inputSchema,
              factory: (context) => createIndependentEnergyWorkflowTool(definition, context),
            })
        : tool({
        name: definition.name,
        label: definition.name,
        description: definition.description,
        parameters: definition.inputSchema,
        async execute(params, _config, context) {
          context.signal?.throwIfAborted();
          if (definition.name === "run_scene") {
            return {
              success: false,
              execution_performed: false,
              error: {
                code: "SCENE_CONFIRMATION_REQUIRED",
                message: "不能直接调用固定场景执行器。请先用 plan_scene 向用户展示计划并询问是否执行；等待用户在后续独立消息中明确同意后，使用 execute_scene_plan 执行。不要要求用户输入计划 ID 或固定口令。",
              },
            };
          }
          if (definition.name === "dispatch_agent_event") {
            return orchestrator.dispatchEvent(params.event, { autoRun: params.auto_run ?? true });
          }
          if (definition.name === "discover_household_devices") return deviceInventory.discover();
          if (definition.name === "list_household_device_inventory") return deviceInventory.list();
          if (definition.name === "review_household_device") return deviceInventory.review(params);
          if (["submit_agent_plan", "resolve_agent_action_confirmation", "list_pending_agent_action_confirmations"].includes(definition.name)) {
            return agentPlans.invokeTool(definition.name, params);
          }
          if (definition.name === "run_mock_agent_chain_demo") {
            return executeMockAgentChainTool(params);
          }
          if (definition.name === "run_mock_household_memory_learning_demo") {
            return executeMockMemoryLearningTool(params);
          }
          if (definition.name === "run_mock_maintenance_reminder_demo") {
            return executeMockMaintenanceReminderTool(params);
          }
          if (Object.hasOwn(adaptiveEnergyScenes, definition.name)) return adaptiveEnergyScenes[definition.name](params);
          if (Object.hasOwn(energyOperations, definition.name)) return energyOperations[definition.name](params);
          if (Object.hasOwn(maintenanceReminders, definition.name)) return maintenanceReminders[definition.name](params);
          if (Object.hasOwn(householdDeviceMonitor, definition.name)) return householdDeviceMonitor[definition.name](params);
          if (Object.hasOwn(householdRoutineNotifications, definition.name)) return householdRoutineNotifications[definition.name](params);
          if (Object.hasOwn(scenePlanning, definition.name)) return scenePlanning[definition.name](params);
          if (Object.hasOwn(householdMemory, definition.name)) return householdMemory[definition.name](params);
          if (definition.name === "control_device") {
            const scan = await deviceInventory.discover();
            if (!scan.success) return scan;
            if (!deviceInventory.isControlApproved(params.device_id)) {
              return {
                success: false,
                execution_performed: false,
                error: {
                  code: "DEVICE_APPROVAL_REQUIRED",
                  message: "这台设备尚未完成家庭登记。请先核对设备名称和房间，并登记批准后再控制。",
                  device_id: params.device_id,
                },
              };
            }
            return agentPlans.requestDeviceAction(params);
          }
          return runtime.invoke(definition.name, params);
        },
          }),
    ),
});

const registerToolPlugin = toolPlugin.register;
toolPlugin.register = (api) => {
  configureMemoryStoreFromPluginConfig(memoryStore, api.pluginConfig ?? {});
  registerToolPlugin(api);
  api.registerService?.({
    id: "device-manager-household-memory",
    async start(context) {
      const result = memoryStore.open();
      context.logger.info(`家庭记忆存储已就绪：${result.backend}`);
    },
    async stop() {
      memoryStore.close();
    },
  });
  api.registerService?.({
    id: "device-manager-maintenance-reminders",
    async start(context) {
      const result = await maintenanceReminders.resume_maintenance_reminders();
      if (!result.success) {
        context.logger.warn(`维护提醒周期检查未恢复：${result.error?.code ?? "UNKNOWN_ERROR"}`);
      } else if (result.status === "RUNNING") {
        context.logger.info("已恢复用户明确启用的本地维护提醒周期检查");
      }
    },
    async stop(context) {
      const result = await maintenanceReminders.stop_maintenance_reminders({ clear_auto_resume: false });
      if (!result.success) {
        context.logger.warn(`维护提醒周期检查停止时出现问题：${result.error?.code ?? "UNKNOWN_ERROR"}`);
      }
    },
  });
};

export default toolPlugin;
