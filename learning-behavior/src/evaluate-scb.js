import fs from "node:fs/promises";
import path from "node:path";

import { createDeepSeekVisionClient, SCB_LABELS } from "./vision.js";
import { summarizeEvaluation } from "./evaluation-metrics.js";

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
  node src/evaluate-scb.js --manifest <manifest.jsonl> [--limit 20] [--per-label 3] [--min-confidence 0.8] [--out results.json] [--dry-run]`);
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
  const minConfidence = args["min-confidence"] === undefined ? 0 : Number(args["min-confidence"]);
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    throw new Error("--min-confidence 必须是 0 到 1 之间的数字。");
  }
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
    } catch (error) {
      record.errorType = "INPUT_ERROR";
      record.error = error instanceof Error ? error.message : String(error);
      records.push(record);
      continue;
    }
    if (!args["dry-run"]) {
      try {
        const result = await client.analyzeImage(imagePath);
        record.predictedLabel = result.predictedLabel;
        record.presence = result.presence;
        record.confidence = result.parsed?.confidence ?? null;
        record.evidence = result.parsed?.evidence ?? null;
        record.latencyMs = result.latencyMs;
        record.rawText = result.rawText;
        const belowThreshold = minConfidence > 0
          && (!Number.isFinite(record.confidence) || record.confidence < minConfidence);
        record.acceptedLabel = belowThreshold ? null : record.predictedLabel;
        if (belowThreshold) record.abstentionReason = "BELOW_MIN_CONFIDENCE";
        else if (!SCB_LABELS.includes(record.predictedLabel)) record.abstentionReason = "INVALID_OR_MISSING_LABEL";
      } catch (error) {
        record.errorType = "API_ERROR";
        record.error = error instanceof Error ? error.message : String(error);
      }
    }
    records.push(record);
  }

  const summary = args["dry-run"]
    ? { notRun: true, reason: "dry-run 未调用模型，不计算模型表现指标" }
    : summarizeEvaluation(records);
  const result = {
    dataset: "SCB-Dataset",
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash-vision-exp",
    minConfidence,
    ...summary,
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
