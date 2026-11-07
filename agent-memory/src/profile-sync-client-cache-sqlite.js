import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyProfileSyncPage } from "./profile-sync-client-cache.js";
import { preparePrivateProfileSyncSqlitePath } from "./profile-sync-sqlite-path.js";

const SHARING_SCOPES = new Set(["personal", "household"]);
const EMPTY_STATE = Object.freeze({ schema_version: "0.1", feeds: [] });

function codedError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`)
    && relative !== ".." && !path.isAbsolute(relative));
}

function aadFor(principalBindingHash, sharingScope) {
  return Buffer.from(JSON.stringify([
    "profile-sync-client-cache-v0.1",
    principalBindingHash,
    sharingScope,
  ]), "utf8");
}

async function loadEncryptionKey(getEncryptionKey, principalBinding) {
  const provided = await getEncryptionKey({ principal_binding: principalBinding, purpose: "client-cache" });
  if (!(Buffer.isBuffer(provided) || provided instanceof Uint8Array)) {
    throw codedError("CLIENT_CACHE_KEY_UNAVAILABLE");
  }
  const key = Buffer.from(provided);
  provided.fill(0);
  if (key.length !== 32) {
    key.fill(0);
    throw codedError("CLIENT_CACHE_KEY_UNAVAILABLE");
  }
  return key;
}

function encryptState(state, key, principalBindingHash, sharingScope) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aadFor(principalBindingHash, sharingScope));
  const plaintext = Buffer.from(JSON.stringify(state), "utf8");
  try {
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { nonce, ciphertext, authTag: cipher.getAuthTag() };
  } finally {
    plaintext.fill(0);
  }
}

function decryptState(row, key, principalBindingHash, sharingScope) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(row.nonce));
  decipher.setAAD(aadFor(principalBindingHash, sharingScope));
  decipher.setAuthTag(Buffer.from(row.auth_tag));
  const ciphertext = Buffer.from(row.ciphertext);
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const state = JSON.parse(plaintext.toString("utf8"));
    if (!state || state.schema_version !== "0.1" || !Array.isArray(state.feeds)) {
      throw codedError("CLIENT_CACHE_STATE_INVALID");
    }
    return state;
  } catch {
    throw codedError("CLIENT_CACHE_DECRYPTION_FAILED");
  } finally {
    ciphertext.fill(0);
    plaintext?.fill(0);
  }
}

/**
 * Encrypted local persistence for a Profile sync receiver. SQLite stores only
 * the principal hash, scope, timestamps, nonce, ciphertext and GCM tag. The
 * caller must provide a current-consent check and authenticated-response binding.
 * This module never performs network requests.
 */
export async function createEncryptedProfileSyncClientCache({
  databasePath,
  principalBinding,
  getEncryptionKey,
  isConsentCurrent,
  clock = () => Date.now(),
} = {}) {
  if (typeof databasePath !== "string" || !databasePath.trim() || databasePath === ":memory:") {
    throw new TypeError("An explicit SQLite file path is required for the encrypted client cache.");
  }
  if (typeof principalBinding !== "string" || !principalBinding.trim() || principalBinding.length > 256) {
    throw new TypeError("A trusted local principal binding is required.");
  }
  if (typeof getEncryptionKey !== "function") {
    throw new TypeError("A host-provided encryption-key callback is required.");
  }
  if (typeof isConsentCurrent !== "function") {
    throw new TypeError("A host-provided current-consent callback is required.");
  }

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    throw new Error("The encrypted client cache requires Node.js with node:sqlite (Node 22.5+).");
  }

  const resolvedPath = path.resolve(databasePath);
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  if (isWithin(repositoryRoot, resolvedPath)) {
    throw new TypeError("The encrypted client-cache database must be outside the Git workspace.");
  }
  const principalBindingHash = createHash("sha256").update(principalBinding, "utf8").digest("hex");
  const priorFile = await preparePrivateProfileSyncSqlitePath(resolvedPath);
  const database = new DatabaseSync(resolvedPath);
  try {
    if (priorFile && priorFile.size > 0) {
      const tableRows = database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all();
      const allowedTables = new Set(["profile_sync_client_cache", "profile_sync_client_cache_meta"]);
      if (!tableRows.some((row) => row.name === "profile_sync_client_cache_meta")
        || tableRows.some((row) => !allowedTables.has(row.name))) {
        throw new Error("Refusing to use a non-empty SQLite database that is not this client cache.");
      }
    }
    database.exec("PRAGMA busy_timeout = 5000;");
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec(`
      CREATE TABLE IF NOT EXISTS profile_sync_client_cache_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version TEXT NOT NULL CHECK (schema_version = '0.1'),
        principal_binding_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profile_sync_client_cache (
        sharing_scope TEXT PRIMARY KEY CHECK (sharing_scope IN ('personal', 'household')),
        schema_version TEXT NOT NULL CHECK (schema_version = '0.1'),
        nonce BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const bindingRow = database.prepare(
      "SELECT schema_version, principal_binding_hash FROM profile_sync_client_cache_meta WHERE id = 1",
    ).get();
    if (bindingRow && (bindingRow.schema_version !== "0.1"
      || bindingRow.principal_binding_hash !== principalBindingHash)) {
      throw new Error("This client cache is bound to a different local principal.");
    }
    if (!bindingRow) {
      const existingRows = database.prepare("SELECT COUNT(*) AS count FROM profile_sync_client_cache").get().count;
      if (existingRows > 0) throw new Error("Refusing to bind existing cache rows without a principal marker.");
      database.prepare(
        "INSERT INTO profile_sync_client_cache_meta (id, schema_version, principal_binding_hash) VALUES (1, '0.1', ?)",
      ).run(principalBindingHash);
    }
  } catch (error) {
    database.close();
    throw error;
  }

  let closed = false;
  const transaction = (callback) => {
    if (closed) throw new Error("Encrypted Profile client cache is closed.");
    database.exec("BEGIN IMMEDIATE;");
    try {
      const result = callback();
      database.exec("COMMIT;");
      return result;
    } catch (error) {
      try { database.exec("ROLLBACK;"); } catch { /* preserve original error */ }
      throw error;
    }
  };
  const transactionAsync = async (callback) => {
    if (closed) throw new Error("Encrypted Profile client cache is closed.");
    database.exec("BEGIN IMMEDIATE;");
    try {
      const result = await callback();
      database.exec("COMMIT;");
      return result;
    } catch (error) {
      try { database.exec("ROLLBACK;"); } catch { /* preserve original error */ }
      throw error;
    }
  };

  async function requireConsent(sharingScope) {
    let allowed;
    try {
      allowed = await isConsentCurrent({
        principal_binding: principalBinding,
        sharing_scope: sharingScope,
        permission: "profile:read",
        purpose: "preference_sync",
      });
    } catch {
      throw codedError("PROFILE_CONSENT_CHECK_UNAVAILABLE", "无法确认当前同步授权，已拒绝访问缓存。");
    }
    if (allowed !== true) throw codedError("PROFILE_CONSENT_REQUIRED", "当前身份没有该范围的同步授权。");
  }

  function readRow(sharingScope) {
    return database.prepare(`
      SELECT schema_version, nonce, ciphertext, auth_tag
      FROM profile_sync_client_cache WHERE sharing_scope = ?
    `).get(sharingScope);
  }

  async function readFeed({ sharingScope, authenticatedPrincipalBinding } = {}) {
    if (!SHARING_SCOPES.has(sharingScope)) throw codedError("INVALID_SHARING_SCOPE");
    if (authenticatedPrincipalBinding !== principalBinding) throw codedError("PROFILE_PRINCIPAL_MISMATCH");
    await requireConsent(sharingScope);
    const key = await loadEncryptionKey(getEncryptionKey, principalBinding);
    try {
      return await transactionAsync(async () => {
        await requireConsent(sharingScope);
        const row = readRow(sharingScope);
        if (!row) return { sharing_scope: sharingScope, cursor: 0, records: [] };
        if (row.schema_version !== "0.1") throw codedError("CLIENT_CACHE_SCHEMA_UNSUPPORTED");
        const state = decryptState(row, key, principalBindingHash, sharingScope);
        if (state.feeds.length > 1 || (state.feeds.length === 1
          && (state.feeds[0].principal_binding_hash !== principalBindingHash
            || state.feeds[0].sharing_scope !== sharingScope))) {
          throw codedError("CLIENT_CACHE_SCOPE_MISMATCH");
        }
        const result = applyProfileSyncPage({
          state,
          principalBinding,
          sharingScope,
          page: { changes: [], next_cursor: state.feeds[0]?.cursor ?? 0, has_more: false },
        });
        const feed = result.state.feeds.find((entry) => entry.principal_binding_hash === principalBindingHash
          && entry.sharing_scope === sharingScope);
        return {
          sharing_scope: sharingScope,
          cursor: feed.cursor,
          records: feed.records,
        };
      });
    } finally {
      key.fill(0);
    }
  }

  async function applyPage({ sharingScope, page, authenticatedPrincipalBinding } = {}) {
    if (!SHARING_SCOPES.has(sharingScope)) throw codedError("INVALID_SHARING_SCOPE");
    if (authenticatedPrincipalBinding !== principalBinding) throw codedError("PROFILE_PRINCIPAL_MISMATCH");
    await requireConsent(sharingScope);
    const key = await loadEncryptionKey(getEncryptionKey, principalBinding);
    let encrypted;
    try {
      const summary = await transactionAsync(async () => {
        await requireConsent(sharingScope);
        const row = readRow(sharingScope);
        if (row && row.schema_version !== "0.1") throw codedError("CLIENT_CACHE_SCHEMA_UNSUPPORTED");
        const state = row
          ? decryptState(row, key, principalBindingHash, sharingScope)
          : { schema_version: "0.1", feeds: [] };
        const applied = applyProfileSyncPage({ state, principalBinding, sharingScope, page });
        const matchingFeeds = applied.state.feeds.filter((feed) => feed.principal_binding_hash === principalBindingHash
          && feed.sharing_scope === sharingScope);
        if (matchingFeeds.length !== 1 || applied.state.feeds.length !== 1) {
          throw codedError("CLIENT_CACHE_SCOPE_MISMATCH");
        }
        encrypted = encryptState(applied.state, key, principalBindingHash, sharingScope);
        database.prepare(`
          INSERT INTO profile_sync_client_cache (sharing_scope, schema_version, nonce, ciphertext, auth_tag, updated_at)
          VALUES (?, '0.1', ?, ?, ?, ?)
          ON CONFLICT(sharing_scope) DO UPDATE SET
            schema_version = excluded.schema_version,
            nonce = excluded.nonce,
            ciphertext = excluded.ciphertext,
            auth_tag = excluded.auth_tag,
            updated_at = excluded.updated_at
        `).run(sharingScope, encrypted.nonce, encrypted.ciphertext, encrypted.authTag, new Date(clock()).toISOString());
        return applied.summary;
      });
      return summary;
    } finally {
      key.fill(0);
      encrypted?.nonce.fill(0);
      encrypted?.ciphertext.fill(0);
      encrypted?.authTag.fill(0);
    }
  }

  function clearScopeAfterRevocation({ sharingScope, revocationConfirmed = false } = {}) {
    if (!SHARING_SCOPES.has(sharingScope)) throw codedError("INVALID_SHARING_SCOPE");
    if (revocationConfirmed !== true) throw codedError("REVOCATION_CONFIRMATION_REQUIRED");
    return transaction(() => {
      const result = database.prepare("DELETE FROM profile_sync_client_cache WHERE sharing_scope = ?").run(sharingScope);
      return { cleared: result.changes === 1 };
    });
  }

  return Object.freeze({
    applyPage,
    readFeed,
    clearScopeAfterRevocation,
    close() {
      if (!closed) {
        database.close();
        closed = true;
      }
    },
  });
}
