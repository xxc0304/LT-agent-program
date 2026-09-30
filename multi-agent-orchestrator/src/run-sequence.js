import fs from "node:fs/promises";
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
  console.error("用法：node src/run-sequence.js <时间戳图像清单.json>");
  console.error('清单格式：{"area":"living_room","frames":[{"image":"frame-1.jpg","captured_at":"2026-09-24T12:00:00Z"}]}');
}

async function main() {
  const manifestArg = process.argv[2];
  if (!manifestArg || manifestArg === "--help" || manifestArg === "-h") {
    usage();
    if (!manifestArg) process.exitCode = 1;
    return;
  }

  const manifestPath = path.resolve(manifestArg);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (!manifest || !Array.isArray(manifest.frames) || manifest.frames.length === 0) {
    throw new Error("清单必须包含非空 frames 数组");
  }
  const manifestDir = path.dirname(manifestPath);
  const frames = manifest.frames.map((frame, index) => {
    if (!frame || typeof frame.image !== "string" || typeof frame.captured_at !== "string") {
      throw new Error(`第 ${index + 1} 帧必须包含 image 和 captured_at`);
    }
    return {
      imagePath: path.resolve(manifestDir, frame.image),
      capturedAt: frame.captured_at,
    };
  });

  const visionClient = await createDeepSeekVisionClient();
  const learningAgent = new LearningCompanionAgent({ visionClient });
  const event = await learningAgent.analyzeSequence(frames, { area: manifest.area ?? "living_room" });

  const homeAssistant = new MockHomeAssistant();
  const deviceRuntime = createDeviceToolRuntime(homeAssistant);
  const deviceTaskRuntime = createDeviceTaskRuntime(deviceRuntime);
  deviceRuntime.invoke("control_device", { device_id: "light.living_room", action: "turn_on" });

  const energyAgent = new EnergySavingAgent({
    deviceClient: { listDevices: () => deviceRuntime.invoke("list_devices") },
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
    dataset: "timestamped-local-frames",
    frame_count: frames.length,
    area: manifest.area ?? "living_room",
    event: {
      event_id: event.event_id,
      trace_id: event.trace_id,
      behavior: event.payload.behavior,
      presence: event.payload.presence,
      confidence: event.confidence,
      duration_ms: event.payload.duration_ms,
      needs_review: event.needs_review,
      evidence: event.payload.evidence,
    },
    trace,
    final_mock_light_state: deviceRuntime.invoke("get_state", { device_id: "light.living_room" }),
    note: "设备执行仅发生在 Mock HA；图片路径不会写入跨 Agent Event。",
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
