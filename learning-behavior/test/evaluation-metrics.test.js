import test from "node:test";
import assert from "node:assert/strict";

import { summarizeEvaluation } from "../src/evaluation-metrics.js";

test("评估指标把弃答和接口错误计入总样本，不抬高准确率", () => {
  const summary = summarizeEvaluation([
    { id: "1", label: "reading", predictedLabel: "reading", confidence: 0.95, latencyMs: 100 },
    { id: "2", label: "reading", predictedLabel: "writing", acceptedLabel: "writing", confidence: 0.9 },
    { id: "3", label: "writing", predictedLabel: "writing", acceptedLabel: null, abstentionReason: "BELOW_MIN_CONFIDENCE" },
    { id: "4", label: "writing", errorType: "API_ERROR", error: "HTTP 429" },
    { id: "5", label: "not-a-scb-label", predictedLabel: "reading" },
  ]);

  assert.equal(summary.count, 5);
  assert.equal(summary.evaluated, 4);
  assert.equal(summary.excluded, 1);
  assert.equal(summary.accepted, 2);
  assert.equal(summary.abstentions, 1);
  assert.equal(summary.errors, 1);
  assert.equal(summary.apiErrors, 1);
  assert.equal(summary.accuracy, 0.25);
  assert.equal(summary.acceptedAccuracy, 0.5);
  assert.equal(summary.coverage, 0.5);
  assert.equal(summary.confusion.reading.reading, 1);
  assert.equal(summary.confusion.reading.writing, 1);
  assert.equal(summary.confusion.writing.__ABSTAIN__, 1);
  assert.equal(summary.confusion.writing.__ERROR__, 1);
  assert.equal(summary.meanLatencyMs, 100);
});

test("没有有效标签或没有模型预测时不会伪造零分母准确率", () => {
  const summary = summarizeEvaluation([
    { label: "reading", predictedLabel: null },
    { label: "unknown", predictedLabel: "reading" },
  ]);
  assert.equal(summary.evaluated, 1);
  assert.equal(summary.accepted, 0);
  assert.equal(summary.abstentions, 1);
  assert.equal(summary.accuracy, 0);
  assert.equal(summary.acceptedAccuracy, null);
  assert.equal(summary.coverage, 0);
  assert.equal(summary.meanLatencyMs, null);
});
