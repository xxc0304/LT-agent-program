import test from "node:test";
import assert from "node:assert/strict";

import { buildScenePrompt, normalizeScenePrediction } from "../src/scene-vision.js";

test("场景提示词要求多标签活动、独立姿态朝向及 JSON 输出", () => {
  const prompt = buildScenePrompt();
  assert.match(prompt, /activity 是可多选数组/);
  assert.match(prompt, /posture 是单选/);
  assert.match(prompt, /orientation 是单选/);
  assert.match(prompt, /peer_interaction/);
  assert.match(prompt, /JSON 对象/);
});

test("规范化有效多维场景预测", () => {
  assert.deepEqual(normalizeScenePrediction({
    activity: ["writing", "presenting"],
    posture: "mixed",
    orientation: "toward_learning_material",
    presence: "unknown",
    confidence: 0.8,
    evidence: "学生在黑板前书写。",
  }), {
    activity: ["writing", "presenting"],
    posture: "mixed",
    orientation: "toward_learning_material",
    presence: "unknown",
    confidence: 0.8,
    evidence: "学生在黑板前书写。",
    schemaWarnings: [],
  });
});

test("记录模型返回单个活动字符串和标签格式错误", () => {
  const normalized = normalizeScenePrediction({
    activity: "focused",
    posture: "upright",
    orientation: "front",
  });
  assert.deepEqual(normalized.activity, ["focused"]);
  assert.equal(normalized.schemaWarnings.length, 4);
});
