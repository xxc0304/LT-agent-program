const CHANGES_ROUTE = "/v1/preferences/changes";
const CURRENT_PREFERENCES_ROUTE = "/v1/preferences/current";
const CONSENTS_ROUTE = "/v1/preferences/consents";
const MEMORY_TYPES = new Set(["comfort_temperature_c", "comfort_brightness_pct", "sleep_time", "wake_time"]);
const NUMERIC_MEMORY_TYPES = new Set(["comfort_temperature_c", "comfort_brightness_pct"]);
const MAX_BODY_BYTES = 16 * 1024;

const STATUS_BY_CODE = new Map([
  ["INVALID_CHANGE", 400],
  ["INVALID_PREFERENCE", 400],
  ["INVALID_PREFERENCE_TYPE", 400],
  ["UNSUPPORTED_MEMORY_TYPE", 400],
  ["INVALID_PREFERENCE_SCOPE", 400],
  ["INVALID_ROOM_ID", 400],
  ["INVALID_TEMPERATURE", 400],
  ["INVALID_BRIGHTNESS", 400],
  ["INVALID_LOCAL_TIME", 400],
  ["INVALID_DAY_TYPE", 400],
  ["TIME_ZONE_REQUIRED", 400],
  ["INVALID_TIME_ZONE", 400],
  ["INVALID_SYNC_CURSOR", 400],
  ["INVALID_SHARING_SCOPE", 400],
  ["INVALID_PAGE_SIZE", 400],
  ["UNSUPPORTED_QUERY_PARAMETER", 400],
  ["INVALID_JSON", 400],
  ["PROFILE_ACCESS_DENIED", 403],
  ["PROFILE_SCOPE_DENIED", 403],
  ["HOUSEHOLD_ACCESS_DENIED", 403],
  ["PROFILE_CONSENT_REQUIRED", 403],
  ["PREFERENCE_NOT_FOUND", 404],
  ["IDEMPOTENCY_KEY_REUSED", 409],
  ["REVISION_CONFLICT", 409],
  ["PREFERENCE_EXISTS", 409],
  ["PREFERENCE_IDENTITY_IMMUTABLE", 409],
  ["IDENTITY_PROVIDER_UNAVAILABLE", 503],
  ["CONSENT_SERVICE_UNAVAILABLE", 503],
  ["PROFILE_SERVICE_UNAVAILABLE", 503],
  ["PREFERENCE_RESULT_LIMIT_EXCEEDED", 413],
  ["INVALID_CONSENT_CHANGE", 400],
  ["INVALID_CONSENT_PURPOSE", 400],
  ["CONSENT_NOT_FOUND", 404],
]);

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function jsonResponse(status, payload, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function apiError(status, code) {
  return jsonResponse(status, { code });
}

function parseBearerToken(request) {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)$/i.exec(header);
  if (!match || match[1].length > 8192) return null;
  return match[1];
}

async function readJsonBodyLimited(request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) throw codedError("UNSUPPORTED_MEDIA_TYPE");
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
    throw codedError("REQUEST_TOO_LARGE");
  }
  if (!request.body) throw codedError("INVALID_JSON");

  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  let requestBytes;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      value.fill(0);
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        chunk.fill(0);
        try {
          await reader.cancel();
        } catch {
          // Preserve the body-size error even if stream cancellation fails.
        }
        throw codedError("REQUEST_TOO_LARGE");
      }
      chunks.push(chunk);
    }
    requestBytes = Buffer.concat(chunks);
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(requestBytes));
    } catch {
      throw codedError("INVALID_JSON");
    }
  } finally {
    reader.releaseLock();
    for (const chunk of chunks) chunk.fill(0);
    requestBytes?.fill(0);
  }
}

function readSingleQueryValue(url, name, errorCode) {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) throw codedError(errorCode);
  return values[0];
}

function parseNonNegativeInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw codedError(name === "limit" ? "INVALID_PAGE_SIZE" : "INVALID_SYNC_CURSOR");
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw codedError(name === "limit" ? "INVALID_PAGE_SIZE" : "INVALID_SYNC_CURSOR");
  return number;
}

function validateCurrentPreferenceScope(memoryType, scope) {
  const allowedKeys = NUMERIC_MEMORY_TYPES.has(memoryType)
    ? new Set(["room_id"])
    : new Set(["room_id", "day_type", "time_zone"]);
  if (Object.keys(scope).some((key) => !allowedKeys.has(key))) throw codedError("INVALID_PREFERENCE_SCOPE");
  if (scope.room_id !== undefined
    && (typeof scope.room_id !== "string" || !/^[a-z0-9_-]{1,40}$/.test(scope.room_id))) {
    throw codedError("INVALID_ROOM_ID");
  }
  if (scope.day_type !== undefined && !["weekday", "weekend"].includes(scope.day_type)) {
    throw codedError("INVALID_DAY_TYPE");
  }
  if (scope.time_zone !== undefined) {
    if (typeof scope.time_zone !== "string" || scope.time_zone.length > 80) {
      throw codedError("INVALID_TIME_ZONE");
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: scope.time_zone });
    } catch {
      throw codedError("INVALID_TIME_ZONE");
    }
  }
}

function mapError(error) {
  if (error.code === "UNSUPPORTED_MEDIA_TYPE") return apiError(415, error.code);
  if (error.code === "REQUEST_TOO_LARGE") return apiError(413, error.code);
  if (error.code === "PROFILE_SERVICE_UNAVAILABLE") return apiError(503, error.code);
  const status = STATUS_BY_CODE.get(error.code);
  if (status) return apiError(status, error.code);
  return apiError(503, "PROFILE_SERVICE_UNAVAILABLE");
}

/**
 * Create a Web Request/Response adapter for the local profile-sync prototype.
 * It does not listen on a socket. Identity and current-consent decisions are
 * supplied by trusted host code and are required at construction time.
 */
export function createProfileSyncHttpAdapter({ service, consentService, resolveBearerToken, hasCurrentConsent } = {}) {
  if (!service || typeof service.applyChange !== "function" || typeof service.pull !== "function"
    || typeof service.readCurrentPreferences !== "function") {
    throw new TypeError("A profile sync service with applyChange, pull, and readCurrentPreferences methods is required.");
  }
  if (typeof resolveBearerToken !== "function" || typeof hasCurrentConsent !== "function") {
    throw new TypeError("Trusted identity resolution and current-consent checks are required.");
  }

  // This in-process prototype linearizes consent changes with every operation
  // that reads or writes consent-protected profile data. Production storage
  // must enforce the same rule transactionally across processes and instances.
  let consentSensitiveQueue = Promise.resolve();
  function serializeConsentSensitiveOperation(operation) {
    const result = consentSensitiveQueue.then(operation, operation);
    consentSensitiveQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function requireCurrentConsent(principal, request) {
    let consentGranted;
    try {
      consentGranted = await hasCurrentConsent(principal, request);
    } catch {
      throw codedError("CONSENT_SERVICE_UNAVAILABLE");
    }
    if (consentGranted !== true) throw codedError("PROFILE_CONSENT_REQUIRED");
  }

  return async function handleProfileSyncRequest(request) {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return apiError(400, "INVALID_REQUEST_URL");
    }

    if (url.pathname !== CHANGES_ROUTE && url.pathname !== CURRENT_PREFERENCES_ROUTE && url.pathname !== CONSENTS_ROUTE) {
      return apiError(404, "API_ROUTE_NOT_FOUND");
    }
    if (url.pathname === CONSENTS_ROUTE && request.method !== "POST") {
      return jsonResponse(405, { code: "METHOD_NOT_ALLOWED" }, { allow: "POST" });
    }
    if (url.pathname === CURRENT_PREFERENCES_ROUTE && request.method !== "GET") {
      return jsonResponse(405, { code: "METHOD_NOT_ALLOWED" }, { allow: "GET" });
    }
    if (url.pathname === CHANGES_ROUTE && request.method !== "GET" && request.method !== "POST") {
      return jsonResponse(405, { code: "METHOD_NOT_ALLOWED" }, { allow: "GET, POST" });
    }

    const token = parseBearerToken(request);
    if (!token) return apiError(401, "AUTHENTICATION_REQUIRED");

    let principal;
    try {
      principal = await resolveBearerToken(token);
    } catch {
      return apiError(503, "IDENTITY_PROVIDER_UNAVAILABLE");
    }
    if (!principal || principal.active !== true) return apiError(401, "AUTHENTICATION_FAILED");

    try {
      if (url.pathname === CONSENTS_ROUTE) {
        if (!consentService || typeof consentService.applyChange !== "function") {
          throw codedError("CONSENT_SERVICE_UNAVAILABLE");
        }
        const change = await readJsonBodyLimited(request);
        const result = await serializeConsentSensitiveOperation(
          () => consentService.applyChange({ principal, change }),
        );
        const status = result.status ?? 200;
        const { status: ignoredStatus, ...body } = result;
        return jsonResponse(status, body);
      }

      if (url.pathname === CURRENT_PREFERENCES_ROUTE) {
        const allowedQuery = new Set(["sharing_scope", "memory_type", "room_id", "day_type", "time_zone"]);
        if ([...url.searchParams.keys()].some((key) => !allowedQuery.has(key))) {
          throw codedError("UNSUPPORTED_QUERY_PARAMETER");
        }
        const sharingScope = readSingleQueryValue(url, "sharing_scope", "INVALID_SHARING_SCOPE");
        const memoryType = readSingleQueryValue(url, "memory_type", "INVALID_PREFERENCE_TYPE");
        const roomId = readSingleQueryValue(url, "room_id", "INVALID_ROOM_ID");
        const dayType = readSingleQueryValue(url, "day_type", "INVALID_DAY_TYPE");
        const timeZone = readSingleQueryValue(url, "time_zone", "INVALID_TIME_ZONE");
        if (!sharingScope || !["personal", "household"].includes(sharingScope)) {
          throw codedError("INVALID_SHARING_SCOPE");
        }
        if (!MEMORY_TYPES.has(memoryType)) throw codedError("INVALID_PREFERENCE_TYPE");
        const scope = Object.fromEntries(Object.entries({
          room_id: roomId,
          day_type: dayType,
          time_zone: timeZone,
        }).filter(([, value]) => value !== undefined));
        validateCurrentPreferenceScope(memoryType, scope);
        const result = await serializeConsentSensitiveOperation(async () => {
          await requireCurrentConsent(principal, {
            permission: "profile:read",
            sharing_scope: sharingScope,
            purpose: "agent_task",
            preference_type: memoryType,
            preference_scope: scope,
          });
          return service.readCurrentPreferences({
            principal,
            sharing_scope: sharingScope,
            memory_type: memoryType,
            scope,
          });
        });
        return jsonResponse(200, result);
      }

      if (request.method === "POST") {
        const change = await readJsonBodyLimited(request);
        const sharingScope = change?.sharing_scope;
        const result = await serializeConsentSensitiveOperation(async () => {
          await requireCurrentConsent(principal, {
            permission: "profile:write",
            sharing_scope: sharingScope,
            purpose: "preference_sync",
          });
          return service.applyChange({ principal, change });
        });
        const status = result.status ?? 200;
        const { status: ignoredStatus, ...body } = result;
        return jsonResponse(status, body);
      }

      if ([...url.searchParams.keys()].some((key) => !["sharing_scope", "cursor", "limit"].includes(key))) {
        throw codedError("UNSUPPORTED_QUERY_PARAMETER");
      }
      const sharingScope = readSingleQueryValue(url, "sharing_scope", "INVALID_SHARING_SCOPE");
      const rawCursor = readSingleQueryValue(url, "cursor", "INVALID_SYNC_CURSOR");
      const rawLimit = readSingleQueryValue(url, "limit", "INVALID_PAGE_SIZE");
      if (!sharingScope || !["personal", "household"].includes(sharingScope)) {
        throw codedError("INVALID_SHARING_SCOPE");
      }
      const page = await serializeConsentSensitiveOperation(async () => {
        await requireCurrentConsent(principal, {
          permission: "profile:read",
          sharing_scope: sharingScope,
          purpose: "preference_sync",
        });
        const cursor = parseNonNegativeInteger(rawCursor, 0, "cursor");
        const limit = parseNonNegativeInteger(rawLimit, 50, "limit");
        if (limit < 1 || limit > 100) throw codedError("INVALID_PAGE_SIZE");
        return service.pull({
          principal,
          sharing_scope: sharingScope,
          cursor,
          limit,
        });
      });
      return jsonResponse(200, page);
    } catch (error) {
      return mapError(error);
    }
  };
}
