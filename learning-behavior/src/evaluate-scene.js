import fs from "node:fs/promises";
import path from "node:path";

import {
  evaluateSceneAnnotations,
  selectSceneEvaluationSubset,
  validateSceneReferences,
} from "./scene-evaluation-metrics.js";

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

async function readJsonl(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${filePath} 第 ${index + 1} 行不是合法 JSON：${error.message}`);
    }
  });
}

function usage() {
  console.log(`离线场景级评估（不会调用模型 API）：
  node src/evaluate-scene.js --references <人工标注.jsonl> --validate-only
  node src/evaluate-scene.js --references <人工标注.jsonl> --predictions <模型预测.jsonl> [--out <结果.json>]`);
}

async function validateImagePaths(records, referencesPath) {
  const baseDir = path.dirname(referencesPath);
  let checked = 0;
  const missing = [];
  for (const record of records) {
    if (typeof record.image !== "string" || !record.image.trim()) continue;
    if (path.isAbsolute(record.image)) throw new Error(`${recordIdForMessage(record)} 的 image 必须使用相对路径。`);
    const resolved = path.resolve(baseDir, record.image);
    const relative = path.relative(baseDir, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
      throw new Error(`${recordIdForMessage(record)} 的 image 路径越出标注文件目录。`);
    }
    checked += 1;
    try {
      await fs.access(resolved);
    } catch {
      missing.push(record.image);
    }
  }
  return { checked, missing };
}

function recordIdForMessage(record) {
  return record.id ?? record.blind_id ?? "未知样本";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.references || (!args["validate-only"] && !args.predictions)) {
    usage();
    process.exitCode = 1;
    return;
  }

  const referencesPath = path.resolve(String(args.references));
  const references = await readJsonl(referencesPath);
  validateSceneReferences(references);

  if (args["validate-only"]) {
    const images = await validateImagePaths(references, referencesPath);
    const result = {
      valid: images.missing.length === 0,
      referenceCount: references.length,
      imageFilesChecked: images.checked,
      missingImages: images.missing,
      modelCalled: false,
    };
    console.log(JSON.stringify(result, null, 2));
    if (!result.valid) process.exitCode = 2;
    return;
  }

  const predictions = await readJsonl(path.resolve(String(args.predictions)));
  const subset = selectSceneEvaluationSubset(references, predictions);
  const result = {
    ...evaluateSceneAnnotations(subset.references, predictions),
    referencePoolCount: references.length,
    excludedUnpredictedReferenceCount: subset.excludedUnpredictedReferenceCount,
  };
  if (args.out) {
    const outputPath = path.resolve(String(args.out));
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(`评估结果已写入：${outputPath}`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
