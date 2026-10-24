import path from "node:path";

import { inspectMaintenanceScheduleLock, resolveMaintenanceSchedulePath } from "./maintenance-store.js";

function parseFilePath(args) {
  if (args.length === 0) return resolveMaintenanceSchedulePath();
  if (args.length === 2 && args[0] === "--path" && args[1].trim()) return path.resolve(args[1]);
  throw new Error("用法：npm run maintenance:lock-status [-- --path <维护计划 JSON 文件路径>]");
}

try {
  const filePath = parseFilePath(process.argv.slice(2));
  const result = await inspectMaintenanceScheduleLock({ filePath });
  process.stdout.write(`${JSON.stringify({ ...result, checked_file: filePath }, null, 2)}\n`);
  if (!result.success) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
