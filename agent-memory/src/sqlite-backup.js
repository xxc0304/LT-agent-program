import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";

import { normalizeMemoryDocument } from "./memory-store.js";
import {
  SQLITE_MEMORY_APPLICATION_ID,
  SQLITE_MEMORY_SCHEMA_VERSION,
} from "./sqlite-memory-repository.js";

let DatabaseSync;
let sqliteBackup;
try {
  ({ DatabaseSync, backup: sqliteBackup } = createRequire(import.meta.url)("node:sqlite"));
} catch {
  DatabaseSync = null;
  sqliteBackup = null;
}

function codedError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function requireBackupApi() {
  if (typeof DatabaseSync !== "function" || typeof sqliteBackup !== "function") {
    throw codedError(
      "MEMORY_SQLITE_BACKUP_UNAVAILABLE",
      "SQLite 在线备份需要提供 node:sqlite backup API 的 Node.js 22.16 或更高版本；现有 JSON 存储不受影响。",
    );
  }
}

function resolveDistinctPaths(sourcePath, destinationPath, operation) {
  if (typeof sourcePath !== "string" || !sourcePath.trim()) throw new TypeError("sourcePath must be a non-empty path");
  if (typeof destinationPath !== "string" || !destinationPath.trim()) throw new TypeError("destinationPath must be a non-empty path");
  const source = path.resolve(sourcePath);
  const destination = path.resolve(destinationPath);
  if (source === destination) {
    throw codedError(`MEMORY_${operation}_PATH_CONFLICT`, "源数据库与目标路径不能相同；未修改任何文件。");
  }
  return { source, destination };
}

async function assertNewDestination(destinationPath, operation) {
  try {
    await fs.lstat(destinationPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw codedError(`MEMORY_${operation}_DESTINATION_EXISTS`, "目标路径已存在；为避免覆盖，操作已取消。");
}

function validateMemoryDatabase(database, invalidCode) {
  const invalid = (message, cause) => {
    throw codedError(invalidCode, message, cause);
  };

  let integrity;
  try {
    integrity = database.prepare("PRAGMA integrity_check").all();
  } catch (error) {
    invalid("SQLite 数据库完整性检查失败。", error);
  }
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
    invalid("SQLite 数据库未通过完整性检查。请保留原文件并检查数据库。");
  }

  const version = database.prepare("PRAGMA user_version").get()?.user_version;
  if (version !== SQLITE_MEMORY_SCHEMA_VERSION) {
    invalid(`SQLite 记忆数据库版本不受支持（期望 ${SQLITE_MEMORY_SCHEMA_VERSION}，实际 ${version ?? "未知"}）。`);
  }

  const tables = new Set(database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).all().map((row) => row.name));
  for (const required of ["memory_database_identity", "memory_store_meta", "memories"]) {
    if (!tables.has(required)) invalid("文件不是可识别的家庭记忆 SQLite 数据库。");
  }

  const identity = database.prepare(
    "SELECT application_id FROM memory_database_identity WHERE singleton = 1",
  ).get();
  if (identity?.application_id !== SQLITE_MEMORY_APPLICATION_ID) {
    invalid("数据库不属于家庭记忆模块；为避免误恢复，操作已取消。");
  }

  const metadata = database.prepare(
    "SELECT document_schema_version, settings_json FROM memory_store_meta WHERE singleton = 1",
  ).get();
  if (!metadata) invalid("家庭记忆数据库缺少文档元数据。");

  try {
    const settings = JSON.parse(metadata.settings_json);
    const memories = database.prepare("SELECT record_json FROM memories ORDER BY position ASC")
      .all().map(({ record_json }) => JSON.parse(record_json));
    const document = normalizeMemoryDocument({
      schema_version: metadata.document_schema_version,
      settings,
      memories,
    });
    return { memory_count: document.memories.length, sqlite_schema_version: version };
  } catch (error) {
    invalid("记忆数据结构无效或记录损坏；为避免恢复不完整数据，操作已取消。", error);
  }
}

function openReadOnlyDatabase(databasePath, invalidCode) {
  try {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec("PRAGMA busy_timeout = 5000;");
    return database;
  } catch (error) {
    if (error.code === "ENOENT") throw error;
    throw codedError(invalidCode, "无法以只读方式打开 SQLite 数据库。", error);
  }
}

async function withNewSQLiteTarget(destinationPath, operation, createContents) {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(destinationPath),
    `.${path.basename(destinationPath)}.${randomUUID()}.tmp.sqlite`,
  );
  try {
    await createContents(temporaryPath);
    await assertNewDestination(destinationPath, operation);
    try {
      // Hard-link publication is atomic and exclusive because the temporary
      // file is created beside the requested destination on the same volume.
      await fs.link(temporaryPath, destinationPath);
    } catch (error) {
      if (error.code === "EEXIST") {
        throw codedError(`MEMORY_${operation}_DESTINATION_EXISTS`, "目标路径已存在；为避免覆盖，操作已取消。", error);
      }
      throw error;
    }
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    await fs.rm(`${temporaryPath}-journal`, { force: true }).catch(() => {});
    await fs.rm(`${temporaryPath}-wal`, { force: true }).catch(() => {});
    await fs.rm(`${temporaryPath}-shm`, { force: true }).catch(() => {});
  }
}

async function copyWithSQLiteBackup({ sourcePath, targetPath, invalidCode }) {
  let source;
  try {
    source = openReadOnlyDatabase(sourcePath, invalidCode);
    const summary = validateMemoryDatabase(source, invalidCode);
    await sqliteBackup(source, targetPath);
    return summary;
  } finally {
    source?.close();
  }
}

/** Create an unencrypted, consistent online backup at a new path. */
export async function createSQLiteMemoryBackup({ sourcePath, backupPath } = {}) {
  requireBackupApi();
  const { source, destination } = resolveDistinctPaths(sourcePath, backupPath, "BACKUP");
  await assertNewDestination(destination, "BACKUP");
  let summary;
  await withNewSQLiteTarget(destination, "BACKUP", async (temporaryPath) => {
    summary = await copyWithSQLiteBackup({
      sourcePath: source,
      targetPath: temporaryPath,
      invalidCode: "MEMORY_BACKUP_SOURCE_INVALID",
    });
    const verification = openReadOnlyDatabase(temporaryPath, "MEMORY_BACKUP_OUTPUT_INVALID");
    try {
      validateMemoryDatabase(verification, "MEMORY_BACKUP_OUTPUT_INVALID");
    } finally {
      verification.close();
    }
  });
  return { success: true, encrypted: false, backup_path: destination, ...summary };
}

/** Restore a consistent copy of a valid backup to a new, non-existing path. */
export async function restoreSQLiteMemoryBackup({ backupPath, databasePath } = {}) {
  requireBackupApi();
  const { source, destination } = resolveDistinctPaths(backupPath, databasePath, "RESTORE");
  await assertNewDestination(destination, "RESTORE");
  let summary;
  await withNewSQLiteTarget(destination, "RESTORE", async (temporaryPath) => {
    summary = await copyWithSQLiteBackup({
      sourcePath: source,
      targetPath: temporaryPath,
      invalidCode: "MEMORY_RESTORE_BACKUP_INVALID",
    });
    const verification = openReadOnlyDatabase(temporaryPath, "MEMORY_RESTORE_OUTPUT_INVALID");
    try {
      validateMemoryDatabase(verification, "MEMORY_RESTORE_OUTPUT_INVALID");
    } finally {
      verification.close();
    }
  });
  return { success: true, encrypted: false, database_path: destination, ...summary };
}
