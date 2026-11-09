import { createHash } from "node:crypto";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const SCOPE_VALUES = new Set(["personal", "household"]);
const MEMORY_TYPES = new Set(["comfort_temperature_c", "comfort_brightness_pct", "sleep_time", "wake_time"]);
const NUMERIC_MEMORY_TYPES = new Set(["comfort_temperature_c", "comfort_brightness_pct"]);
const MAX_PAGE_SIZE = 100;
const MAX_CURRENT_PREFERENCE_RESULTS = 100;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clone(value) {
  return structuredClone(value);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertPrincipal(principal, permission, sharingScope) {
  if (!principal || principal.active !== true
    || typeof principal.profile_id !== "string" || !principal.profile_id
    || !Array.isArray(principal.permissions) || !principal.permissions.includes(permission)) {
    throw codedError("PROFILE_ACCESS_DENIED", "没有有效的 Profile 身份或操作权限。");
  }
  if (!SCOPE_VALUES.has(sharingScope)
    || !Array.isArray(principal.sharing_scopes)
    || !principal.sharing_scopes.includes(sharingScope)) {
    throw codedError("PROFILE_SCOPE_DENIED", "当前身份没有该偏好范围的访问授权。");
  }
  if (sharingScope === "household"
    && (typeof principal.home_id !== "string" || !principal.home_id
      || (permission === "profile:write" && principal.can_write_household !== true))) {
    throw codedError("HOUSEHOLD_ACCESS_DENIED", "当前身份没有家庭偏好的访问或写入授权。");
  }
}

function ownerKey(principal, sharingScope) {
  const owner = sharingScope === "household" ? principal.home_id : principal.profile_id;
  return `${sharingScope}:${owner}`;
}

function preferenceKey(preference) {
  return `${preference.memory_type}:${stableStringify(preference.scope ?? {})}`;
}

function validatePreference(preference) {
  if (!preference || typeof preference !== "object" || Array.isArray(preference)) {
    throw codedError("INVALID_PREFERENCE", "偏好内容必须是对象。");
  }
  const keys = Object.keys(preference);
  if (keys.some((key) => !["memory_type", "value", "scope"].includes(key))) {
    throw codedError("INVALID_PREFERENCE", "偏好包含不支持的字段。");
  }
  if (!MEMORY_TYPES.has(preference.memory_type)) {
    throw codedError("UNSUPPORTED_MEMORY_TYPE", "只支持舒适温度、舒适亮度、睡觉时间和起床时间。");
  }

  const scope = preference.scope ?? {};
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw codedError("INVALID_PREFERENCE_SCOPE", "偏好范围格式无效。");
  }
  const scopeKeys = Object.keys(scope);
  const allowedScopeKeys = NUMERIC_MEMORY_TYPES.has(preference.memory_type)
    ? ["room_id"]
    : ["room_id", "day_type", "time_zone"];
  if (scopeKeys.some((key) => !allowedScopeKeys.includes(key))) {
    throw codedError("INVALID_PREFERENCE_SCOPE", "偏好范围包含不支持的字段。");
  }
  if (scope.room_id !== undefined
    && (typeof scope.room_id !== "string" || !/^[a-z0-9_-]{1,40}$/.test(scope.room_id))) {
    throw codedError("INVALID_ROOM_ID", "room_id 格式无效。");
  }

  if (NUMERIC_MEMORY_TYPES.has(preference.memory_type)) {
    const isTemperature = preference.memory_type === "comfort_temperature_c";
    const minimum = isTemperature ? 16 : 1;
    const maximum = isTemperature ? 30 : 100;
    if (typeof preference.value !== "number" || !Number.isFinite(preference.value)
      || preference.value < minimum || preference.value > maximum) {
      throw codedError(
        isTemperature ? "INVALID_TEMPERATURE" : "INVALID_BRIGHTNESS",
        isTemperature ? "舒适温度必须是 16–30℃ 之间的数字。" : "舒适亮度必须是 1–100% 之间的数字。",
      );
    }
    return clone({ memory_type: preference.memory_type, value: preference.value, ...(scopeKeys.length ? { scope } : {}) });
  }

  if (typeof preference.value !== "string" || !TIME_PATTERN.test(preference.value)) {
    throw codedError("INVALID_LOCAL_TIME", "作息时间必须使用 HH:mm 格式。");
  }
  if (!(["weekday", "weekend"].includes(scope.day_type) || scope.day_type === undefined)) {
    throw codedError("INVALID_DAY_TYPE", "day_type 必须为 weekday 或 weekend。");
  }
  if (typeof scope.time_zone !== "string" || !scope.time_zone) {
    throw codedError("TIME_ZONE_REQUIRED", "作息偏好必须带 IANA 时区。");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: scope.time_zone });
  } catch {
    throw codedError("INVALID_TIME_ZONE", "time_zone 不是有效的 IANA 时区。");
  }
  return clone({ memory_type: preference.memory_type, value: preference.value, scope });
}

function validateChange(change) {
  if (!change || typeof change !== "object" || Array.isArray(change)) {
    throw codedError("INVALID_CHANGE", "偏好变更必须是对象。");
  }
  if (change.schema_version !== "0.1"
    || !UUID_PATTERN.test(change.change_id ?? "")
    || !UUID_PATTERN.test(change.preference_id ?? "")
    || !["upsert", "delete"].includes(change.operation)
    || !SCOPE_VALUES.has(change.sharing_scope)
    || !Number.isSafeInteger(change.expected_revision)
    || change.expected_revision < 0
    || typeof change.changed_at !== "string"
    || !Number.isFinite(Date.parse(change.changed_at))) {
    throw codedError("INVALID_CHANGE", "变更信封格式或字段无效。");
  }
  const allowedKeys = new Set([
    "schema_version", "change_id", "preference_id", "operation", "sharing_scope", "expected_revision", "changed_at", "preference",
  ]);
  if (Object.keys(change).some((key) => !allowedKeys.has(key))) {
    throw codedError("INVALID_CHANGE", "变更信封包含不支持的字段。");
  }
  if (change.operation === "upsert") {
    if (!Object.hasOwn(change, "preference")) throw codedError("INVALID_CHANGE", "upsert 必须包含 preference。");
    return { ...clone(change), preference: validatePreference(change.preference) };
  }
  if (Object.hasOwn(change, "preference")) throw codedError("INVALID_CHANGE", "delete 不得包含 preference。");
  return clone(change);
}

/** Validate and normalize one v0.1 change before a trusted local outbox stores it. */
export function validateProfileSyncChange(change) {
  return validateChange(change);
}

/**
 * Ephemeral reference service for local-only protocol work. It uses synthetic
 * principals and memory only; it is not an authenticated or persistent server.
 */
export function createInMemoryProfileSyncPrototype({ clock = () => Date.now(), initialState } = {}) {
  const state = initialState ?? {
    schema_version: "0.1",
    recordsByOwner: [],
    changesByOwner: [],
    idempotency: [],
    naturalKeysByOwner: [],
  };
  if (state.schema_version !== "0.1"
    || !Array.isArray(state.recordsByOwner)
    || !Array.isArray(state.changesByOwner)
    || !Array.isArray(state.idempotency)
    || !Array.isArray(state.naturalKeysByOwner)) {
    throw codedError("INVALID_PROFILE_SYNC_STATE", "持久化 Profile 状态版本或结构无效。");
  }

  const recordsByOwner = new Map(state.recordsByOwner.map(([key, entries]) => [key, new Map(entries)]));
  const changesByOwner = new Map(state.changesByOwner.map(([key, entries]) => [key, clone(entries)]));
  const idempotency = new Map(clone(state.idempotency));
  const naturalKeysByOwner = new Map(state.naturalKeysByOwner.map(([key, entries]) => [key, new Map(entries)]));

  function ownerStores(key) {
    if (!recordsByOwner.has(key)) recordsByOwner.set(key, new Map());
    if (!changesByOwner.has(key)) changesByOwner.set(key, []);
    if (!naturalKeysByOwner.has(key)) naturalKeysByOwner.set(key, new Map());
    return {
      records: recordsByOwner.get(key),
      history: changesByOwner.get(key),
      naturalKeys: naturalKeysByOwner.get(key),
    };
  }

  function pull({ principal, sharing_scope, cursor = 0, limit = 50 } = {}) {
    assertPrincipal(principal, "profile:read", sharing_scope);
    if (!Number.isSafeInteger(cursor) || cursor < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw codedError("INVALID_SYNC_CURSOR", "游标或分页大小无效。");
    }
    const key = ownerKey(principal, sharing_scope);
    const { history } = ownerStores(key);
    const latestCursor = history.at(-1)?.cursor ?? 0;
    if (cursor > latestCursor) {
      throw codedError("INVALID_SYNC_CURSOR", "游标超出当前服务端范围。");
    }
    const page = history.filter((entry) => entry.cursor > cursor).slice(0, limit);
    const nextCursor = page.length ? page.at(-1).cursor : cursor;
    return {
      changes: clone(page),
      next_cursor: nextCursor,
      has_more: history.some((entry) => entry.cursor > nextCursor),
    };
  }

  function readCurrentPreferences({ principal, sharing_scope, memory_type, scope = {} } = {}) {
    assertPrincipal(principal, "profile:read", sharing_scope);
    if (!MEMORY_TYPES.has(memory_type)) {
      throw codedError("INVALID_PREFERENCE_TYPE", "读取当前偏好必须指定支持的 memory_type。");
    }
    if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
      throw codedError("INVALID_PREFERENCE_SCOPE", "偏好读取范围格式无效。");
    }
    const allowedScopeKeys = NUMERIC_MEMORY_TYPES.has(memory_type)
      ? ["room_id"]
      : ["room_id", "day_type", "time_zone"];
    if (Object.keys(scope).some((key) => !allowedScopeKeys.includes(key))) {
      throw codedError("INVALID_PREFERENCE_SCOPE", "偏好读取范围包含不支持的字段。");
    }
    if (scope.room_id !== undefined
      && (typeof scope.room_id !== "string" || !/^[a-z0-9_-]{1,40}$/.test(scope.room_id))) {
      throw codedError("INVALID_ROOM_ID", "room_id 格式无效。");
    }
    if (scope.day_type !== undefined && !["weekday", "weekend"].includes(scope.day_type)) {
      throw codedError("INVALID_DAY_TYPE", "day_type 必须为 weekday 或 weekend。");
    }
    if (scope.time_zone !== undefined) {
      if (typeof scope.time_zone !== "string" || scope.time_zone.length > 80) {
        throw codedError("INVALID_TIME_ZONE", "time_zone 不是有效的 IANA 时区。");
      }
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: scope.time_zone });
      } catch {
        throw codedError("INVALID_TIME_ZONE", "time_zone 不是有效的 IANA 时区。");
      }
    }

    const key = ownerKey(principal, sharing_scope);
    const records = recordsByOwner.get(key) ?? new Map();
    const preferences = [...records.values()]
      .filter((record) => !record.deleted && record.preference?.memory_type === memory_type)
      .filter((record) => Object.entries(scope).every(([scopeKey, value]) => record.preference.scope?.[scopeKey] === value))
      .sort((left, right) => left.preference_id.localeCompare(right.preference_id))
      .map((record) => ({
        preference_id: record.preference_id,
        revision: record.revision,
        preference: clone(record.preference),
        changed_at: record.updated_at,
      }));
    if (preferences.length > MAX_CURRENT_PREFERENCE_RESULTS) {
      throw codedError("PREFERENCE_RESULT_LIMIT_EXCEEDED", "当前类别结果过多；请缩小偏好范围。");
    }
    return { preferences };
  }

  function applyChange({ principal, change } = {}) {
    const validChange = validateChange(change);
    assertPrincipal(principal, "profile:write", validChange.sharing_scope);

    const key = ownerKey(principal, validChange.sharing_scope);
    const stores = ownerStores(key);
    const replayKey = `${key}:${validChange.change_id}`;
    const fingerprint = createHash("sha256").update(stableStringify(validChange)).digest("hex");
    const replay = idempotency.get(replayKey);
    if (replay) {
      if (replay.fingerprint !== fingerprint) {
        return { applied: false, code: "IDEMPOTENCY_KEY_REUSED", status: 409 };
      }
      return { ...clone(replay.result), duplicate: true };
    }

    const existing = stores.records.get(validChange.preference_id);
    const currentRevision = existing?.revision ?? 0;
    if (validChange.expected_revision !== currentRevision) {
      const result = {
        applied: false,
        status: 409,
        code: "REVISION_CONFLICT",
        current_revision: currentRevision,
        ...(existing && !existing.deleted ? { current_preference: clone(existing.preference) } : {}),
        ...(existing?.deleted ? { deleted: true } : {}),
      };
      idempotency.set(replayKey, { fingerprint, result, preference_id: validChange.preference_id });
      return clone(result);
    }

    if (validChange.operation === "delete" && (!existing || existing.deleted)) {
      const result = { applied: false, status: 404, code: "PREFERENCE_NOT_FOUND" };
      idempotency.set(replayKey, { fingerprint, result, preference_id: validChange.preference_id });
      return clone(result);
    }

    const priorNaturalKey = existing?.preference ? preferenceKey(existing.preference) : null;
    if (validChange.operation === "upsert") {
      const naturalKey = preferenceKey(validChange.preference);
      const competingId = stores.naturalKeys.get(naturalKey);
      if (competingId && competingId !== validChange.preference_id) {
        const competing = stores.records.get(competingId);
        if (competing && !competing.deleted) {
          const result = {
            applied: false,
            status: 409,
            code: "PREFERENCE_EXISTS",
            preference_id: competingId,
            current_revision: competing.revision,
            current_preference: clone(competing.preference),
          };
          idempotency.set(replayKey, { fingerprint, result, preference_id: competingId });
          return clone(result);
        }
      }
      if (priorNaturalKey && priorNaturalKey !== naturalKey) {
        return { applied: false, status: 409, code: "PREFERENCE_IDENTITY_IMMUTABLE", current_revision: currentRevision };
      }
    }

    const revision = currentRevision + 1;
    const history = stores.history;
    const cursor = (history.at(-1)?.cursor ?? 0) + 1;
    const changedAt = new Date(clock()).toISOString();
    // This is a state-sync feed, not an audit log: retain only the latest
    // state/tombstone for each preference so old values are not replayed.
    for (let index = history.length - 1; index >= 0; index -= 1) {
      if (history[index].preference_id === validChange.preference_id) history.splice(index, 1);
    }
    let event;
    if (validChange.operation === "delete") {
      stores.naturalKeys.delete(preferenceKey(existing.preference));
      // Clients that start from an old cursor still receive the delete tombstone.
      for (const [key, replayEntry] of idempotency) {
        if (key !== replayKey && key.startsWith(`${ownerKey(principal, validChange.sharing_scope)}:`)
          && replayEntry.preference_id === validChange.preference_id) {
          idempotency.delete(key);
        }
      }
      stores.records.set(validChange.preference_id, {
        preference_id: validChange.preference_id,
        revision,
        deleted: true,
        deleted_at: changedAt,
      });
      event = {
        cursor,
        preference_id: validChange.preference_id,
        operation: "delete",
        revision,
        changed_at: changedAt,
      };
    } else {
      const preference = validChange.preference;
      stores.naturalKeys.set(preferenceKey(preference), validChange.preference_id);
      stores.records.set(validChange.preference_id, {
        preference_id: validChange.preference_id,
        revision,
        deleted: false,
        preference,
        updated_at: changedAt,
      });
      event = {
        cursor,
        preference_id: validChange.preference_id,
        operation: "upsert",
        revision,
        preference: clone(preference),
        changed_at: changedAt,
      };
    }

    history.push(event);
    const result = {
      applied: true,
      preference_id: validChange.preference_id,
      revision,
      cursor,
    };
    idempotency.set(replayKey, { fingerprint, result, preference_id: validChange.preference_id });
    return clone(result);
  }

  function exportState() {
    return clone({
      schema_version: "0.1",
      recordsByOwner: [...recordsByOwner].map(([key, records]) => [key, [...records]]),
      changesByOwner: [...changesByOwner],
      idempotency: [...idempotency],
      naturalKeysByOwner: [...naturalKeysByOwner].map(([key, values]) => [key, [...values]]),
    });
  }

  return Object.freeze({ applyChange, pull, readCurrentPreferences, exportState });
}
