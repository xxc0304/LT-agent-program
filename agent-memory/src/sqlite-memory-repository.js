import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

let DatabaseSync;
try {
  ({ DatabaseSync } = createRequire(import.meta.url)("node:sqlite"));
} catch {
  DatabaseSync = null;
}

export const SQLITE_MEMORY_SCHEMA_VERSION = 1;
export const SQLITE_MEMORY_APPLICATION_ID = "lt-household-memory";

function sqliteUnavailableError() {
  const error = new Error("SQLite 记忆存储需要支持 node:sqlite 的 Node.js 22.5 或更高版本；当前 JSON 存储仍可使用。");
  error.code = "MEMORY_SQLITE_UNAVAILABLE";
  return error;
}

function sqliteBusyError(error) {
  if (!/SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy/i.test(error?.message ?? "")) return error;
  const wrapped = new Error("家庭记忆数据库正被另一个写入者占用；请稍后重试。", { cause: error });
  wrapped.code = "MEMORY_STORE_LOCKED";
  return wrapped;
}

function emptyDocument(schemaVersion) {
  return { schema_version: schemaVersion, settings: {}, memories: [] };
}

/**
 * SQLite repository for one household's structured memory document.
 * The database is intentionally scoped per household deployment; the model
 * never chooses a database path or household identifier.
 */
export class SQLiteMemoryRepository {
  constructor({ databasePath, schemaVersion }) {
    if (typeof DatabaseSync !== "function") throw sqliteUnavailableError();
    if (typeof databasePath !== "string" || !databasePath.trim()) {
      throw new TypeError("databasePath must be a non-empty path");
    }
    if (typeof schemaVersion !== "string" || !schemaVersion) {
      throw new TypeError("schemaVersion must be a non-empty string");
    }

    this.databasePath = path.resolve(databasePath);
    this.schemaVersion = schemaVersion;
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(this.databasePath);
    try {
      this.database.exec("PRAGMA busy_timeout = 5000;");
      this.#initialize();
    } catch (error) {
      try { this.database.close(); } catch {}
      throw error;
    }
  }

  #initialize() {
    const existingTables = this.database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).all().map((row) => row.name);
    const hasIdentity = existingTables.includes("memory_database_identity");
    if (existingTables.length > 0 && !hasIdentity) {
      this.database.close();
      const error = new Error("目标 SQLite 数据库已包含其他应用的数据；为避免覆盖，家庭记忆存储拒绝使用该文件。");
      error.code = "MEMORY_DATABASE_NOT_EMPTY";
      throw error;
    }

    if (hasIdentity) {
      const identity = this.database.prepare(
        "SELECT application_id FROM memory_database_identity WHERE singleton = 1",
      ).get();
      if (identity?.application_id !== SQLITE_MEMORY_APPLICATION_ID) {
        this.database.close();
        const error = new Error("目标 SQLite 数据库不属于家庭记忆模块；为避免覆盖，已拒绝打开。");
        error.code = "MEMORY_DATABASE_NOT_OURS";
        throw error;
      }
    }

    const version = this.database.prepare("PRAGMA user_version").get().user_version;
    if (version > SQLITE_MEMORY_SCHEMA_VERSION) {
      this.database.close();
      const error = new Error(`家庭记忆数据库 schema ${version} 高于当前支持版本 ${SQLITE_MEMORY_SCHEMA_VERSION}；拒绝降级或改写。`);
      error.code = "MEMORY_DATABASE_VERSION_UNSUPPORTED";
      throw error;
    }

    try {
      this.database.exec("BEGIN IMMEDIATE;");
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS memory_database_identity (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          application_id TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_store_meta (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          document_schema_version TEXT NOT NULL,
          settings_json TEXT NOT NULL,
          initialized INTEGER NOT NULL DEFAULT 0 CHECK (initialized IN (0, 1))
        );
        CREATE TABLE IF NOT EXISTS memories (
          memory_id TEXT PRIMARY KEY,
          position INTEGER NOT NULL UNIQUE,
          memory_type TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          status TEXT NOT NULL,
          updated_at TEXT,
          expires_at TEXT,
          record_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS memories_lookup_idx
          ON memories (memory_type, subject_id, status);
        CREATE INDEX IF NOT EXISTS memories_expiry_idx
          ON memories (expires_at);
      `);
      this.database.prepare(
        "INSERT OR IGNORE INTO memory_database_identity (singleton, application_id) VALUES (1, ?)",
      ).run(SQLITE_MEMORY_APPLICATION_ID);
      this.database.prepare(
        "INSERT OR IGNORE INTO memory_store_meta (singleton, document_schema_version, settings_json, initialized) VALUES (1, ?, '{}', 0)",
      ).run(this.schemaVersion);
      this.database.exec(`PRAGMA user_version = ${SQLITE_MEMORY_SCHEMA_VERSION}; COMMIT;`);
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch {}
      this.database.close();
      throw sqliteBusyError(error);
    }

    if (process.platform !== "win32") fs.chmodSync(this.databasePath, 0o600);
  }

  #loadDocument() {
    const meta = this.database.prepare(
      "SELECT document_schema_version, settings_json FROM memory_store_meta WHERE singleton = 1",
    ).get();
    if (!meta) throw new Error("家庭记忆数据库缺少元数据；数据库未被修改，请检查文件。");

    let settings;
    try {
      settings = JSON.parse(meta.settings_json);
    } catch (error) {
      const wrapped = new Error("家庭记忆数据库的设置记录损坏；为避免丢失，拒绝读取或改写。", { cause: error });
      wrapped.code = "MEMORY_DATABASE_CORRUPT";
      throw wrapped;
    }

    const memories = this.database.prepare(
      "SELECT record_json FROM memories ORDER BY position ASC",
    ).all().map(({ record_json }) => {
      try {
        return JSON.parse(record_json);
      } catch (error) {
        const wrapped = new Error("家庭记忆数据库中存在损坏记录；为避免丢失，拒绝读取或改写。", { cause: error });
        wrapped.code = "MEMORY_DATABASE_CORRUPT";
        throw wrapped;
      }
    });

    return { schema_version: meta.document_schema_version, settings, memories };
  }

  #writeDocument(document, { initialized = true } = {}) {
    this.database.prepare(`
      UPDATE memory_store_meta
      SET document_schema_version = ?, settings_json = ?, initialized = ?
      WHERE singleton = 1
    `).run(document.schema_version, JSON.stringify(document.settings ?? {}), initialized ? 1 : 0);

    this.database.exec("DELETE FROM memories;");
    const insert = this.database.prepare(`
      INSERT INTO memories (
        memory_id, position, memory_type, subject_id, status,
        updated_at, expires_at, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    document.memories.forEach((memory, position) => {
      insert.run(
        memory.memory_id,
        position,
        memory.memory_type,
        memory.subject_id ?? "household",
        memory.status,
        memory.updated_at ?? null,
        memory.expires_at ?? null,
        JSON.stringify(memory),
      );
    });
  }

  readDocument() {
    try {
      this.database.exec("BEGIN;");
      const document = this.#loadDocument();
      this.database.exec("COMMIT;");
      return document;
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch {}
      throw sqliteBusyError(error);
    }
  }

  mutate(mutator) {
    try {
      this.database.exec("BEGIN IMMEDIATE;");
      const document = this.#loadDocument();
      const result = mutator(document);
      if (result && typeof result.then === "function") {
        throw new TypeError("SQLite memory mutations must be synchronous");
      }
      this.#writeDocument(document);
      this.database.exec("COMMIT;");
      return structuredClone(result);
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch {}
      throw sqliteBusyError(error);
    }
  }

  importDocumentIfEmpty(document) {
    try {
      this.database.exec("BEGIN IMMEDIATE;");
      const meta = this.database.prepare(
        "SELECT initialized FROM memory_store_meta WHERE singleton = 1",
      ).get();
      const rowCount = this.database.prepare("SELECT COUNT(*) AS count FROM memories").get().count;
      if (meta?.initialized !== 0 || rowCount !== 0) {
        const error = new Error("目标家庭记忆数据库不是全新空库；导入已取消，源 JSON 未改动。");
        error.code = "MEMORY_DATABASE_NOT_EMPTY";
        throw error;
      }
      this.#writeDocument(document);
      this.database.exec("COMMIT;");
      return { success: true, imported_count: document.memories.length, database_path: this.databasePath };
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch {}
      throw sqliteBusyError(error);
    }
  }

  close() {
    this.database.close();
  }
}

export function isSQLiteMemoryAvailable() {
  return typeof DatabaseSync === "function";
}
