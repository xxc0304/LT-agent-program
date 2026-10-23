import { createSQLiteMemoryBackup, restoreSQLiteMemoryBackup } from "./sqlite-backup.js";

function usage() {
  return [
    "家庭记忆 SQLite 备份（不加密）：",
    "  node src/sqlite-backup-cli.js create <当前记忆.sqlite> <新建备份.sqlite>",
    "  node src/sqlite-backup-cli.js restore <备份.sqlite> <新建恢复库.sqlite>",
    "",
    "备份/恢复不会覆盖已有目标；请选择受保护的本地数据目录。",
  ].join("\n");
}

const [operation, sourcePath, destinationPath, ...extra] = process.argv.slice(2);
if (operation === "--help" || operation === "-h" || !operation) {
  process.stdout.write(`${usage()}\n`);
} else if (extra.length || !sourcePath || !destinationPath || !["create", "restore"].includes(operation)) {
  process.stderr.write(`${usage()}\n`);
  process.exitCode = 2;
} else {
  try {
    const result = operation === "create"
      ? await createSQLiteMemoryBackup({ sourcePath, backupPath: destinationPath })
      : await restoreSQLiteMemoryBackup({ backupPath: sourcePath, databasePath: destinationPath });
    const outputPath = result.backup_path ?? result.database_path;
    process.stdout.write(`${operation === "create" ? "SQLite 备份已创建" : "SQLite 数据库已恢复"}（未加密）：${outputPath}；记忆条数：${result.memory_count}\n`);
  } catch (error) {
    process.stderr.write(`SQLite 备份操作失败${error.code ? ` [${error.code}]` : ""}：${error.message}\n`);
    process.exitCode = 1;
  }
}
