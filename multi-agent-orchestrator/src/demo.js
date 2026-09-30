import { MockHomeAssistant } from "../../device-manager/src/mock-ha.js";
import { createDeviceToolRuntime } from "../../device-manager/src/tools.js";
import { createDeviceTaskRuntime } from "../../device-manager/src/task-runtime.js";
import { EnergySavingAgent } from "../../energy-saving/src/energy-agent.js";
import { LearningCompanionAgent } from "./learning-agent.js";
import { MultiAgentScheduler } from "./scheduler.js";

const homeAssistant = new MockHomeAssistant();
const deviceRuntime = createDeviceToolRuntime(homeAssistant);
const deviceTaskRuntime = createDeviceTaskRuntime(deviceRuntime);

deviceRuntime.invoke("control_device", {
  device_id: "light.living_room",
  action: "turn_on",
  trace_id: "trace-demo-setup",
});

const energyAgent = new EnergySavingAgent({
  config: { trustedOccupancySourceAgents: ["ha-event-adapter"] },
  deviceClient: {
    listDevices: () => deviceRuntime.invoke("list_devices"),
  },
});
const learningAgent = new LearningCompanionAgent({
  analyzer: async () => ({
    behavior: "standing",
    presence: "away_from_desk",
    confidence: 0.95,
    area: "living_room",
    duration_ms: 10 * 60 * 1000,
    evidence: "连续多帧未检测到孩子在书桌区域",
    model: "mock-learning-model",
  }),
});

const scheduler = new MultiAgentScheduler();
scheduler.registerAgent({
  agent_id: energyAgent.id,
  manifest: energyAgent.manifest,
  consumes: energyAgent.manifest.consumes,
  handleEvent: (event) => energyAgent.handleEvent(event),
});
scheduler.registerAgent({
  agent_id: "device-manager",
  manifest: { agent_id: "device-manager", capabilities: ["device_control", "home_assistant"] },
  executeTask: (task) => deviceTaskRuntime.execute(task),
});

const visualEvent = await learningAgent.analyze({});
const occupancyEvent = {
  schema_version: "0.1",
  event_id: "evt-ha-independent-presence-demo",
  source_agent: "ha-event-adapter",
  event_type: "occupancy_changed",
  occurred_at: visualEvent.occurred_at,
  privacy_level: "family",
  data_level: "L0",
  trace_id: "trace-demo-ha-confirmation",
  payload: { area: "living_room", occupied: false, observed_for_ms: 60_000 },
};
await scheduler.handleEvent(occupancyEvent);
const trace = await scheduler.handleEvent(visualEvent);

console.log(JSON.stringify({
  registered_agents: scheduler.listAgents(),
  independent_occupancy_event: occupancyEvent,
  learning_event: visualEvent,
  trace,
  execution_log: scheduler.getExecutionLog(),
  final_light_state: deviceRuntime.invoke("get_state", { device_id: "light.living_room" }),
}, null, 2));
