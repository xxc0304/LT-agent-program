import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { MockHomeAssistant } from "../../device-manager/src/mock-ha.js";
import { createDeviceToolRuntime } from "../../device-manager/src/tools.js";
import { createDeviceTaskRuntime } from "../../device-manager/src/task-runtime.js";
import { EnergySavingAgent } from "../../energy-saving/src/energy-agent.js";
import { LearningCompanionAgent } from "./learning-agent.js";
import { MultiAgentScheduler } from "./scheduler.js";

const THIS_FILE = fileURLToPath(import.meta.url);
const DEFAULT_PREDICTIONS = path.resolve(
  path.dirname(THIS_FILE),
  "../../learning-behavior/data/scb/results/scene-pilot-2026-09-27-predictions-approved.jsonl",
);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    args[key] = argv[index + 1]?.startsWith("--") || argv[index + 1] === undefined
      ? true
      : argv[++index];
  }
  return args;
}

export function validateScenePilotPredictions(records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("预测记录必须是非空数组。");
  }
  const seen = new Set();
  for (const [index, record] of records.entries()) {
    const id = record?.id ?? record?.blind_id;
    if (typeof id !== "string" || !id.trim()) {
      throw new Error(`第 ${index + 1} 条预测记录缺少 id。`);
    }
    if (seen.has(id)) throw new Error(`预测记录存在重复 ID：${id}`);
    seen.add(id);
  }
  return records.length;
}

/** Replay already-saved model outputs through the Event and scheduler path. */
export async function replayScenePilotPredictions(records) {
  validateScenePilotPredictions(records);

  const homeAssistant = new MockHomeAssistant();
  const deviceRuntime = createDeviceToolRuntime(homeAssistant);
  const deviceTaskRuntime = createDeviceTaskRuntime(deviceRuntime);
  deviceRuntime.invoke("control_device", {
    device_id: "light.living_room",
    action: "turn_on",
    trace_id: "trace-scene-pilot-replay-setup",
  });

  const learningAgent = new LearningCompanionAgent();
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

  const samples = [];
  for (const prediction of records) {
    const id = prediction.id ?? prediction.blind_id;
    const event = learningAgent.toSceneEvent(prediction, {
      event_id: `evt-scene-replay-${id}`,
      trace_id: `trace-scene-replay-${id}`,
    });
    const trace = await scheduler.handleEvent(event);
    samples.push({
      sample_id: id,
      activity: event.payload.activity,
      posture: event.payload.posture,
      orientation: event.payload.orientation,
      presence: event.payload.presence,
      confidence: event.confidence,
      needs_review: event.needs_review,
      duration_ms: event.payload.duration_ms,
      schema_warning_count: event.payload.schema_warnings.length,
      event_contains_image_reference: Object.hasOwn(event.payload, "imagePath")
        || Object.hasOwn(event.payload, "image"),
      scheduler_status: trace.status,
      device_manager_invoked: trace.agents_involved.includes("device-manager"),
      planned_task_count: trace.planned_tasks.length,
    });
  }

  const finalLightState = deviceRuntime.invoke("get_state", { device_id: "light.living_room" }).device.state;
  const report = {
    replay_mode: "offline_saved_predictions",
    prediction_count: records.length,
    external_model_requests: 0,
    raw_images_loaded: false,
    real_home_assistant_used: false,
    needs_review_count: samples.filter((sample) => sample.needs_review).length,
    no_action_count: samples.filter((sample) => sample.scheduler_status === "NO_ACTION").length,
    device_manager_invoked_count: samples.filter((sample) => sample.device_manager_invoked).length,
    planned_task_count: samples.reduce((sum, sample) => sum + sample.planned_task_count, 0),
    final_mock_light_state: finalLightState,
    safety_check_passed: samples.every((sample) => sample.needs_review
      && sample.presence === "unknown"
      && sample.duration_ms === 0
      && sample.scheduler_status === "NO_ACTION"
      && !sample.device_manager_invoked
      && sample.planned_task_count === 0)
      && finalLightState === "on",
    samples,
  };

  return report;
}

async function readJsonl(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${filePath} 第 ${index + 1} 条记录不是合法 JSON：${error.message}`);
    }
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const predictionsPath = path.resolve(String(args.predictions ?? DEFAULT_PREDICTIONS));
  const report = await replayScenePilotPredictions(await readJsonl(predictionsPath));
  report.predictions_file = path.basename(predictionsPath);

  if (args.out) {
    const outputPath = path.resolve(String(args.out));
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`离线回放报告已写入：${outputPath}`);
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.safety_check_passed) process.exitCode = 1;
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === THIS_FILE) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
