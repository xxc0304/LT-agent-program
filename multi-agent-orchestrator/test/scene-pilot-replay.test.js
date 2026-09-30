import test from "node:test";
import assert from "node:assert/strict";

import {
  replayScenePilotPredictions,
  validateScenePilotPredictions,
} from "../src/replay-scene-pilot.js";

test("已保存场景预测离线回放为复核 Event，绝不生成节能任务", async () => {
  const report = await replayScenePilotPredictions([
    {
      id: "blind-a",
      activity: ["presenting", "raising_hand"],
      posture: "mixed",
      orientation: "mixed",
      presence: "away_from_desk",
      confidence: 0.95,
      evidence: "前方学生操作屏幕，其他学生举手。",
    },
    {
      id: "blind-b",
      activity: ["reading"],
      posture: "seated",
      orientation: "toward_learning_material",
      confidence: 0.9,
      evidence: "学生坐着阅读书本。",
    },
  ]);

  assert.equal(report.replay_mode, "offline_saved_predictions");
  assert.equal(report.prediction_count, 2);
  assert.equal(report.external_model_requests, 0);
  assert.equal(report.raw_images_loaded, false);
  assert.equal(report.real_home_assistant_used, false);
  assert.equal(report.needs_review_count, 2);
  assert.equal(report.no_action_count, 2);
  assert.equal(report.device_manager_invoked_count, 0);
  assert.equal(report.planned_task_count, 0);
  assert.equal(report.final_mock_light_state, "on");
  assert.equal(report.safety_check_passed, true);
  assert.ok(report.samples.every((sample) => sample.presence === "unknown" && sample.duration_ms === 0));
  assert.equal(report.samples[0].event_contains_image_reference, false);
});

test("无效视觉标签在回放中降级为 unknown，仍保持复核和不动作", async () => {
  const report = await replayScenePilotPredictions([{
    id: "blind-invalid",
    activity: ["invented_behavior"],
    posture: "upright",
    orientation: null,
    confidence: null,
  }]);

  assert.deepEqual(report.samples[0].activity, ["unknown"]);
  assert.equal(report.samples[0].posture, "unknown");
  assert.equal(report.samples[0].orientation, "unknown");
  assert.ok(report.samples[0].schema_warning_count > 0);
  assert.equal(report.safety_check_passed, true);
});

test("回放拒绝空清单、缺少 ID 或重复 ID", () => {
  assert.throws(() => validateScenePilotPredictions([]), /非空数组/);
  assert.throws(() => validateScenePilotPredictions([{ activity: ["reading"] }]), /缺少 id/);
  assert.throws(() => validateScenePilotPredictions([
    { id: "duplicate" },
    { id: "duplicate" },
  ]), /重复 ID/);
});
