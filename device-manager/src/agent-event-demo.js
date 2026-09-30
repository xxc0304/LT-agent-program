import { createOrchestratorBridge } from "./orchestrator-bridge.js";
import { MockHomeAssistant } from "./mock-ha.js";
import { createDeviceToolRuntime } from "./tools.js";

const homeAssistant = new MockHomeAssistant();
const deviceRuntime = createDeviceToolRuntime(homeAssistant);
const bridge = createOrchestratorBridge(deviceRuntime, {
  trustedOccupancySourceAgents: ["ha-event-adapter"],
});

// Demo setup: turn on a controllable device so the energy plan has a target.
deviceRuntime.invoke("control_device", {
  device_id: "light.living_room",
  action: "turn_on",
});

const occurredAt = new Date().toISOString();
const event = {
  schema_version: "0.1",
  event_id: "evt-openclaw-demo-001",
  source_agent: "learning-companion",
  event_type: "learning_behavior",
  occurred_at: occurredAt,
  confidence: 0.95,
  needs_review: false,
  privacy_level: "restricted",
  data_level: "L3",
  trace_id: "trace-openclaw-demo-001",
  payload: {
    behavior: "standing",
    presence: "away_from_desk",
    area: "living_room",
    duration_ms: 600_000,
    evidence: "连续多帧未检测到孩子在书桌区域",
  },
};

const occupancyTrace = await bridge.dispatchEvent({
  schema_version: "0.1",
  event_id: "evt-openclaw-demo-ha-confirmation",
  source_agent: "ha-event-adapter",
  event_type: "occupancy_changed",
  occurred_at: occurredAt,
  privacy_level: "family",
  payload: { area: "living_room", occupied: false, observed_for_ms: 60_000 },
});
const trace = await bridge.dispatchEvent(event);
console.log(JSON.stringify({
  occupancy_trace: occupancyTrace.status,
  status: trace.status,
  agents_involved: trace.agents_involved,
  planned_tasks: trace.planned_tasks,
  receipts: trace.receipts,
  final_light_state: deviceRuntime.invoke("get_state", { device_id: "light.living_room" }).device.state,
}, null, 2));
