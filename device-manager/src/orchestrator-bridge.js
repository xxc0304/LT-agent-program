import { EnergySavingAgent } from "../../energy-saving/src/energy-agent.js";
import { MultiAgentScheduler } from "../../multi-agent-orchestrator/src/scheduler.js";
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

function rejectedEventTrace(event, message) {
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
    errors: [{ code: "UNSAFE_EVENT_INPUT", message }],
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
export function createOrchestratorBridge(deviceRuntime, { trustedOccupancySourceAgents = [] } = {}) {
  if (!deviceRuntime || typeof deviceRuntime.invoke !== "function") {
    throw new Error("orchestrator bridge 需要一个可调用 invoke() 的设备运行时");
  }

  const energyAgent = new EnergySavingAgent({
    config: { trustedOccupancySourceAgents },
    deviceClient: {
      listDevices: () => deviceRuntime.invoke("list_devices"),
    },
  });
  const deviceTaskRuntime = createDeviceTaskRuntime(deviceRuntime);
  const scheduler = new MultiAgentScheduler();

  scheduler.registerAgent({
    agent_id: energyAgent.id,
    manifest: energyAgent.manifest,
    consumes: energyAgent.manifest.consumes,
    handleEvent: (event) => energyAgent.handleEvent(event),
  });
  scheduler.registerAgent({
    agent_id: "device-manager",
    manifest: {
      agent_id: "device-manager",
      capabilities: ["device_control", "home_assistant"],
      execution_mode: "local",
    },
    executeTask: (task) => deviceTaskRuntime.execute(task),
  });

  return {
    scheduler,
    listAgents: () => scheduler.listAgents(),
    dispatchEvent: (event, options) => {
      const forbiddenPath = findForbiddenKey(event);
      if (forbiddenPath) {
        return rejectedEventTrace(
          event,
          `标准 Event 不得包含认证信息或原始图片/视频字段：${forbiddenPath}`,
        );
      }
      return scheduler.handleEvent(event, options);
    },
  };
}
