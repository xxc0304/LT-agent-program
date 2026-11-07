const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEMORY_TYPES = new Set(["comfort_temperature_c", "comfort_brightness_pct", "sleep_time", "wake_time"]);
const NUMERIC_MEMORY_TYPES = new Set(["comfort_temperature_c", "comfort_brightness_pct"]);
const SHARING_SCOPES = new Set(["personal", "household"]);
const ISO_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateEnvelope({ change_id, preference_id, expected_revision, sharing_scope } = {}) {
  if (!UUID_PATTERN.test(change_id ?? "")) {
    throw codedError("INVALID_CHANGE_ID", "每次用户确认的变更必须有稳定 UUID，以便安全重试。");
  }
  if (!UUID_PATTERN.test(preference_id ?? "")) {
    throw codedError("INVALID_PREFERENCE_ID", "偏好记录需要有效的 UUID。");
  }
  if (!Number.isSafeInteger(expected_revision) || expected_revision < 0) {
    throw codedError("INVALID_EXPECTED_REVISION", "expected_revision 必须是非负整数。");
  }
  if (!SHARING_SCOPES.has(sharing_scope)) {
    throw codedError("SHARING_SCOPE_REQUIRED", "必须明确选择 personal 或 household 范围。");
  }
}

function parseLocalPreferenceForSync(memory, clock) {
  if (!memory || typeof memory !== "object" || memory.status !== "confirmed") {
    throw codedError("CONFIRMED_PREFERENCE_REQUIRED", "只有已确认的偏好可以生成同步请求。");
  }
  if (!["explicit", "user_confirmed"].includes(memory.consent)) {
    throw codedError("PREFERENCE_CONSENT_INVALID", "该记录不具备有效的用户确认来源。");
  }
  if (!UUID_PATTERN.test(memory.memory_id ?? "")) {
    throw codedError("INVALID_PREFERENCE_ID", "偏好记录需要有效的 UUID。");
  }
  if (memory.expires_at !== undefined && memory.expires_at !== null) {
    const expiry = Date.parse(memory.expires_at);
    if (!Number.isFinite(expiry)) throw codedError("PREFERENCE_EXPIRY_INVALID", "偏好过期时间无效。");
    if (expiry <= clock()) throw codedError("PREFERENCE_EXPIRED", "过期偏好不能同步。");
  }
  if (typeof memory.updated_at !== "string"
    || !ISO_DATETIME_PATTERN.test(memory.updated_at)
    || !Number.isFinite(Date.parse(memory.updated_at))) {
    throw codedError("PREFERENCE_TIMESTAMP_INVALID", "偏好缺少有效的最后更新时间。");
  }

  const sourceScope = memory.scope ?? {};
  if (!sourceScope || typeof sourceScope !== "object" || Array.isArray(sourceScope)) {
    throw codedError("INVALID_PREFERENCE_SCOPE", "偏好范围格式无效。");
  }
  const allowedScopeKeys = NUMERIC_MEMORY_TYPES.has(memory.memory_type)
    ? ["room_id"]
    : ["room_id", "day_type", "time_zone"];
  if (Object.keys(sourceScope).some((key) => !allowedScopeKeys.includes(key))) {
    throw codedError("INVALID_PREFERENCE_SCOPE", "偏好范围包含不允许同步的字段。");
  }
  const scope = Object.fromEntries(allowedScopeKeys
    .filter((key) => sourceScope[key] !== undefined)
    .map((key) => [key, sourceScope[key]]));
  if (scope.room_id !== undefined
    && (typeof scope.room_id !== "string" || !/^[a-z0-9_-]{1,40}$/.test(scope.room_id))) {
    throw codedError("INVALID_ROOM_ID", "room_id 格式无效。");
  }
  const preference = {
    memory_type: memory.memory_type,
    value: memory.value,
    ...(Object.keys(scope).length > 0 ? { scope } : {}),
  };
  if (!MEMORY_TYPES.has(preference.memory_type)) {
    throw codedError("UNSUPPORTED_MEMORY_TYPE", "该偏好类型不在同步白名单中。");
  }
  if (preference.memory_type === "comfort_temperature_c"
    && (typeof preference.value !== "number" || !Number.isFinite(preference.value)
      || preference.value < 16 || preference.value > 30)) {
    throw codedError("INVALID_TEMPERATURE", "舒适温度必须处于 16–30℃ 范围。");
  }

  if (preference.memory_type === "comfort_brightness_pct"
    && (typeof preference.value !== "number" || !Number.isFinite(preference.value)
      || preference.value < 1 || preference.value > 100)) {
    throw codedError("INVALID_BRIGHTNESS", "舒适亮度必须处于 1–100% 范围。");
  }
  if (["sleep_time", "wake_time"].includes(preference.memory_type)
    && (typeof preference.value !== "string"
      || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(preference.value)
      || typeof preference.scope?.time_zone !== "string")) {
    throw codedError("INVALID_ROUTINE_PREFERENCE", "作息偏好必须包含 HH:mm 值和 IANA 时区。");
  }
  if (preference.scope?.day_type !== undefined
    && !["weekday", "weekend"].includes(preference.scope.day_type)) {
    throw codedError("INVALID_DAY_TYPE", "day_type 必须为 weekday 或 weekend。");
  }
  if (preference.scope?.time_zone !== undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: preference.scope.time_zone });
    } catch {
      throw codedError("INVALID_TIME_ZONE", "time_zone 不是有效的 IANA 时区。");
    }
  }

  return {
    preference_id: memory.memory_id,
    memory_type: memory.memory_type,
    changed_at: memory.updated_at,
    preference,
  };
}

/**
 * Validate one local record without producing its value or claiming sync consent.
 * The returned metadata is safe for a migration preview; it omits value, scope,
 * subject, evidence, and provenance.
 */
export function inspectLocalPreferenceForSync(memory, { clock = () => Date.now() } = {}) {
  const validated = parseLocalPreferenceForSync(memory, clock);
  return {
    preference_id: validated.preference_id,
    memory_type: validated.memory_type,
    changed_at: validated.changed_at,
  };
}

/**
 * Convert one local confirmed memory into a sync request, only after explicit
 * remote-sync consent. `remote_sync_confirmed` must come from a trusted user
 * confirmation flow and must never be exposed as a model-controlled argument.
 * This helper does not persist a consent record. Identity, evidence,
 * observation, and local provenance fields are intentionally omitted.
 */
export function buildPreferenceUpsertChange({
  memory,
  change_id,
  expected_revision,
  sharing_scope,
  remote_sync_confirmed = false,
  clock = () => Date.now(),
} = {}) {
  if (remote_sync_confirmed !== true) {
    throw codedError("REMOTE_SYNC_CONSENT_REQUIRED", "上传偏好前必须获得用户对跨端同步的明确同意。");
  }
  const validated = parseLocalPreferenceForSync(memory, clock);
  validateEnvelope({
    change_id,
    preference_id: validated.preference_id,
    expected_revision,
    sharing_scope,
  });
  return {
    schema_version: "0.1",
    change_id,
    preference_id: validated.preference_id,
    operation: "upsert",
    sharing_scope,
    expected_revision,
    changed_at: validated.changed_at,
    preference: validated.preference,
  };
}

/** Build a tombstone request after an explicit user deletion. */
export function buildPreferenceDeleteChange({
  preference_id,
  change_id,
  expected_revision,
  sharing_scope,
  user_requested_delete = false,
  clock = () => Date.now(),
} = {}) {
  if (user_requested_delete !== true) {
    throw codedError("USER_DELETE_REQUIRED", "只能在用户明确删除该偏好后生成删除同步请求。");
  }
  validateEnvelope({ change_id, preference_id, expected_revision, sharing_scope });
  return {
    schema_version: "0.1",
    change_id,
    preference_id,
    operation: "delete",
    sharing_scope,
    expected_revision,
    changed_at: new Date(clock()).toISOString(),
  };
}
