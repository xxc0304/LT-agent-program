import fs from "node:fs/promises";
import path from "node:path";

import { createDeepSeekVisionClient } from "./vision.js";
import { validateSceneReferences } from "./scene-evaluation-metrics.js";
import { buildScenePrompt, normalizeScenePrediction } from "./scene-vision.js";

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
  console.log(`调用视觉模型生成场景级预测（会向已配置的模型 API 发送所选图片）：
  node src/predict-scene.js --references <标注.jsonl> --ids blind-002,blind-003 --out <预测.jsonl>

必须明确提供样本编号和输出路径；输出路径已存在时拒绝覆盖。`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.references || !args.ids || !args.out) {
    usage();
    process.exitCode = 1;
    return;
  }

  const referencesPath = path.resolve(String(args.references));
  const records = await readJsonl(referencesPath);
  validateSceneReferences(records);
  const byId = new Map(records.map((record) => [record.blind_id ?? record.id, record]));
  const ids = String(args.ids).split(",").map((id) => id.trim()).filter(Boolean);
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error("--ids 必须提供不重复的样本编号。");
  const selected = ids.map((id) => {
    const record = byId.get(id);
    if (!record) throw new Error(`标注清单中不存在样本：${id}`);
    if (record.annotation_scope !== "classroom_scene") {
      throw new Error(`${id} 不是 classroom_scene 标注，当前提示词不适用。`);
    }
    return record;
  });

  const outputPath = path.resolve(String(args.out));
  try {
    await fs.access(outputPath);
    throw new Error(`输出文件已存在；为避免覆盖，请选择新路径：${outputPath}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const imageRoot = path.dirname(referencesPath);
  const client = await createDeepSeekVisionClient();
  const predictions = [];
  for (const [index, reference] of selected.entries()) {
    const imagePath = path.resolve(imageRoot, reference.image);
    const relativeImage = path.relative(imageRoot, imagePath);
    if (relativeImage === ".." || relativeImage.startsWith(`..${path.sep}`)) {
      throw new Error(`${reference.blind_id} 的图片路径越出清单目录。`);
    }
    await fs.access(imagePath);
    try {
      const result = await client.analyzeImage(imagePath, { prompt: buildScenePrompt() });
      predictions.push({
        id: reference.blind_id ?? reference.id,
        ...normalizeScenePrediction(result.parsed),
        model: result.model,
        latencyMs: result.latencyMs,
      });
      console.log(`已完成 ${index + 1}/${selected.length}：${reference.blind_id ?? reference.id}`);
    } catch (error) {
      predictions.push({
        id: reference.blind_id ?? reference.id,
        activity: [],
        posture: null,
        orientation: null,
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      });
      console.log(`调用失败 ${index + 1}/${selected.length}：${reference.blind_id ?? reference.id}`);
    }
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.tmp`;
  await fs.writeFile(tempPath, predictions.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  await fs.rename(tempPath, outputPath);
  console.log(JSON.stringify({
    outputPath,
    requested: selected.length,
    completed: predictions.filter((record) => !record.error).length,
    errors: predictions.filter((record) => Boolean(record.error)).length,
    schemaWarnings: predictions.reduce((count, record) => count + (record.schemaWarnings?.length ?? 0), 0),
    model: predictions.find((record) => record.model)?.model ?? null,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
