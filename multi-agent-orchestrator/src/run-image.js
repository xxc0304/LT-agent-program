import path from "node:path";
import process from "node:process";

import { createDeepSeekVisionClient } from "../../learning-behavior/src/vision.js";
import { MockHomeAssistant } from "../../device-manager/src/mock-ha.js";
import { createDeviceToolRuntime } from "../../device-manager/src/tools.js";
import { createDeviceTaskRuntime } from "../../device-manager/src/task-runtime.js";
import { EnergySavingAgent } from "../../energy-saving/src/energy-agent.js";
import { LearningCompanionAgent } from "./learning-agent.js";
import { MultiAgentScheduler } from "./scheduler.js";

function usage() {
  console.error("用法：node src/run-image.js <图片路径> [区域]");
}

const imagePath = process.argv[2];
if (!imagePath || imagePath === "--help" || imagePath === "-h") {
  usage();
  if (!imagePath) process.exitCode = 1;
} else {
  const area = process.argv[3] ?? "living_room";

  const visionClient = await createDeepSeekVisionClient();
  const learningAgent = new LearningCompanionAgent({ visionClient });
  const event = await learningAgent.analyzeImage(path.resolve(imagePath), {
    area,
  });

  const homeAssistant = new MockHomeAssistant();
  const deviceRuntime = createDeviceToolRuntime(homeAssistant);
  const deviceTaskRuntime = createDeviceTaskRuntime(deviceRuntime);
  deviceRuntime.invoke("control_device", {
    device_id: "light.living_room",
    action: "turn_on",
    trace_id: event.trace_id,
  });

  const energyAgent = new EnergySavingAgent({
    deviceClient: {
      listDevices: () => deviceRuntime.invoke("list_devices"),
    },
  });
  const scheduler = new MultiAgentScheduler();
  scheduler.registerAgent({
    agent_id: energyAgent.id,
    manifest: energyAgent.manifest,
    consumes: energyAgent.manifest.consumes,
    handleEvent: (inputEvent) => energyAgent.handleEvent(inputEvent),
  });
  scheduler.registerAgent({
    agent_id: "device-manager",
    manifest: { agent_id: "device-manager", capabilities: ["device_control", "home_assistant"] },
    executeTask: (task) => deviceTaskRuntime.execute(task),
  });

  const trace = await scheduler.handleEvent(event);
  console.log(JSON.stringify({
    image: path.resolve(imagePath),
    event: {
      event_id: event.event_id,
      trace_id: event.trace_id,
      behavior: event.payload.behavior,
      confidence: event.confidence,
      needs_review: event.needs_review,
      evidence: event.payload.evidence,
    },
    trace,
  }, null, 2));
}
