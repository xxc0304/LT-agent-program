import { MockHomeAssistant } from "../../device-manager/src/mock-ha.js";
import { createDeviceToolRuntime } from "../../device-manager/src/tools.js";
import { createDeviceTaskRuntime } from "../../device-manager/src/task-runtime.js";
import { EnergySavingAgent } from "./energy-agent.js";

const homeAssistant = new MockHomeAssistant();
const deviceRuntime = createDeviceToolRuntime(homeAssistant);
const taskRuntime = createDeviceTaskRuntime(deviceRuntime);

deviceRuntime.invoke("control_device", {
  device_id: "light.living_room",
  action: "turn_on",
  trace_id: "trace-energy-demo-setup",
});
deviceRuntime.invoke("control_device", {
  device_id: "switch.living_room_plug",
  action: "turn_on",
  trace_id: "trace-energy-demo-setup",
});

const agent = new EnergySavingAgent({
  deviceClient: {
    listDevices: () => deviceRuntime.invoke("list_devices"),
  },
});

const event = {
  schema_version: "0.1",
  event_id: "evt-energy-demo-001",
  source_agent: "home-sensor",
  event_type: "occupancy_changed",
  occurred_at: new Date().toISOString(),
  privacy_level: "family",
  data_level: "L0",
  trace_id: "trace-energy-demo-001",
  payload: {
    area: "living_room",
    occupied: false,
    observed_for_ms: 10 * 60 * 1000,
  },
};

const plan = await agent.handleEvent(event);
const receipts = [];
for (const task of plan.tasks) receipts.push(await taskRuntime.execute(task));

const states = plan.tasks.map((task) => deviceRuntime.invoke("get_state", {
  device_id: task.target_ref.device_id,
}));

console.log(JSON.stringify({
  agent: agent.manifest,
  input_event: event,
  plan,
  receipts,
  verified_states: states,
}, null, 2));
