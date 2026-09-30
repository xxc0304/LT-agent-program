export const SCENE_ACTIVITY_LABELS = [
  "reading",
  "writing",
  "raising_hand",
  "peer_interaction",
  "presenting",
  "other",
  "unknown",
];

export const SCENE_POSTURE_LABELS = ["seated", "standing", "moving", "mixed", "unknown"];
export const SCENE_ORIENTATION_LABELS = [
  "toward_learning_material",
  "toward_instruction_source",
  "turned_away",
  "mixed",
  "unknown",
];

function recordId(record) {
  return record?.id ?? record?.blind_id;
}

function validateUniqueIds(records, kind) {
  if (!Array.isArray(records)) throw new TypeError(`${kind} 必须是数组。`);
  const seen = new Set();
  for (const [index, record] of records.entries()) {
    const id = recordId(record);
    if (typeof id !== "string" || !id.trim()) {
      throw new Error(`${kind}[${index}] 缺少 id 或 blind_id。`);
    }
    if (seen.has(id)) throw new Error(`${kind} 存在重复 ID：${id}`);
    seen.add(id);
  }
  return seen;
}

export function validateSceneReferences(records, { allowIncomplete = false } = {}) {
  validateUniqueIds(records, "参考标注");
  for (const record of records) {
    const id = recordId(record);
    if (!Array.isArray(record.activity)) {
      if (!(allowIncomplete && (record.activity === undefined || record.activity === null || record.activity === ""))) {
        throw new Error(`${id} 的 activity 必须是标签数组。`);
      }
    } else {
      const invalidActivities = record.activity.filter((label) => !SCENE_ACTIVITY_LABELS.includes(label));
      if (invalidActivities.length) {
        throw new Error(`${id} 的 activity 含无效标签：${invalidActivities.join(", ")}`);
      }
      if (new Set(record.activity).size !== record.activity.length) {
        throw new Error(`${id} 的 activity 含重复标签。`);
      }
      if (record.activity.includes("unknown") && record.activity.length > 1) {
        throw new Error(`${id} 的 activity 不能把 unknown 与其他活动同时标注。`);
      }
    }
    if (!SCENE_POSTURE_LABELS.includes(record.posture)
      && !(allowIncomplete && (record.posture === undefined || record.posture === null || record.posture === ""))) {
      throw new Error(`${id} 的 posture 标签无效：${record.posture}`);
    }
    if (!SCENE_ORIENTATION_LABELS.includes(record.orientation)
      && !(allowIncomplete && (record.orientation === undefined || record.orientation === null || record.orientation === ""))) {
      throw new Error(`${id} 的 orientation 标签无效：${record.orientation}`);
    }
  }
  return records.length;
}

export function selectSceneEvaluationSubset(referenceRecords, predictionRecords) {
  validateSceneReferences(referenceRecords);
  const predictionIds = validateUniqueIds(predictionRecords, "模型预测");
  const selectedReferences = referenceRecords.filter((record) => predictionIds.has(recordId(record)));
  return {
    references: selectedReferences,
    excludedUnpredictedReferenceCount: referenceRecords.length - selectedReferences.length,
  };
}

/** Audit label coverage and completeness without comparing with model output. */
export function summarizeSceneReferences(records, { allowIncomplete = false } = {}) {
  validateSceneReferences(records, { allowIncomplete });
  const countField = (field, values) => Object.fromEntries(values.map((value) => [value,
    records.filter((record) => record[field] === value).length,
  ]));
  const confidenceFields = ["reviewer_confidence", "scene_annotation_confidence", "confidence"];
  const selectedConfidence = records.map((record) => {
    const field = confidenceFields.find((candidate) => record[candidate] !== undefined
      && record[candidate] !== null && record[candidate] !== "");
    return field ? { field, value: record[field] } : { field: "missing", value: null };
  });
  const confidenceSourceCounts = Object.fromEntries(["reviewer_confidence", "scene_annotation_confidence", "confidence", "missing"]
    .map((field) => [field, selectedConfidence.filter((item) => item.field === field).length]));
  const confidenceValues = ["high", "medium", "low"];
  const confidenceCounts = Object.fromEntries(confidenceValues.map((value) => [value,
    selectedConfidence.filter((item) => item.value === value).length,
  ]));
  const activityCounts = Object.fromEntries(SCENE_ACTIVITY_LABELS.map((label) => [label,
    records.filter((record) => Array.isArray(record.activity) && record.activity.includes(label)).length,
  ]));
  const activityCombinationCounts = {};
  for (const record of records) {
    const key = [...(Array.isArray(record.activity) ? record.activity : [])].sort().join("+") || "(empty)";
    activityCombinationCounts[key] = (activityCombinationCounts[key] ?? 0) + 1;
  }
  const annotatorIds = [...new Set(records.map((record) => record.annotator_id).filter(Boolean))].sort();
  const scopeCounts = {};
  for (const record of records) {
    const scope = record.annotation_scope ?? "unspecified";
    scopeCounts[scope] = (scopeCounts[scope] ?? 0) + 1;
  }

  return {
    sampleCount: records.length,
    annotationScopeCounts: scopeCounts,
    missingAnnotationScopeCount: records.filter((record) => !String(record.annotation_scope ?? "").trim()).length,
    annotatorCount: annotatorIds.length,
    annotatorIds,
    missingAnnotatorIdCount: records.filter((record) => !String(record.annotator_id ?? "").trim()).length,
    interAnnotatorAgreement: annotatorIds.length < 2 ? "not_computable_single_annotator" : "requires_pairwise_agreement_audit",
    missingActivityCount: records.filter((record) => !Array.isArray(record.activity)).length,
    emptyActivityCount: records.filter((record) => Array.isArray(record.activity) && record.activity.length === 0).length,
    activityCounts,
    activityCombinationCounts,
    postureCounts: countField("posture", SCENE_POSTURE_LABELS),
    missingPostureCount: records.filter((record) => record.posture === undefined || record.posture === null || record.posture === "").length,
    orientationCounts: countField("orientation", SCENE_ORIENTATION_LABELS),
    missingOrientationCount: records.filter((record) => record.orientation === undefined || record.orientation === null || record.orientation === "").length,
    confidenceCounts,
    confidenceSourceCounts,
    reviewerConfidenceCounts: countField("reviewer_confidence", confidenceValues),
    sceneAnnotationConfidenceCounts: countField("scene_annotation_confidence", confidenceValues),
    invalidOrMissingConfidenceCount: selectedConfidence.filter((item) => !confidenceValues.includes(item.value)).length,
    invalidOrMissingReviewerConfidenceCount: records.filter((record) => !confidenceValues.includes(record.reviewer_confidence)).length,
    confidenceConflictCount: records.filter((record) => new Set(confidenceFields
      .map((field) => record[field]).filter((value) => value !== undefined && value !== null && value !== "")).size > 1).length,
    uncertainCount: records.filter((record) => record.uncertain === true).length,
    uncertainWithoutNoteCount: records.filter((record) => record.uncertain === true
      && !String(record.uncertainty_note ?? "").trim()).length,
    missingEvidenceCount: records.filter((record) => !String(record.evidence ?? "").trim()).length,
    qualityWarningRecordCount: records.filter((record) => Array.isArray(record.quality_warnings)
      && record.quality_warnings.length > 0).length,
    individuallyTargetedSamples: records.filter((record) => record.annotation_scope === "target_student"
      && record.target_visible === true && record.target_ambiguous === false).length,
    reportingCaveats: [
      ...(annotatorIds.length < 2 ? ["单人标注不能计算标注者间一致性，也不应称为双人金标准。"] : []),
      ...(annotatorIds.length >= 2 ? ["此单标注覆盖审计不计算标注者间一致率；多标注者数据请使用独立的 pairwise agreement 审计。"] : []),
      ...(Object.keys(scopeCounts).length === 1 && scopeCounts.classroom_scene === records.length
        ? ["全部样本为课堂整体场景，不能代表目标儿童个体行为识别。"] : []),
      "该审计仅检查标注覆盖和字段完整度，不评判标签是否符合真实画面。",
    ],
  };
}

function normalizeAgreementValue(record, field) {
  if (field === "activity") {
    if (!Array.isArray(record.activity) || record.activity.length === 0
      || record.activity.some((label) => !SCENE_ACTIVITY_LABELS.includes(label))
      || new Set(record.activity).size !== record.activity.length
      || (record.activity.includes("unknown") && record.activity.length > 1)) return null;
    return JSON.stringify([...record.activity].sort());
  }
  const labels = field === "posture" ? SCENE_POSTURE_LABELS : SCENE_ORIENTATION_LABELS;
  return labels.includes(record[field]) ? record[field] : null;
}

function summarizeAgreementComparisons(comparisons, field) {
  let eligibleCount = 0;
  let agreementCount = 0;
  for (const { left, right } of comparisons) {
    const leftValue = normalizeAgreementValue(left, field);
    const rightValue = normalizeAgreementValue(right, field);
    if (leftValue === null || rightValue === null) continue;
    eligibleCount += 1;
    if (leftValue === rightValue) agreementCount += 1;
  }
  return {
    comparablePairs: eligibleCount,
    incompletePairs: comparisons.length - eligibleCount,
    agreements: agreementCount,
    exactAgreement: eligibleCount ? agreementCount / eligibleCount : null,
  };
}

/** Compute pairwise exact agreement from one row per sample and annotator. */
export function summarizeInterAnnotatorAgreement(records) {
  if (!Array.isArray(records)) throw new TypeError("多标注者复核必须是数组。");
  const bySample = new Map();
  const annotatorIds = new Set();
  const seen = new Set();
  for (const [index, record] of records.entries()) {
    const id = recordId(record);
    const annotatorId = record?.annotator_id;
    if (typeof id !== "string" || !id.trim()) throw new Error(`多标注者复核[${index}] 缺少 id 或 blind_id。`);
    if (typeof annotatorId !== "string" || !annotatorId.trim()) throw new Error(`${id} 缺少 annotator_id。`);
    validateSceneReferences([record], { allowIncomplete: true });
    const key = `${id}\u0000${annotatorId}`;
    if (seen.has(key)) throw new Error(`${id} 存在重复标注者记录：${annotatorId}`);
    seen.add(key);
    annotatorIds.add(annotatorId);
    if (!bySample.has(id)) bySample.set(id, []);
    bySample.get(id).push(record);
  }

  const comparisonsByAnnotatorPair = new Map();
  for (const reviewers of bySample.values()) {
    for (let i = 0; i < reviewers.length; i += 1) {
      for (let j = i + 1; j < reviewers.length; j += 1) {
        const names = [reviewers[i].annotator_id, reviewers[j].annotator_id].sort();
        const key = JSON.stringify(names);
        if (!comparisonsByAnnotatorPair.has(key)) comparisonsByAnnotatorPair.set(key, { annotators: names, comparisons: [] });
        comparisonsByAnnotatorPair.get(key).comparisons.push({ left: reviewers[i], right: reviewers[j] });
      }
    }
  }

  const pairwise = [...comparisonsByAnnotatorPair.values()].map(({ annotators, comparisons }) => ({
    annotators,
    sharedSamples: comparisons.length,
    activity: summarizeAgreementComparisons(comparisons, "activity"),
    posture: summarizeAgreementComparisons(comparisons, "posture"),
    orientation: summarizeAgreementComparisons(comparisons, "orientation"),
  })).sort((left, right) => JSON.stringify(left.annotators).localeCompare(JSON.stringify(right.annotators)));

  const samplesWithMultipleAnnotators = [...bySample.values()].filter((reviewers) => reviewers.length > 1).length;
  return {
    sampleCount: bySample.size,
    annotatorCount: annotatorIds.size,
    annotatorIds: [...annotatorIds].sort(),
    samplesWithMultipleAnnotators,
    samplesWithoutOverlap: bySample.size - samplesWithMultipleAnnotators,
    annotatorPairCount: pairwise.length,
    pairwise,
    method: "逐样本、逐标注者组合计算精确一致率；多于两位标注者时同一样本会产生相关比较，不等于独立样本统计或 chance-corrected kappa。仲裁结果应单独保存，不混入独立标注输入。",
  };
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function summarizeMultilabel(pairs) {
  const perLabel = Object.fromEntries(SCENE_ACTIVITY_LABELS.map((label) => [label, {
    support: 0,
    predicted: 0,
    truePositive: 0,
    falsePositive: 0,
    falseNegative: 0,
    precision: null,
    recall: null,
    f1: null,
  }]));
  let exactMatches = 0;
  let microTp = 0;
  let microFp = 0;
  let microFn = 0;
  let invalidPredictionLabels = 0;

  for (const { reference, prediction } of pairs) {
    const expected = new Set(reference.activity);
    const rawPredicted = Array.isArray(prediction?.activity) ? prediction.activity : [];
    const predicted = new Set(rawPredicted.filter((label) => SCENE_ACTIVITY_LABELS.includes(label)));
    invalidPredictionLabels += rawPredicted.filter((label) => !SCENE_ACTIVITY_LABELS.includes(label)).length;

    if (expected.size === predicted.size && [...expected].every((label) => predicted.has(label))) {
      exactMatches += 1;
    }
    for (const label of SCENE_ACTIVITY_LABELS) {
      const metric = perLabel[label];
      const hasExpected = expected.has(label);
      const hasPrediction = predicted.has(label);
      if (hasExpected) metric.support += 1;
      if (hasPrediction) metric.predicted += 1;
      if (hasExpected && hasPrediction) {
        metric.truePositive += 1;
        microTp += 1;
      } else if (!hasExpected && hasPrediction) {
        metric.falsePositive += 1;
        microFp += 1;
      } else if (hasExpected && !hasPrediction) {
        metric.falseNegative += 1;
        microFn += 1;
      }
    }
  }

  const supportedF1 = [];
  for (const metric of Object.values(perLabel)) {
    metric.precision = ratio(metric.truePositive, metric.truePositive + metric.falsePositive);
    metric.recall = ratio(metric.truePositive, metric.truePositive + metric.falseNegative);
    metric.f1 = ratio(
      2 * metric.truePositive,
      2 * metric.truePositive + metric.falsePositive + metric.falseNegative,
    );
    if (metric.support || metric.predicted) supportedF1.push(metric.f1 ?? 0);
  }

  return {
    exactMatch: ratio(exactMatches, pairs.length),
    exactMatches,
    micro: {
      truePositive: microTp,
      falsePositive: microFp,
      falseNegative: microFn,
      precision: ratio(microTp, microTp + microFp),
      recall: ratio(microTp, microTp + microFn),
      f1: ratio(2 * microTp, 2 * microTp + microFp + microFn),
    },
    macroF1: supportedF1.length
      ? supportedF1.reduce((sum, value) => sum + value, 0) / supportedF1.length
      : null,
    invalidPredictionLabels,
    perLabel,
  };
}

function summarizeSingleLabel(pairs, field, labels) {
  const confusion = Object.fromEntries(labels.map((label) => [label, Object.fromEntries([
    ...labels.map((candidate) => [candidate, 0]),
    ["__ABSTAIN__", 0],
    ["__INVALID__", 0],
  ])]));
  let correct = 0;
  let abstentions = 0;
  let invalidPredictions = 0;

  for (const { reference, prediction } of pairs) {
    const expected = reference[field];
    const rawPrediction = prediction?.[field];
    const validPrediction = labels.includes(rawPrediction);
    const bucket = validPrediction ? rawPrediction : (rawPrediction == null || rawPrediction === "" ? "__ABSTAIN__" : "__INVALID__");
    confusion[expected][bucket] += 1;
    if (validPrediction && rawPrediction === expected) correct += 1;
    if (bucket === "__ABSTAIN__") abstentions += 1;
    if (bucket === "__INVALID__") invalidPredictions += 1;
  }

  return {
    count: pairs.length,
    correct,
    accuracy: ratio(correct, pairs.length),
    abstentions,
    invalidPredictions,
    confusion,
  };
}

/** Compare classroom-scene references with offline model predictions keyed by id. */
export function evaluateSceneAnnotations(referenceRecords, predictionRecords) {
  validateSceneReferences(referenceRecords);
  const predictionIds = validateUniqueIds(predictionRecords, "模型预测");
  const predictionsById = new Map(predictionRecords.map((record) => [recordId(record), record]));
  const referenceIds = new Set(referenceRecords.map(recordId));
  const pairs = referenceRecords.map((reference) => ({
    reference,
    prediction: predictionsById.get(recordId(reference)) ?? null,
  }));
  const missingPredictionCount = pairs.filter(({ prediction }) => prediction === null).length;

  return {
    count: referenceRecords.length,
    matchedPredictions: referenceRecords.length - missingPredictionCount,
    missingPredictionCount,
    unexpectedPredictionCount: [...predictionIds].filter((id) => !referenceIds.has(id)).length,
    activity: summarizeMultilabel(pairs),
    posture: summarizeSingleLabel(pairs, "posture", SCENE_POSTURE_LABELS),
    orientation: summarizeSingleLabel(pairs, "orientation", SCENE_ORIENTATION_LABELS),
  };
}
