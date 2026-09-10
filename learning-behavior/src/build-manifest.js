import fs from "node:fs/promises";
import path from "node:path";

import { SCB_LABELS } from "./vision.js";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const NORMALIZED_LABELS = new Map(SCB_LABELS.map((label) => [label.replaceAll("_", "").toLowerCase(), label]));

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    args[key] = argv[i + 1]?.startsWith("--") ? true : argv[++i];
  }
  return args;
}

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(fullPath));
    else if (IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(fullPath);
  }
  return files;
}

function inferLabel(root, imagePath) {
  const relativeParts = path.relative(root, imagePath).split(path.sep).slice(0, -1);
  for (const part of relativeParts.reverse()) {
    const key = part.replaceAll(/[-\s]/g, "").toLowerCase();
    if (NORMALIZED_LABELS.has(key)) return NORMALIZED_LABELS.get(key);
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.root || !args.out) {
    console.error("用法：node src/build-manifest.js --root <SCB数据集目录> --out <manifest.jsonl>");
    process.exitCode = 1;
    return;
  }
  const root = path.resolve(String(args.root));
  const output = path.resolve(String(args.out));
  const images = await walk(root);
  const records = images
    .map((imagePath) => ({
      image: path.relative(path.dirname(output), imagePath).replaceAll(path.sep, "/"),
      label: inferLabel(root, imagePath),
      id: path.relative(root, imagePath).replaceAll(path.sep, "/"),
    }))
    .filter((record) => record.label);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""), "utf8");
  console.log(`已生成 ${records.length} 条清单：${output}`);
  if (records.length < images.length) {
    console.log(`有 ${images.length - records.length} 张图片未能从父目录推断标签，请手工补充。`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
