import path from "node:path";

import { createInMemoryProfileSyncPrototype } from "./profile-sync-prototype.js";
import { preparePrivateProfileSyncSqlitePath } from "./profile-sync-sqlite-path.js";

const EMPTY_STATE = Object.freeze({
  schema_version: "0.1",
  recordsByOwner: [],
  changesByOwner: [],
  idempotency: [],
  naturalKeysByOwner: [],
});

/**
 * Local-only durable reference adapter. It persists the prototype state as one
 * SQLite snapshot in a transaction; the snapshot is plaintext and must only be
 * used with synthetic data until production encryption/retention are designed.
 */
export async function createSqliteProfileSyncPrototype({ databasePath, clock = () => Date.now() } = {}) {
  if (typeof databasePath !== "string" || !databasePath.trim() || databasePath === ":memory:") {
    throw new TypeError("An explicit file path is required for the SQLite persistence prototype.");
  }

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    throw new Error("This local persistence prototype requires a Node.js runtime with node:sqlite (Node 22.5+).");
  }

  const resolvedPath = path.resolve(databasePath);
  const priorFile = await preparePrivateProfileSyncSqlitePath(resolvedPath);
  const database = new DatabaseSync(resolvedPath);
  try {
    if (priorFile && priorFile.size > 0) {
      const tableRows = database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all();
      if (tableRows.length !== 1 || tableRows[0].name !== "profile_sync_snapshot") {
        throw new Error("Refusing to use a non-empty SQLite database that is not this prototype's store.");
      }
    }

    database.exec("PRAGMA busy_timeout = 5000;");
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec(`
      CREATE TABLE IF NOT EXISTS profile_sync_snapshot (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version TEXT NOT NULL CHECK (schema_version = '0.1'),
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const initialRow = database.prepare("SELECT schema_version, state_json FROM profile_sync_snapshot WHERE id = 1").get();
    if (initialRow) {
      if (initialRow.schema_version !== "0.1") throw new Error("Unsupported local Profile snapshot schema version.");
      createInMemoryProfileSyncPrototype({ clock, initialState: JSON.parse(initialRow.state_json) });
    }
  } catch (error) {
    database.close();
    throw error;
  }

  let closed = false;
  const readSnapshot = () => {
    const row = database.prepare("SELECT schema_version, state_json FROM profile_sync_snapshot WHERE id = 1").get();
    if (!row) return EMPTY_STATE;
    if (row.schema_version !== "0.1") throw new Error("Unsupported local Profile snapshot schema version.");
    return JSON.parse(row.state_json);
  };
  const writeSnapshot = (service) => {
    const stateJson = JSON.stringify(service.exportState());
    database.prepare(`
      INSERT INTO profile_sync_snapshot (id, schema_version, state_json, updated_at)
      VALUES (1, '0.1', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        schema_version = excluded.schema_version,
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `).run(stateJson, new Date(clock()).toISOString());
  };
  const transact = (mode, persist, callback) => {
    if (closed) throw new Error("SQLite Profile prototype is closed.");
    database.exec(mode === "write" ? "BEGIN IMMEDIATE;" : "BEGIN;");
    try {
      const service = createInMemoryProfileSyncPrototype({ clock, initialState: readSnapshot() });
      const result = callback(service);
      if (persist) writeSnapshot(service);
      database.exec("COMMIT;");
      return result;
    } catch (error) {
      try { database.exec("ROLLBACK;"); } catch { /* preserve original error */ }
      throw error;
    }
  };

  return Object.freeze({
    applyChange: (request) => transact("write", true, (service) => service.applyChange(request)),
    pull: (request) => transact("read", false, (service) => service.pull(request)),
    readCurrentPreferences: (request) => transact("read", false, (service) => service.readCurrentPreferences(request)),
    close() {
      if (!closed) {
        database.close();
        closed = true;
      }
    },
  });
}
