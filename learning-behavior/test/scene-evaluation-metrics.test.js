import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateSceneAnnotations,
  selectSceneEvaluationSubset,
  summarizeInterAnnotatorAgreement,
  summarizeSceneReferences,
  validateSceneReferences,
} from "../src/scene-evaluation-metrics.js";

const references = [
  {
    blind_id: "blind-001",
    activity: ["reading", "writing"],
    posture: "standing",
    orientation: "toward_learning_material",
  },
  {
    blind_id: "blind-002",
    activity: ["unknown"],
    posture: "mixed",
    orientation: "unknown",
  },
];

test("多标签活动计算 micro / macro F1 与完全匹配率", () => {
  const result = evaluateSceneAnnotations(references, [
    {
      id: "blind-001",
      activity: ["reading", "raising_hand"],
      posture: "standing",
      orientation: "toward_learning_material",
    },
    {
      id: "blind-002",
      activity: ["unknown"],
      posture: "mixed",
      orientation: "unknown",
    },
  ]);

  assert.equal(result.count, 2);
  assert.equal(result.missingPredictionCount, 0);
  assert.equal(result.activity.micro.truePositive, 2);
  assert.equal(result.activity.micro.falsePositive, 1);
  assert.equal(result.activity.micro.falseNegative, 1);
  assert.equal(result.activity.micro.f1, 2 / 3);
  assert.equal(result.activity.exactMatches, 1);
  assert.equal(result.activity.exactMatch, 0.5);
  assert.equal(result.activity.perLabel.writing.f1, 0);
  assert.equal(result.posture.accuracy, 1);
  assert.equal(result.orientation.accuracy, 1);
});

test("缺少预测会作为弃答保留在分母中", () => {
  const result = evaluateSceneAnnotations(references, []);
  assert.equal(result.missingPredictionCount, 2);
  assert.equal(result.activity.micro.truePositive, 0);
  assert.equal(result.activity.micro.falseNegative, 3);
  assert.equal(result.posture.accuracy, 0);
  assert.equal(result.posture.abstentions, 2);
  assert.equal(result.orientation.abstentions, 2);
});

test("小样本试测只计入有预测记录的样本，未运行样本单独报告", () => {
  const subset = selectSceneEvaluationSubset(references, [{ id: "blind-001", activity: [] }]);
  assert.deepEqual(subset.references.map((record) => record.blind_id), ["blind-001"]);
  assert.equal(subset.excludedUnpredictedReferenceCount, 1);
});

test("单人标注审计统计覆盖率并明确一致性不可计算", () => {
  const result = summarizeSceneReferences(references.map((record) => ({
    ...record,
    annotation_scope: "classroom_scene",
    annotator_id: "R1",
    evidence: "可见线索",
    uncertain: false,
    reviewer_confidence: "high",
  })));
  assert.equal(result.sampleCount, 2);
  assert.equal(result.annotatorCount, 1);
  assert.equal(result.interAnnotatorAgreement, "not_computable_single_annotator");
  assert.equal(result.activityCounts.reading, 1);
  assert.equal(result.activityCounts.writing, 1);
  assert.equal(result.uncertainCount, 0);
  assert.equal(result.missingEvidenceCount, 0);
  assert.equal(result.individuallyTargetedSamples, 0);
});

test("单人标注审计会报告缺失的范围、标注者、置信度和空活动标签", () => {
  const result = summarizeSceneReferences([{
    blind_id: "blind-incomplete",
    activity: [],
    posture: "unknown",
    orientation: "unknown",
  }]);
  assert.equal(result.missingAnnotationScopeCount, 1);
  assert.equal(result.missingAnnotatorIdCount, 1);
  assert.equal(result.invalidOrMissingConfidenceCount, 1);
  assert.equal(result.emptyActivityCount, 1);
  assert.equal(result.missingEvidenceCount, 1);
});

test("审计正确读取 AI 初标置信度，并区分置信度字段来源", () => {
  const result = summarizeSceneReferences([{
    ...references[0],
    scene_annotation_confidence: "medium",
    reviewer_confidence: null,
  }]);
  assert.deepEqual(result.confidenceCounts, { high: 0, medium: 1, low: 0 });
  assert.deepEqual(result.confidenceSourceCounts, {
    reviewer_confidence: 0,
    scene_annotation_confidence: 1,
    confidence: 0,
    missing: 0,
  });
  assert.equal(result.invalidOrMissingConfidenceCount, 0);
  assert.equal(result.invalidOrMissingReviewerConfidenceCount, 1);
});

test("审计可检查尚未填写完的盲化复核模板，但正式校验仍拒绝缺失标签", () => {
  const draft = [{
    blind_id: "blind-incomplete",
    activity: [],
    posture: null,
    orientation: null,
    annotator_id: "R2",
  }];
  assert.throws(() => summarizeSceneReferences(draft), /posture 标签无效/);

  const result = summarizeSceneReferences(draft, { allowIncomplete: true });
  assert.equal(result.sampleCount, 1);
  assert.equal(result.emptyActivityCount, 1);
  assert.equal(result.missingPostureCount, 1);
  assert.equal(result.missingOrientationCount, 1);
  assert.equal(result.invalidOrMissingConfidenceCount, 1);
});

test("双人复核可按重叠样本计算活动、姿态和朝向的逐对精确一致率", () => {
  const result = summarizeInterAnnotatorAgreement([
    { id: "s1", annotator_id: "R1", activity: ["writing", "presenting"], posture: "standing", orientation: "mixed" },
    { id: "s1", annotator_id: "R2", activity: ["presenting", "writing"], posture: "standing", orientation: "unknown" },
    { id: "s2", annotator_id: "R1", activity: ["reading"], posture: "seated", orientation: "toward_learning_material" },
    { id: "s2", annotator_id: "R2", activity: ["reading"], posture: null, orientation: "toward_learning_material" },
    { id: "s3", annotator_id: "R1", activity: ["unknown"], posture: "unknown", orientation: "unknown" },
  ]);

  assert.equal(result.sampleCount, 3);
  assert.equal(result.samplesWithMultipleAnnotators, 2);
  assert.equal(result.samplesWithoutOverlap, 1);
  assert.equal(result.annotatorPairCount, 1);
  assert.deepEqual(result.pairwise[0].annotators, ["R1", "R2"]);
  assert.deepEqual(result.pairwise[0].activity, {
    comparablePairs: 2, incompletePairs: 0, agreements: 2, exactAgreement: 1,
  });
  assert.deepEqual(result.pairwise[0].posture, {
    comparablePairs: 1, incompletePairs: 1, agreements: 1, exactAgreement: 1,
  });
  assert.deepEqual(result.pairwise[0].orientation, {
    comparablePairs: 2, incompletePairs: 0, agreements: 1, exactAgreement: 0.5,
  });
});

test("双人复核审计拒绝同一标注者对同一图片的重复行和缺失标注者", () => {
  const duplicate = [
    { id: "s1", annotator_id: "R1" },
    { id: "s1", annotator_id: "R1" },
  ];
  assert.throws(() => summarizeInterAnnotatorAgreement(duplicate), /重复标注者记录/);
  assert.throws(() => summarizeInterAnnotatorAgreement([{ id: "s1" }]), /缺少 annotator_id/);
});

test("预测中的无效标签被计为无效或未命中，不会冒充正确标签", () => {
  const result = evaluateSceneAnnotations(references.slice(0, 1), [{
    id: "blind-001",
    activity: ["focused"],
    posture: "upright",
    orientation: "front",
  }]);
  assert.equal(result.activity.invalidPredictionLabels, 1);
  assert.equal(result.activity.exactMatches, 0);
  assert.equal(result.posture.invalidPredictions, 1);
  assert.equal(result.orientation.invalidPredictions, 1);
});

test("拒绝重复 ID、互相冲突的 unknown 活动和无效参考标签", () => {
  assert.throws(() => validateSceneReferences([
    { ...references[0], blind_id: "duplicate" },
    { ...references[1], blind_id: "duplicate" },
  ]), /重复 ID/);
  assert.throws(() => validateSceneReferences([{
    ...references[0], activity: ["unknown", "reading"],
  }]), /不能把 unknown/);
  assert.throws(() => validateSceneReferences([{
    ...references[0], activity: ["reading", "reading"],
  }]), /重复标签/);
  assert.throws(() => validateSceneReferences([{
    ...references[0], activity: ["focused"],
  }]), /无效标签/);
});
