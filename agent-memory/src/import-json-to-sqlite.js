import { importJsonMemoryToSQLite } from "./memory-store.js";

const args = process.argv.slice(2);
if (args.length < 1 || args.length > 2 || args[0] === "--help") {
  console.log("用法：npm run db:import-json -- <现有记忆.json> [新 SQLite 数据库路径]");
  console.log("导入只写入空数据库，源 JSON 保持不变；不覆盖已有记忆数据库。");
  if (args[0] !== "--help") process.exitCode = 2;
} else {
  try {
    const result = await importJsonMemoryToSQLite({ sourcePath: args[0], ...(args[1] ? { databasePath: args[1] } : {}) });
    console.log(`导入完成：${result.imported_count} 条结构化记忆；源 JSON 未修改。`);
  } catch (error) {
    console.error(`${error.code ?? "MEMORY_IMPORT_FAILED"}: ${error.message}`);
    process.exitCode = 1;
  }
}
