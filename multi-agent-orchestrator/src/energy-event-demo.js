import { MockHomeAssistant } from "../../device-manager/src/mock-ha.js";
import { createDeviceTaskRuntime } from "../../device-manager/src/task-runtime.js";
import { createDeviceToolRuntime } from "../../device-manager/src/tools.js";
import { EnergySavingAgent } from "../../energy-saving/src/energy-agent.js";
import { MultiAgentScheduler } from "./scheduler.js";

/**
 * Demonstrate the project's household-agent path without the learning module:
 * a trusted occupancy event -> energy planner -> device manager -> Mock HA.
 * This function always constructs its own MockHomeAssistant and cannot use
 * the configured live-HA backend.
 */
export async function runEnergyEventDemo({ now = () => new Date() } = {}) {
  const homeAssistant = new MockHomeAssistant();
  const deviceRuntime = createDeviceToolRuntime(homeAssistant);
  const taskRuntime = createDeviceTaskRuntime(deviceRuntime);
  const traceId = "trace-energy-event-demo";

  for (const deviceId of ["light.living_room", "switch.living_room_plug"]) {
    const result = deviceRuntime.invoke("control_device", {
      device_id: deviceId,
      action: "turn_on",
      task_id: "demo-setup-" + deviceId,
      trace_id: traceId,
    });
    if (!result.success) {
      return {
        success: false,
        simulation: true,
        backend: "Mock Home Assistant",
        error: { code: "MOCK_SETUP_FAILED", device_id: deviceId },
      };
    }
  }

  const energyAgent = new EnergySavingAgent({
    config: { trustedOccupancySourceAgents: ["ha-event-adapter"] },
    deviceClient: { listDevices: () => deviceRuntime.invoke("list_devices") },
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
    manifest: {
      agent_id: "device-manager",
      capabilities: ["device_control", "home_assistant"],
      execution_mode: "local",
    },
    executeTask: (task) => taskRuntime.execute(task),
  });

  const event = {
    schema_version: "0.1",
    event_id: "evt-energy-event-demo-occupancy",
    source_agent: "ha-event-adapter",
    event_type: "occupancy_changed",
    occurred_at: now().toISOString(),
    privacy_level: "family",
    data_level: "L0",
    trace_id: traceId,
    payload: {
      area: "living_room",
      occupied: false,
      observed_for_ms: 10 * 60 * 1000,
    },
  };

  const trace = await scheduler.handleEvent(event);
  const finalStates = Object.fromEntries(
    ["light.living_room", "switch.living_room_plug"].map((deviceId) => [
      deviceId,
      deviceRuntime.invoke("get_state", { device_id: deviceId }),
    ]),
  );

  return {
    success: trace.status === "SUCCEEDED"
      && Object.values(finalStates).every((result) => result.success && result.device.state === "off"),
    simulation: true,
    backend: "Mock Home Assistant",
    scenario: "room_unoccupied_energy_saving",
    event,
    registered_agents: scheduler.listAgents(),
    trace,
    final_states: finalStates,
    boundary: "合成占用事件；规则型节能规划；设备管家执行；仅 Mock HA，无模型 API 或真实设备",
  };
}
