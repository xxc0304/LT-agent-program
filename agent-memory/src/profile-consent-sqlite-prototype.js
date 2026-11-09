import path from "node:path";

import { createInMemoryProfileConsentPrototype } from "./profile-consent-prototype.js";
import { preparePrivateProfileSyncSqlitePath } from "./profile-sync-sqlite-path.js";

const EMPTY_STATE = Object.freeze({ schema_version: "0.1", records: [], idempotency: [] });

/**
 * Local-only durable consent reference adapter. It stores a synthetic consent
 * snapshot in SQLite; it is not an identity provider or production consent
 * service. Household authorization must still come from a trusted host callback.
 */
export async function createSqliteProfileConsentPrototype({ databasePath, authorizeScope, clock = () => Date.now() } = {}) {
  if (typeof databasePath !== "string" || !databasePath.trim() || databasePath === ":memory:") {
    throw new TypeError("An explicit file path is required for the SQLite consent persistence prototype.");
  }
  if (authorizeScope !== undefined && typeof authorizeScope !== "function") {
    throw new TypeError("authorizeScope must be a trusted host callback when provided.");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function when provided.");

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
      if (tableRows.length !== 1 || tableRows[0].name !== "profile_consent_snapshot") {
        throw new Error("Refusing to use a non-empty SQLite database that is not this prototype's store.");
      }
    }

    database.exec("PRAGMA busy_timeout = 5000;");
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec(`
      CREATE TABLE IF NOT EXISTS profile_consent_snapshot (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version TEXT NOT NULL CHECK (schema_version = '0.1'),
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const initialRow = database.prepare(
      "SELECT schema_version, state_json FROM profile_consent_snapshot WHERE id = 1",
    ).get();
    if (initialRow) {
      if (initialRow.schema_version !== "0.1") throw new Error("Unsupported local Profile consent snapshot schema version.");
      createInMemoryProfileConsentPrototype({ authorizeScope, initialState: JSON.parse(initialRow.state_json) });
    }
  } catch (error) {
    database.close();
    throw error;
  }

  let acceptingOperations = true;
  let closed = false;
  let closePromise;
  let operationTail = Promise.resolve();

  const readSnapshot = () => {
    const row = database.prepare(
      "SELECT schema_version, state_json FROM profile_consent_snapshot WHERE id = 1",
    ).get();
    if (!row) return EMPTY_STATE;
    if (row.schema_version !== "0.1") throw new Error("Unsupported local Profile consent snapshot schema version.");
    return JSON.parse(row.state_json);
  };
  const writeSnapshot = (service) => {
    database.prepare(`
      INSERT INTO profile_consent_snapshot (id, schema_version, state_json, updated_at)
      VALUES (1, '0.1', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        schema_version = excluded.schema_version,
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `).run(JSON.stringify(service.exportState()), new Date(clock()).toISOString());
  };
  const transact = async (mode, persist, callback) => {
    if (closed) throw new Error("SQLite Profile consent prototype is closed.");
    database.exec(mode === "write" ? "BEGIN IMMEDIATE;" : "BEGIN;");
    try {
      const service = createInMemoryProfileConsentPrototype({ authorizeScope, initialState: readSnapshot() });
      const result = await callback(service);
      if (persist) writeSnapshot(service);
      database.exec("COMMIT;");
      return result;
    } catch (error) {
      try { database.exec("ROLLBACK;"); } catch { /* preserve original error */ }
      throw error;
    }
  };
  const enqueue = (mode, persist, callback) => {
    if (!acceptingOperations) return Promise.reject(new Error("SQLite Profile consent prototype is closed."));
    const operation = operationTail.then(() => transact(mode, persist, callback));
    operationTail = operation.catch(() => {});
    return operation;
  };

  return Object.freeze({
    applyChange: (request) => enqueue("write", true, (service) => service.applyChange(request)),
    hasCurrentConsent: (principal, request) => enqueue(
      "read",
      false,
      (service) => service.hasCurrentConsent(principal, request),
    ),
    listCurrent: (request) => enqueue("read", false, (service) => service.listCurrent(request)),
    close() {
      if (closePromise) return closePromise;
      acceptingOperations = false;
      closePromise = (async () => {
        await operationTail;
        database.close();
        closed = true;
      })();
      return closePromise;
    },
  });
}
