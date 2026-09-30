import { SCB_LABELS } from "./vision.js";

const ABSTAIN = "__ABSTAIN__";
const ERROR = "__ERROR__";

/**
 * Summarize predictions without hiding abstentions or failed requests.
 * acceptedLabel lets callers evaluate a confidence threshold without deleting
 * the model's original predictedLabel from the raw record.
 */
export function summarizeEvaluation(records, { labels = SCB_LABELS } = {}) {
  const evaluable = records.filter((record) => labels.includes(record.label));
  const excluded = records.length - evaluable.length;
  const accepted = evaluable.filter((record) => !record.error && labels.includes(
    Object.hasOwn(record, "acceptedLabel") ? record.acceptedLabel : record.predictedLabel,
  ));
  const correct = accepted.filter((record) => {
    const prediction = Object.hasOwn(record, "acceptedLabel") ? record.acceptedLabel : record.predictedLabel;
    return record.label === prediction;
  }).length;
  const errors = evaluable.filter((record) => Boolean(record.error));
  const apiErrors = errors.filter((record) => record.errorType === "API_ERROR").length;
  const inputErrors = errors.filter((record) => record.errorType === "INPUT_ERROR").length;
  const otherErrors = errors.length - apiErrors - inputErrors;
  const abstentions = evaluable.filter((record) => {
    const prediction = Object.hasOwn(record, "acceptedLabel") ? record.acceptedLabel : record.predictedLabel;
    return !record.error && !labels.includes(prediction);
  }).length;
  const confusion = Object.fromEntries(labels.map((label) => [label, Object.fromEntries([
    ...labels.map((predictedLabel) => [predictedLabel, 0]),
    [ABSTAIN, 0],
    [ERROR, 0],
  ])]));

  for (const record of evaluable) {
    const prediction = record.error
      ? ERROR
      : (Object.hasOwn(record, "acceptedLabel") ? record.acceptedLabel : record.predictedLabel);
    const bucket = record.error ? ERROR : (labels.includes(prediction) ? prediction : ABSTAIN);
    confusion[record.label][bucket] += 1;
  }

  const perLabelMetrics = Object.fromEntries(labels.map((label) => {
    const truePositive = evaluable.filter((record) => record.label === label
      && (Object.hasOwn(record, "acceptedLabel") ? record.acceptedLabel : record.predictedLabel) === label).length;
    const falsePositive = accepted.filter((record) => record.label !== label
      && (Object.hasOwn(record, "acceptedLabel") ? record.acceptedLabel : record.predictedLabel) === label).length;
    const support = evaluable.filter((record) => record.label === label).length;
    const precision = truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : null;
    const recall = support ? truePositive / support : null;
    const f1 = precision !== null && recall !== null && precision + recall
      ? (2 * precision * recall) / (precision + recall)
      : null;
    return [label, { support, precision, recall, f1 }];
  }));
  const latencies = records.map((record) => record.latencyMs).filter(Number.isFinite);

  return {
    count: records.length,
    evaluated: evaluable.length,
    excluded: excluded,
    accepted: accepted.length,
    abstentions,
    errors: errors.length,
    apiErrors,
    inputErrors,
    otherErrors,
    accuracy: evaluable.length ? correct / evaluable.length : null,
    acceptedAccuracy: accepted.length ? correct / accepted.length : null,
    coverage: evaluable.length ? accepted.length / evaluable.length : null,
    confusion,
    perLabelMetrics,
    meanLatencyMs: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null,
  };
}
