import { MockHomeAssistant } from "../../device-manager/src/mock-ha.js";
import { createDeviceToolRuntime } from "../../device-manager/src/tools.js";
import { createDeviceTaskRuntime } from "../../device-manager/src/task-runtime.js";
import { EnergySavingAgent } from "../../energy-saving/src/energy-agent.js";
import { LearningCompanionAgent } from "./learning-agent.js";
import { MultiAgentScheduler } from "./scheduler.js";

// This demonstration stubs the visual model response. It makes no API request
// and does not need an image, API key, or real Home Assistant instance.
const homeAssistant = new MockHomeAssistant();
const deviceRuntime = createDeviceToolRuntime(homeAssistant);
const deviceTaskRuntime = createDeviceTaskRuntime(deviceRuntime);
deviceRuntime.invoke("control_device", {
  device_id: "light.living_room",
  action: "turn_on",
  trace_id: "trace-scene-review-setup",
});

const learningAgent = new LearningCompanionAgent({
  visionClient: {
    analyzeImage: async () => ({
      model: "mock-scene-model",
      parsed: {
        activity: ["presenting", "raising_hand"],
        posture: "mixed",
        orientation: "mixed",
        confidence: 0.74,
        evidence: "前方学生操作教学内容，其他学生中可见举手动作。",
      },
    }),
  },
});

const energyAgent = new EnergySavingAgent({
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
  manifest: { agent_id: "device-manager", capabilities: ["device_control", "home_assistant"] },
  executeTask: (task) => deviceTaskRuntime.execute(task),
});

const event = await learningAgent.analyzeSceneImage("mock://classroom-scene", {
  event_id: "evt-demo-classroom-scene",
  trace_id: "trace-demo-classroom-scene",
});
const trace = await scheduler.handleEvent(event);
const finalLightState = deviceRuntime.invoke("get_state", { device_id: "light.living_room" });

if (trace.status !== "NO_ACTION"
  || trace.agents_involved.includes("device-manager")
  || finalLightState.device.state !== "on") {
  throw new Error("课堂场景安全演示未通过：不应产生设备动作。");
}

console.log(JSON.stringify({
  demonstration: "classroom scene result enters the Agent chain and is safely ignored by energy control",
  simulation_only: true,
  external_model_requests: 0,
  real_home_assistant_used: false,
  event: {
    event_id: event.event_id,
    event_type: event.event_type,
    annotation_scope: event.payload.annotation_scope,
    target_child_specified: event.payload.target_child_specified,
    activity: event.payload.activity,
    posture: event.payload.posture,
    orientation: event.payload.orientation,
    presence: event.payload.presence,
    confidence: event.confidence,
    needs_review: event.needs_review,
    duration_ms: event.payload.duration_ms,
    image_path_in_event: Object.hasOwn(event.payload, "imagePath"),
  },
  scheduler_trace: trace,
  final_mock_light_state: finalLightState.device.state,
}, null, 2));
