import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateProfileSyncChange } from "./profile-sync-prototype.js";
import { preparePrivateProfileSyncSqlitePath } from "./profile-sync-sqlite-path.js";

const ALLOWED_SCOPES = new Set(["personal", "household"]);
const TERMINAL_STATES = new Set(["acknowledged", "cancelled"]);

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

async function loadEncryptionKey(getEncryptionKey, principalBinding) {
  const provided = await getEncryptionKey({ principal_binding: principalBinding, purpose: "outbox" });
  if (!(Buffer.isBuffer(provided) || provided instanceof Uint8Array)) {
    throw codedError("OUTBOX_KEY_UNAVAILABLE");
  }
  const key = Buffer.from(provided);
  provided.fill(0);
  if (key.byteLength !== 32) {
    key.fill(0);
    throw codedError("OUTBOX_KEY_UNAVAILABLE");
  }
  return key;
}

function aadFor(change, payloadHash, principalBindingHash) {
  return Buffer.from(JSON.stringify([
    "profile-sync-outbox-v0.1",
    principalBindingHash,
    change.change_id,
    change.preference_id,
    change.sharing_scope,
    payloadHash,
  ]), "utf8");
}

function encryptChange(change, key, payloadHash, principalBindingHash) {
  const nonce = randomBytes(12);
  const aad = aadFor(change, payloadHash, principalBindingHash);
  const plaintext = Buffer.from(JSON.stringify(change), "utf8");
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { nonce, ciphertext, authTag: cipher.getAuthTag() };
  } finally {
    aad.fill(0);
    plaintext.fill(0);
  }
}

function decryptChange(row, key, principalBindingHash) {
  const nonce = Buffer.from(row.nonce);
  const ciphertext = Buffer.from(row.ciphertext);
  const authTag = Buffer.from(row.auth_tag);
  const metadataChange = {
    change_id: row.change_id,
    preference_id: row.preference_id,
    sharing_scope: row.sharing_scope,
  };
  const aad = aadFor(metadataChange, row.payload_hash, principalBindingHash);
  let plaintext;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const change = validateProfileSyncChange(JSON.parse(plaintext.toString("utf8")));
    const hash = createHash("sha256").update(stableStringify(change)).digest("hex");
    if (hash !== row.payload_hash
      || change.change_id !== row.change_id
      || change.preference_id !== row.preference_id
      || change.sharing_scope !== row.sharing_scope) {
      throw codedError("OUTBOX_PAYLOAD_INTEGRITY_FAILED");
    }
    return change;
  } finally {
    aad.fill(0);
    nonce.fill(0);
    ciphertext.fill(0);
    authTag.fill(0);
    plaintext?.fill(0);
  }
}

/**
 * Encrypted local queue for user-confirmed Profile changes. The AES key is
 * obtained for each operation from a host OS vault callback and is never stored
 * in SQLite. This module never sends network requests itself.
 */
export async function createProfileSyncOutbox({
  databasePath,
  principalBinding,
  getEncryptionKey,
  clock = () => Date.now(),
  retryBaseMs = 5000,
  retryMaxMs = 300000,
  leaseMs = 30000,
} = {}) {
  if (typeof databasePath !== "string" || !databasePath.trim() || databasePath === ":memory:") {
    throw new TypeError("An explicit SQLite file path is required for the durable outbox.");
  }
  if (typeof principalBinding !== "string" || !principalBinding.trim() || principalBinding.length > 256) {
    throw new TypeError("A trusted local principal binding is required; it must not come from a model or change payload.");
  }
  if (typeof getEncryptionKey !== "function") {
    throw new TypeError("A host-provided encryption-key callback is required; the outbox has no plaintext fallback.");
  }
  for (const [name, value] of [["retryBaseMs", retryBaseMs], ["retryMaxMs", retryMaxMs], ["leaseMs", leaseMs]]) {
    if (!Number.isSafeInteger(value) || value < 1000) throw new TypeError(`${name} must be an integer of at least 1000.`);
  }
  if (retryMaxMs < retryBaseMs) throw new TypeError("retryMaxMs must be greater than or equal to retryBaseMs.");

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    throw new Error("The encrypted local outbox requires a Node.js runtime with node:sqlite (Node 22.5+).");
  }

  const resolvedPath = path.resolve(databasePath);
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const relativeToRepository = path.relative(repositoryRoot, resolvedPath);
  if (relativeToRepository === "" || (!relativeToRepository.startsWith(`..${path.sep}`)
    && relativeToRepository !== ".." && !path.isAbsolute(relativeToRepository))) {
    throw new TypeError("The encrypted outbox database must be outside the Git workspace.");
  }
  const principalBindingHash = createHash("sha256").update(principalBinding, "utf8").digest("hex");
  const priorFile = await preparePrivateProfileSyncSqlitePath(resolvedPath);
  const database = new DatabaseSync(resolvedPath);
  try {
    if (priorFile && priorFile.size > 0) {
      const tableRows = database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all();
      const allowedTables = new Set(["profile_sync_outbox", "profile_sync_outbox_meta"]);
      if (!tableRows.some((row) => row.name === "profile_sync_outbox")
        || tableRows.some((row) => !allowedTables.has(row.name))) {
        throw new Error("Refusing to use a non-empty SQLite database that is not this outbox store.");
      }
    }
    database.exec("PRAGMA busy_timeout = 5000;");
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec(`
      CREATE TABLE IF NOT EXISTS profile_sync_outbox (
        change_id TEXT PRIMARY KEY,
        preference_id TEXT NOT NULL,
        sharing_scope TEXT NOT NULL CHECK (sharing_scope IN ('personal', 'household')),
        operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
        payload_hash TEXT NOT NULL,
        nonce BLOB,
        ciphertext BLOB,
        auth_tag BLOB,
        state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'acknowledged', 'needs_review', 'blocked', 'cancelled')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at TEXT,
        lease_id TEXT,
        lease_until TEXT,
        last_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS profile_sync_outbox_ready_idx
        ON profile_sync_outbox (state, created_at);
      CREATE TABLE IF NOT EXISTS profile_sync_outbox_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version TEXT NOT NULL CHECK (schema_version = '0.1'),
        principal_binding_hash TEXT NOT NULL
      );
    `);
    database.prepare("SELECT change_id FROM profile_sync_outbox LIMIT 0").all();
    const bindingRow = database.prepare("SELECT schema_version, principal_binding_hash FROM profile_sync_outbox_meta WHERE id = 1").get();
    if (bindingRow && (bindingRow.schema_version !== "0.1" || bindingRow.principal_binding_hash !== principalBindingHash)) {
      throw new Error("This outbox is bound to a different local principal.");
    }
    if (!bindingRow) {
      const existingRows = database.prepare("SELECT COUNT(*) AS count FROM profile_sync_outbox").get().count;
      if (existingRows > 0) throw new Error("Refusing to bind existing outbox rows without a principal marker.");
      database.prepare("INSERT INTO profile_sync_outbox_meta (id, schema_version, principal_binding_hash) VALUES (1, '0.1', ?)").run(principalBindingHash);
    }
  } catch (error) {
    database.close();
    throw error;
  }

  let closed = false;
  const transaction = (callback) => {
    if (closed) throw new Error("Profile sync outbox is closed.");
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

  function updateClaim(claim, values) {
    return transaction(() => database.prepare(`
      UPDATE profile_sync_outbox SET
        state = @state,
        ciphertext = @ciphertext,
        nonce = @nonce,
        auth_tag = @auth_tag,
        next_attempt_at = @next_attempt_at,
        lease_id = NULL,
        lease_until = NULL,
        last_code = @last_code,
        updated_at = @updated_at
      WHERE change_id = @change_id AND state = 'sending' AND lease_id = @lease_id
    `).run({
      ...values,
      change_id: claim.change_id,
      lease_id: claim.lease_id,
      updated_at: nowIso(clock),
    }).changes === 1);
  }

  async function enqueueChangesAtomically({ changes, consentConfirmed = false } = {}) {
    if (consentConfirmed !== true) throw codedError("REMOTE_SYNC_CONSENT_REQUIRED");
    if (!Array.isArray(changes)) throw new TypeError("An array of Profile changes is required.");

    const normalizedChanges = changes.map((change) => validateProfileSyncChange(change));
    const changeIds = new Set();
    const preferenceScopes = new Set();
    for (const change of normalizedChanges) {
      const changeId = change.change_id.toLowerCase();
      if (changeIds.has(changeId)) throw codedError("OUTBOX_BATCH_DUPLICATE_CHANGE_ID");
      changeIds.add(changeId);
      const preferenceScope = `${change.preference_id.toLowerCase()}\0${change.sharing_scope}`;
      if (preferenceScopes.has(preferenceScope)) throw codedError("OUTBOX_BATCH_DUPLICATE_PREFERENCE");
      preferenceScopes.add(preferenceScope);
    }
    if (normalizedChanges.length === 0) return [];

    const prepared = [];
    let key;
    try {
      key = await loadEncryptionKey(getEncryptionKey, principalBinding);
      for (const change of normalizedChanges) {
        const payloadHash = createHash("sha256").update(stableStringify(change)).digest("hex");
        prepared.push({
          change,
          payloadHash,
          encrypted: encryptChange(change, key, payloadHash, principalBindingHash),
        });
      }

      key.fill(0);
      key = null;

      return transaction(() => {
        const existingRows = prepared.map(({ change, payloadHash }) => {
          const existing = database.prepare(
            "SELECT payload_hash, state FROM profile_sync_outbox WHERE change_id = ?",
          ).get(change.change_id);
          if (existing && existing.payload_hash !== payloadHash) {
            throw codedError("OUTBOX_IDEMPOTENCY_KEY_REUSED");
          }
          return existing;
        });

        const createdAt = nowIso(clock);
        return prepared.map(({ change, payloadHash, encrypted }, index) => {
          const existing = existingRows[index];
          if (existing) {
            return { queued: false, duplicate: true, change_id: change.change_id, state: existing.state };
          }

          if (change.operation === "delete") {
            database.prepare(`
              UPDATE profile_sync_outbox SET
                state = 'cancelled', ciphertext = NULL, nonce = NULL, auth_tag = NULL,
                lease_id = NULL, lease_until = NULL, last_code = 'SUPERSEDED_BY_DELETE', updated_at = ?
              WHERE preference_id = ? AND sharing_scope = ? AND state IN ('pending', 'needs_review')
            `).run(createdAt, change.preference_id, change.sharing_scope);
          }
          database.prepare(`
            INSERT INTO profile_sync_outbox (
              change_id, preference_id, sharing_scope, operation, payload_hash,
              nonce, ciphertext, auth_tag, state, attempt_count, next_attempt_at,
              lease_id, lease_until, last_code, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?, ?)
          `).run(
            change.change_id,
            change.preference_id,
            change.sharing_scope,
            change.operation,
            payloadHash,
            encrypted.nonce,
            encrypted.ciphertext,
            encrypted.authTag,
            createdAt,
            createdAt,
            createdAt,
          );
          return { queued: true, duplicate: false, change_id: change.change_id, state: "pending" };
        });
      });
    } finally {
      key?.fill(0);
      for (const item of prepared) {
        item.encrypted.nonce.fill(0);
        item.encrypted.ciphertext.fill(0);
        item.encrypted.authTag.fill(0);
      }
    }
  }

  async function enqueueChange({ change, consentConfirmed = false } = {}) {
    const [receipt] = await enqueueChangesAtomically({ changes: [change], consentConfirmed });
    return receipt;
  }

  function nextDelay(attemptCount) {
    return Math.min(retryMaxMs, retryBaseMs * (2 ** Math.min(Math.max(attemptCount - 1, 0), 20)));
  }

  function claimNext() {
    return transaction(() => {
      const now = nowIso(clock);
      const row = database.prepare(`
        SELECT * FROM profile_sync_outbox
        WHERE state IN ('pending', 'sending')
        ORDER BY created_at, rowid
        LIMIT 1
      `).get();
      if (!row) return null;
      if (row.state === "sending" && row.lease_until > now) return null;
      if (row.state === "pending" && row.next_attempt_at && row.next_attempt_at > now) return null;

      const leaseId = randomUUID();
      const leaseUntil = new Date(clock() + leaseMs).toISOString();
      const attemptCount = row.attempt_count + 1;
      database.prepare(`
        UPDATE profile_sync_outbox SET state = 'sending', attempt_count = ?, lease_id = ?, lease_until = ?, updated_at = ?
        WHERE change_id = ?
      `).run(attemptCount, leaseId, leaseUntil, now, row.change_id);
      return { ...row, attempt_count: attemptCount, lease_id: leaseId, lease_until: leaseUntil };
    });
  }

  async function dispatchOne({ send, isConsentCurrent } = {}) {
    if (typeof send !== "function" || typeof isConsentCurrent !== "function") {
      throw new TypeError("A sender and current-consent callback are required for dispatch.");
    }
    const claim = claimNext();
    if (!claim) return { status: "idle" };

    let consent;
    try {
        consent = await isConsentCurrent({
          principal_binding: principalBinding,
          sharing_scope: claim.sharing_scope,
          change_id: claim.change_id,
          operation: claim.operation,
          permission: "profile:write",
          purpose: "preference_sync",
        });
    } catch {
      const delay = nextDelay(claim.attempt_count);
      updateClaim(claim, {
        state: "pending", ciphertext: claim.ciphertext, nonce: claim.nonce, auth_tag: claim.auth_tag,
        next_attempt_at: new Date(clock() + delay).toISOString(), last_code: "CONSENT_CHECK_UNAVAILABLE",
      });
      return { status: "retry_scheduled", code: "CONSENT_CHECK_UNAVAILABLE" };
    }
    if (consent !== true) {
      updateClaim(claim, {
        state: "cancelled", ciphertext: null, nonce: null, auth_tag: null,
        next_attempt_at: null, last_code: "PROFILE_CONSENT_REQUIRED",
      });
      return { status: "cancelled", code: "PROFILE_CONSENT_REQUIRED" };
    }

    let key;
    let change;
    try {
      key = await loadEncryptionKey(getEncryptionKey, principalBinding);
      change = decryptChange(claim, key, principalBindingHash);
    } catch {
      updateClaim(claim, {
        state: "blocked", ciphertext: claim.ciphertext, nonce: claim.nonce, auth_tag: claim.auth_tag,
        next_attempt_at: null, last_code: "OUTBOX_DECRYPTION_FAILED",
      });
      return { status: "blocked", code: "OUTBOX_DECRYPTION_FAILED" };
    } finally {
      key?.fill(0);
    }

    let response;
    try {
      response = await send(change, { principal_binding: principalBinding });
    } catch {
      const delay = nextDelay(claim.attempt_count);
      updateClaim(claim, {
        state: "pending", ciphertext: claim.ciphertext, nonce: claim.nonce, auth_tag: claim.auth_tag,
        next_attempt_at: new Date(clock() + delay).toISOString(), last_code: "NETWORK_UNAVAILABLE",
      });
      return { status: "retry_scheduled", code: "NETWORK_UNAVAILABLE", attempt_count: claim.attempt_count };
    }

    const responseStatus = Number(response?.status);
    const responseBody = response?.body && typeof response.body === "object" ? response.body : {};
    const responseCode = typeof responseBody.code === "string" && /^[A-Z0-9_]{1,64}$/.test(responseBody.code)
      ? responseBody.code
      : null;

    if (responseStatus >= 200 && responseStatus < 300 && responseBody.applied === true) {
      updateClaim(claim, {
        state: "acknowledged", ciphertext: null, nonce: null, auth_tag: null,
        next_attempt_at: null, last_code: responseBody.duplicate === true ? "ACKNOWLEDGED_DUPLICATE" : "ACKNOWLEDGED",
      });
      return { status: "acknowledged", duplicate: responseBody.duplicate === true };
    }
    if (responseStatus === 409) {
      updateClaim(claim, {
        state: "needs_review", ciphertext: claim.ciphertext, nonce: claim.nonce, auth_tag: claim.auth_tag,
        next_attempt_at: null, last_code: responseCode ?? "REVISION_CONFLICT",
      });
      return { status: "needs_review", code: responseCode ?? "REVISION_CONFLICT" };
    }
    if ((responseStatus === 401 || responseStatus === 403) && responseCode === "PROFILE_CONSENT_REQUIRED") {
      updateClaim(claim, {
        state: "cancelled", ciphertext: null, nonce: null, auth_tag: null,
        next_attempt_at: null, last_code: responseCode,
      });
      return { status: "cancelled", code: responseCode };
    }
    if (responseStatus === 401 || responseStatus === 403) {
      updateClaim(claim, {
        state: "blocked", ciphertext: claim.ciphertext, nonce: claim.nonce, auth_tag: claim.auth_tag,
        next_attempt_at: null, last_code: responseCode ?? "AUTHORIZATION_REQUIRED",
      });
      return { status: "blocked", code: responseCode ?? "AUTHORIZATION_REQUIRED" };
    }
    if (responseStatus === 429 || responseStatus >= 500 || !Number.isInteger(responseStatus)) {
      const delay = nextDelay(claim.attempt_count);
      updateClaim(claim, {
        state: "pending", ciphertext: claim.ciphertext, nonce: claim.nonce, auth_tag: claim.auth_tag,
        next_attempt_at: new Date(clock() + delay).toISOString(), last_code: responseCode ?? "REMOTE_UNAVAILABLE",
      });
      return { status: "retry_scheduled", code: responseCode ?? "REMOTE_UNAVAILABLE", attempt_count: claim.attempt_count };
    }
    updateClaim(claim, {
      state: "needs_review", ciphertext: claim.ciphertext, nonce: claim.nonce, auth_tag: claim.auth_tag,
      next_attempt_at: null, last_code: responseCode ?? "REMOTE_REJECTED",
    });
    return { status: "needs_review", code: responseCode ?? "REMOTE_REJECTED" };
  }

  function revokePending({ sharing_scope } = {}) {
    if (!ALLOWED_SCOPES.has(sharing_scope)) throw codedError("INVALID_SHARING_SCOPE");
    return transaction(() => {
      const result = database.prepare(`
        UPDATE profile_sync_outbox SET
          state = 'cancelled', ciphertext = NULL, nonce = NULL, auth_tag = NULL,
          lease_id = NULL, lease_until = NULL, next_attempt_at = NULL,
          last_code = 'PROFILE_CONSENT_REVOKED', updated_at = ?
        WHERE sharing_scope = ? AND state NOT IN ('acknowledged', 'cancelled')
      `).run(nowIso(clock), sharing_scope);
      return { cancelled_count: result.changes };
    });
  }

  function resumeBlocked({ change_id, consentConfirmed = false } = {}) {
    if (consentConfirmed !== true) throw codedError("REMOTE_SYNC_CONSENT_REQUIRED");
    return transaction(() => {
      const result = database.prepare(`
        UPDATE profile_sync_outbox SET state = 'pending', next_attempt_at = ?, last_code = NULL,
          updated_at = ?, lease_id = NULL, lease_until = NULL
        WHERE change_id = ? AND state = 'blocked' AND ciphertext IS NOT NULL
      `).run(nowIso(clock), nowIso(clock), change_id);
      return { resumed: result.changes === 1 };
    });
  }

  function listSummary() {
    if (closed) throw new Error("Profile sync outbox is closed.");
    return database.prepare(`
      SELECT change_id, preference_id, sharing_scope, operation, state, attempt_count,
        next_attempt_at, last_code, created_at, updated_at
      FROM profile_sync_outbox ORDER BY created_at, rowid
    `).all().map((row) => ({ ...row }));
  }

  return Object.freeze({
    enqueueChange,
    enqueueChangesAtomically,
    dispatchOne,
    revokePending,
    resumeBlocked,
    listSummary,
    close() {
      if (!closed) {
        database.close();
        closed = true;
      }
    },
  });
}
