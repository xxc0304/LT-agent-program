import fs from "node:fs/promises";
import path from "node:path";

import { summarizeInterAnnotatorAgreement, summarizeSceneReferences } from "./scene-evaluation-metrics.js";

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.references) {
    console.log("用法：node src/audit-scene-annotations.js --references <标注.jsonl> [--agreement] [--out <审计.json>]");
    process.exitCode = 1;
    return;
  }

  const referencesPath = path.resolve(String(args.references));
  const records = await readJsonl(referencesPath);
  const result = args.agreement
    ? summarizeInterAnnotatorAgreement(records)
    : summarizeSceneReferences(records, { allowIncomplete: true });
  if (args.out) {
    const outputPath = path.resolve(String(args.out));
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(`标注审计已写入：${outputPath}`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
