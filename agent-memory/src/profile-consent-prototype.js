import { createHash } from "node:crypto";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHARING_SCOPES = new Set(["personal", "household"]);
const PERMISSIONS = new Set(["profile:read", "profile:write"]);
const PURPOSES = new Set(["preference_sync", "agent_task"]);
const MEMORY_TYPES = new Set(["comfort_temperature_c", "comfort_brightness_pct", "sleep_time", "wake_time"]);

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validatePrincipal(principal, sharingScope) {
  if (!principal || principal.active !== true) throw codedError("AUTHENTICATION_FAILED");
  const ownerId = sharingScope === "personal" ? principal.profile_id : principal.home_id;
  if (typeof ownerId !== "string" || !ownerId.trim() || ownerId.length > 128) {
    throw codedError("PROFILE_SCOPE_DENIED");
  }
  return ownerId;
}

function consentTuple({ permission, purpose, sharing_scope, preference_type }) {
  return JSON.stringify([
    permission,
    purpose,
    sharing_scope,
    purpose === "agent_task" ? preference_type : null,
  ]);
}

function normalizeInitialState(initialState) {
  if (initialState === undefined) return { schema_version: "0.1", records: [], idempotency: [] };
  if (!initialState || typeof initialState !== "object" || Array.isArray(initialState)
    || Object.keys(initialState).sort().join("\0") !== ["idempotency", "records", "schema_version"].join("\0")
    || initialState.schema_version !== "0.1"
    || !Array.isArray(initialState.records)
    || !Array.isArray(initialState.idempotency)) {
    throw new TypeError("Unsupported Profile consent snapshot.");
  }

  const records = [];
  const recordKeys = new Set();
  for (const record of initialState.records) {
    if (!record || typeof record !== "object" || Array.isArray(record)
      || typeof record.owner_id !== "string" || !record.owner_id.trim() || record.owner_id.length > 128
      || !PERMISSIONS.has(record.permission) || !PURPOSES.has(record.purpose)
      || !SHARING_SCOPES.has(record.sharing_scope)
      || typeof record.active !== "boolean"
      || !Number.isSafeInteger(record.revision) || record.revision < 1
      || typeof record.changed_at !== "string" || !Number.isFinite(Date.parse(record.changed_at))) {
      throw new TypeError("Invalid Profile consent snapshot record.");
    }
    if (record.purpose === "agent_task") {
      if (record.permission !== "profile:read" || !MEMORY_TYPES.has(record.preference_type)) {
        throw new TypeError("Invalid Profile task consent snapshot record.");
      }
    } else if (Object.hasOwn(record, "preference_type")) {
      throw new TypeError("Invalid Profile sync consent snapshot record.");
    }
    const recordKey = JSON.stringify([record.owner_id, consentTuple(record)]);
    if (recordKeys.has(recordKey)) throw new TypeError("Duplicate Profile consent snapshot record.");
    recordKeys.add(recordKey);
    records.push({ ...record });
  }

  const idempotency = [];
  const idempotencyKeys = new Set();
  for (const entry of initialState.idempotency) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || typeof entry.key !== "string" || typeof entry.payload_hash !== "string"
      || !/^[a-f0-9]{64}$/.test(entry.payload_hash)
      || !entry.result || typeof entry.result !== "object" || Array.isArray(entry.result)
      || ![200, 404, 409].includes(entry.result.status)) {
      throw new TypeError("Invalid Profile consent idempotency snapshot entry.");
    }
    if (idempotencyKeys.has(entry.key)) throw new TypeError("Duplicate Profile consent idempotency key.");
    idempotencyKeys.add(entry.key);
    idempotency.push({ key: entry.key, payload_hash: entry.payload_hash, result: { ...entry.result } });
  }
  return { schema_version: "0.1", records, idempotency };
}

export function validateProfileConsentChange(change) {
  if (!change || typeof change !== "object" || Array.isArray(change)
    || Object.keys(change).sort().join("\0") !== [
      "schema_version", "change_id", "operation", "permission", "purpose",
      "sharing_scope", "expected_revision", "changed_at", "preference_type",
    ].sort().filter((key) => key !== "preference_type" || Object.hasOwn(change, key)).join("\0")) {
    throw codedError("INVALID_CONSENT_CHANGE");
  }
  if (change.schema_version !== "0.1"
    || typeof change.change_id !== "string" || !UUID_PATTERN.test(change.change_id)
    || !["grant", "revoke"].includes(change.operation)
    || !PERMISSIONS.has(change.permission)
    || !PURPOSES.has(change.purpose)
    || !SHARING_SCOPES.has(change.sharing_scope)
    || !Number.isSafeInteger(change.expected_revision) || change.expected_revision < 0
    || typeof change.changed_at !== "string" || !Number.isFinite(Date.parse(change.changed_at))) {
    throw codedError("INVALID_CONSENT_CHANGE");
  }
  if (change.purpose === "agent_task") {
    if (change.permission !== "profile:read" || !MEMORY_TYPES.has(change.preference_type)) {
      throw codedError("INVALID_CONSENT_PURPOSE");
    }
  } else if (Object.hasOwn(change, "preference_type")) {
    throw codedError("INVALID_CONSENT_PURPOSE");
  }

  return Object.freeze({ ...change });
}

/**
 * Synthetic in-memory consent state for local contract and flow validation.
 * It is not durable, does not authenticate users, and is not a production
 * consent service. Household access is denied unless the host injects a
 * trusted role/membership check.
 */
export function createInMemoryProfileConsentPrototype({ authorizeScope, initialState } = {}) {
  if (authorizeScope !== undefined && typeof authorizeScope !== "function") {
    throw new TypeError("authorizeScope must be a trusted host callback when provided.");
  }
  const normalizedInitialState = normalizeInitialState(initialState);
  const records = new Map(normalizedInitialState.records.map((record) => [
    JSON.stringify([record.owner_id, consentTuple(record)]),
    record,
  ]));
  const idempotency = new Map(normalizedInitialState.idempotency.map((entry) => [
    entry.key,
    { payload_hash: entry.payload_hash, result: entry.result },
  ]));

  async function authorize(principal, sharingScope, permission, purpose, operation) {
    const ownerId = validatePrincipal(principal, sharingScope);
    if (sharingScope === "household") {
      let allowed = false;
      try {
        allowed = await authorizeScope?.({ principal, sharing_scope: sharingScope, permission, purpose, operation }) === true;
      } catch {
        throw codedError("CONSENT_SERVICE_UNAVAILABLE");
      }
      if (!allowed) throw codedError("HOUSEHOLD_ACCESS_DENIED");
    }
    return ownerId;
  }

  async function applyChange({ principal, change } = {}) {
    const normalized = validateProfileConsentChange(change);
    const ownerId = await authorize(
      principal,
      normalized.sharing_scope,
      normalized.permission,
      normalized.purpose,
      normalized.operation,
    );
    const tuple = consentTuple(normalized);
    const idempotencyKey = JSON.stringify([ownerId, normalized.sharing_scope, normalized.change_id.toLowerCase()]);
    const payloadHash = createHash("sha256").update(stableStringify(normalized), "utf8").digest("hex");
    const prior = idempotency.get(idempotencyKey);
    if (prior) {
      if (prior.payload_hash !== payloadHash) {
        return { status: 409, applied: false, code: "IDEMPOTENCY_KEY_REUSED" };
      }
      return { ...prior.result, duplicate: true };
    }

    const recordKey = JSON.stringify([ownerId, tuple]);
    const current = records.get(recordKey);
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== normalized.expected_revision) {
      const result = { status: 409, applied: false, code: "REVISION_CONFLICT", current_revision: currentRevision };
      idempotency.set(idempotencyKey, { payload_hash: payloadHash, result });
      return result;
    }
    if (normalized.operation === "revoke" && !current) {
      const result = { status: 404, applied: false, code: "CONSENT_NOT_FOUND" };
      idempotency.set(idempotencyKey, { payload_hash: payloadHash, result });
      return result;
    }

    const state = {
      owner_id: ownerId,
      permission: normalized.permission,
      purpose: normalized.purpose,
      sharing_scope: normalized.sharing_scope,
      ...(normalized.preference_type ? { preference_type: normalized.preference_type } : {}),
      active: normalized.operation === "grant",
      revision: currentRevision + 1,
      changed_at: normalized.changed_at,
    };
    records.set(recordKey, state);
    const result = { status: 200, applied: true, active: state.active, revision: state.revision };
    idempotency.set(idempotencyKey, { payload_hash: payloadHash, result });
    return { ...result, duplicate: false };
  }

  async function hasCurrentConsent(principal, request = {}) {
    if (!PERMISSIONS.has(request.permission) || !PURPOSES.has(request.purpose)
      || !SHARING_SCOPES.has(request.sharing_scope)) return false;
    if (request.purpose === "agent_task"
      && (request.permission !== "profile:read" || !MEMORY_TYPES.has(request.preference_type))) return false;
    if (request.purpose === "preference_sync" && request.preference_type !== undefined) return false;

    let ownerId;
    try {
      ownerId = await authorize(principal, request.sharing_scope, request.permission, request.purpose, "check");
    } catch (error) {
      if (error?.code === "CONSENT_SERVICE_UNAVAILABLE") throw error;
      return false;
    }
    return records.get(JSON.stringify([ownerId, consentTuple(request)]))?.active === true;
  }

  async function listCurrent({ principal, sharing_scope } = {}) {
    if (!SHARING_SCOPES.has(sharing_scope)) throw codedError("INVALID_SHARING_SCOPE");
    const ownerId = await authorize(principal, sharing_scope, "profile:read", "preference_sync", "list");
    return [...records.values()]
      .filter((record) => record.owner_id === ownerId && record.sharing_scope === sharing_scope)
      .map(({ owner_id, ...record }) => ({ ...record }))
      .sort((left, right) => consentTuple(left).localeCompare(consentTuple(right)));
  }

  function exportState() {
    return {
      schema_version: "0.1",
      records: [...records.values()].map((record) => ({ ...record }))
        .sort((left, right) => JSON.stringify([left.owner_id, consentTuple(left)])
          .localeCompare(JSON.stringify([right.owner_id, consentTuple(right)]))),
      idempotency: [...idempotency.entries()].map(([key, entry]) => ({
        key,
        payload_hash: entry.payload_hash,
        result: { ...entry.result },
      })).sort((left, right) => left.key.localeCompare(right.key)),
    };
  }

  return Object.freeze({ applyChange, hasCurrentConsent, listCurrent, exportState });
}
