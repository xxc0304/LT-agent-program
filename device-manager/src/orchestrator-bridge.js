import { EnergySavingAgent } from "../../energy-saving/src/energy-agent.js";
import { MultiAgentScheduler } from "../../multi-agent-orchestrator/src/scheduler.js";
import { createAgentPlanTools } from "./agent-plan-tools.js";
import { createDeviceTaskRuntime } from "./task-runtime.js";

const FORBIDDEN_EVENT_KEYS = new Set([
  "api_key",
  "apikey",
  "authorization",
  "access_token",
  "password",
  "secret",
  "token",
  "image",
  "image_url",
  "video",
  "video_url",
  "data_url",
  "base64",
]);

function findForbiddenKey(value, path = "event") {
  if (!value || typeof value !== "object") return null;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (FORBIDDEN_EVENT_KEYS.has(normalized)) return `${path}.${key}`;
    const nestedPath = findForbiddenKey(nested, `${path}.${key}`);
    if (nestedPath) return nestedPath;
  }
  return null;
}

function rejectedEventTrace(event, message, code = "UNSAFE_EVENT_INPUT") {
  const eventId = typeof event?.event_id === "string" ? event.event_id : null;
  const traceId = typeof event?.trace_id === "string"
    ? event.trace_id
    : `trace-rejected-${eventId ?? Date.now()}`;
  return {
    schema_version: "0.1",
    trace_id: traceId,
    event_id: eventId,
    source_agent: event?.source_agent ?? null,
    event_type: event?.event_type ?? null,
    status: "REJECTED",
    agents_involved: [],
    stages: [{
      stage: "event_rejected",
      agent_id: "openclaw-bridge",
      status: "failed",
      occurred_at: new Date().toISOString(),
      error: message,
    }],
    planned_tasks: [],
    receipts: [],
    errors: [{ code, message }],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/**
 * Build the in-process bridge used by the OpenClaw plugin.
 *
 * OpenClaw owns the user-facing tool call, while this bridge keeps the
 * business boundary explicit: events enter the scheduler, the energy agent
 * only plans canonical Tasks, and device-manager alone executes and verifies
 * device actions.
 */
export function createOrchestratorBridge(deviceRuntime, {
  trustedOccupancySourceAgents = [],
  trustedEventSourceAgents = [],
  deviceInventory = null,
  approvalStateStore = null,
} = {}) {
  if (!deviceRuntime || typeof deviceRuntime.invoke !== "function") {
    throw new Error("orchestrator bridge 需要一个可调用 invoke() 的设备运行时");
  }

  const energyAgent = new EnergySavingAgent({
    config: { trustedOccupancySourceAgents },
    deviceClient: {
      listDevices: () => deviceInventory
        ? deviceInventory.listEnergyEligibleDevices()
        : deviceRuntime.invoke("list_devices"),
    },
  });
  const deviceTaskRuntime = createDeviceTaskRuntime(deviceRuntime);
  const scheduler = new MultiAgentScheduler();
  const agentPlanTools = createAgentPlanTools({ deviceRuntime, deviceTaskRuntime, energyAgent, approvalStateStore });
  const trustedEventObjects = new WeakSet();
  const trustedTasks = new Map();
  const taskIdsByEvent = new Map();

  scheduler.registerAgent({
    agent_id: energyAgent.id,
    manifest: energyAgent.manifest,
    consumes: energyAgent.manifest.consumes,
    handleEvent: async (event) => {
      const result = await energyAgent.handleEvent(event);
      const trusted = trustedEventObjects.has(event);
      const taskIds = new Set();
      for (const task of result?.tasks ?? []) {
        trustedTasks.set(task.task_id, trusted);
        taskIds.add(task.task_id);
      }
      if (taskIds.size > 0 && typeof event.event_id === "string") {
        taskIdsByEvent.set(event.event_id, taskIds);
      }
      return result;
    },
  });
  scheduler.registerAgent({
    agent_id: "device-manager",
    manifest: {
      agent_id: "device-manager",
      capabilities: ["device_control", "home_assistant"],
      execution_mode: "local",
    },
    executeTask: (task) => agentPlanTools.executeEnergyTask(task, {
      trustedEventSource: trustedTasks.get(task.task_id) === true,
    }),
  });

  function rejectUntrustedPayload(event) {
    const forbiddenPath = findForbiddenKey(event);
    if (!forbiddenPath) return null;
    return rejectedEventTrace(
      event,
      `标准 Event 不得包含认证信息或原始图片/视频字段：${forbiddenPath}`,
    );
  }

  function clearTaskTrustForEvent(eventId) {
    const taskIds = taskIdsByEvent.get(eventId);
    for (const taskId of taskIds ?? []) trustedTasks.delete(taskId);
    taskIdsByEvent.delete(eventId);
  }

  async function dispatchUntrustedEvent(event, { autoRun = true } = {}) {
    const rejected = rejectUntrustedPayload(event);
    if (rejected) return rejected;
    // source_agent in a model/tool payload is only a claim. Replace it before
    // routing so the energy agent cannot cache a forged HA occupancy source.
    const safeEvent = { ...event, source_agent: "openclaw-unverified-input" };
    try {
      return await scheduler.handleEvent(safeEvent, { autoRun });
    } finally {
      clearTaskTrustForEvent(safeEvent.event_id);
    }
  }

  async function dispatchTrustedEvent(event, {
    sourceAgent,
    autoRun = true,
  } = {}) {
    const rejected = rejectUntrustedPayload(event);
    if (rejected) return rejected;
    if (typeof sourceAgent !== "string"
      || !trustedEventSourceAgents.includes(sourceAgent)
      || event?.source_agent !== sourceAgent) {
      return rejectedEventTrace(
        event,
        "事件未通过内部可信适配器白名单校验；不得自动控制设备。",
        "UNTRUSTED_EVENT_SOURCE",
      );
    }
    if (autoRun) trustedEventObjects.add(event);
    try {
      return await scheduler.handleEvent(event, { autoRun });
    } finally {
      // A queued task executed in a later drain has no trusted call context, so
      // it deliberately falls back to the confirmation path.
      clearTaskTrustForEvent(event.event_id);
    }
  }

  return {
    scheduler,
    energyAgent,
    deviceTaskRuntime,
    agentPlanTools,
    listAgents: () => scheduler.listAgents(),
    dispatchEvent: dispatchUntrustedEvent,
    // This method is for a future in-process authenticated HA/event adapter;
    // it is intentionally not exported as an OpenClaw tool.
    dispatchTrustedEvent,
  };
}
