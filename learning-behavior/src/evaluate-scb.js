import fs from "node:fs/promises";
import path from "node:path";

import { createDeepSeekVisionClient, SCB_LABELS } from "./vision.js";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    args[key] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i];
  }
  return args;
}

async function readManifest(manifestPath) {
  const text = await fs.readFile(manifestPath, "utf8");
  const parsed = manifestPath.toLowerCase().endsWith(".json") ? JSON.parse(text) : text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => ({ ...JSON.parse(line), line: index + 1 }));
  if (!Array.isArray(parsed)) throw new Error("SCB 清单必须是 JSON 数组或 JSONL 文件。");
  return parsed;
}

function usage() {
  console.log(`用法：
  node src/evaluate-scb.js --image <图片路径>
  node src/evaluate-scb.js --manifest <manifest.jsonl> [--limit 20] [--per-label 3] [--out results.json] [--dry-run]`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.image && !args.manifest) {
    usage();
    process.exitCode = 1;
    return;
  }

  if (args.image) {
    if (args["dry-run"]) {
      console.log(JSON.stringify({ image: path.resolve(String(args.image)), dryRun: true }, null, 2));
      return;
    }
    const client = await createDeepSeekVisionClient();
    const result = await client.analyzeImage(path.resolve(String(args.image)));
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const manifestPath = path.resolve(String(args.manifest));
  const manifestDir = path.dirname(manifestPath);
  const allItems = await readManifest(manifestPath);
  const perLabel = args["per-label"] ? Number(args["per-label"]) : null;
  const selected = perLabel && Number.isFinite(perLabel) && perLabel > 0
    ? SCB_LABELS.flatMap((label) => allItems.filter((item) => item.label === label).slice(0, perLabel))
    : allItems;
  const limit = args.limit ? Number(args.limit) : selected.length;
  const items = selected.slice(0, Number.isFinite(limit) ? limit : selected.length);
  const records = [];
  const client = args["dry-run"] ? null : await createDeepSeekVisionClient();

  for (const item of items) {
    const imagePath = path.resolve(manifestDir, item.image);
    const record = {
      id: item.id ?? item.image,
      image: item.image,
      label: item.label,
      imagePath,
    };
    try {
      await fs.access(imagePath);
      if (!args["dry-run"]) {
        const result = await client.analyzeImage(imagePath);
        record.predictedLabel = result.predictedLabel;
        record.confidence = result.parsed?.confidence ?? null;
        record.evidence = result.parsed?.evidence ?? null;
        record.latencyMs = result.latencyMs;
        record.rawText = result.rawText;
      }
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
    }
    records.push(record);
  }

  const usable = records.filter((record) => SCB_LABELS.includes(record.label));
  const predicted = usable.filter((record) => SCB_LABELS.includes(record.predictedLabel));
  const correct = predicted.filter((record) => record.label === record.predictedLabel).length;
  const confusion = Object.fromEntries(SCB_LABELS.map((label) => [label, {}]));
  for (const record of predicted) {
    confusion[record.label][record.predictedLabel] = (confusion[record.label][record.predictedLabel] ?? 0) + 1;
  }
  const labelMetrics = Object.fromEntries(SCB_LABELS.map((label) => {
    const truePositive = predicted.filter((record) => record.label === label && record.predictedLabel === label).length;
    const falsePositive = predicted.filter((record) => record.label !== label && record.predictedLabel === label).length;
    const falseNegative = predicted.filter((record) => record.label === label && record.predictedLabel !== label).length;
    const support = predicted.filter((record) => record.label === label).length;
    const precision = truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : null;
    const recall = truePositive + falseNegative ? truePositive / (truePositive + falseNegative) : null;
    const f1 = precision !== null && recall !== null && precision + recall
      ? (2 * precision * recall) / (precision + recall)
      : null;
    return [label, { support, precision, recall, f1 }];
  }));
  const latencies = predicted.map((record) => record.latencyMs).filter((value) => Number.isFinite(value));
  const result = {
    dataset: "SCB-Dataset",
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash-vision-exp",
    count: records.length,
    evaluated: predicted.length,
    accuracy: predicted.length ? correct / predicted.length : null,
    confusion,
    perLabelMetrics: labelMetrics,
    meanLatencyMs: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null,
    records,
  };
  if (args.out) {
    const outputPath = path.resolve(String(args.out));
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");
    console.log(`结果已写入：${outputPath}`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
