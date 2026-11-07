import { validateProfileSyncChange } from "./profile-sync-prototype.js";

const CHANGES_ROUTE = "/v1/preferences/changes";
const CURRENT_PREFERENCES_ROUTE = "/v1/preferences/current";
const CONSENTS_ROUTE = "/v1/preferences/consents";
const MAX_RESPONSE_BYTES = 512 * 1024;
const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9\-._~+/]+=*$/;
const MEMORY_TYPES = new Set(["comfort_temperature_c", "comfort_brightness_pct", "sleep_time", "wake_time"]);
const NUMERIC_MEMORY_TYPES = new Set(["comfort_temperature_c", "comfort_brightness_pct"]);
const PREFERENCE_VALIDATION_CHANGE_ID = "00000000-0000-4000-8000-000000000000";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function codedError(code, status) {
  const error = new Error(code);
  error.code = code;
  if (Number.isInteger(status)) error.status = status;
  return error;
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("A valid Profile API base URL is required.");
  }
  const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback))
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new TypeError("The Profile API URL must be an HTTPS origin (HTTP is allowed only for loopback). No path, credentials, query, or fragment is accepted.");
  }
  return url.origin;
}

async function readJsonLimited(response) {
  const contentType = response.headers?.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType) || !response.body) {
    throw codedError("PROFILE_API_INVALID_RESPONSE", response.status);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  let responseBytes;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      value.fill(0);
      length += chunk.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        chunk.fill(0);
        try {
          await reader.cancel();
        } catch {
          // Preserve the response-size error even if stream cancellation fails.
        }
        throw codedError("PROFILE_API_RESPONSE_TOO_LARGE", response.status);
      }
      chunks.push(chunk);
    }
    responseBytes = Buffer.concat(chunks);
    try {
      const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBytes));
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("Expected a JSON object.");
      }
      return body;
    } catch {
      throw codedError("PROFILE_API_INVALID_RESPONSE", response.status);
    }
  } catch (error) {
    if (error?.code === "PROFILE_API_RESPONSE_TOO_LARGE"
      || error?.code === "PROFILE_API_INVALID_RESPONSE") throw error;
    throw codedError("PROFILE_API_UNAVAILABLE", response.status);
  } finally {
    reader.releaseLock();
    for (const chunk of chunks) chunk.fill(0);
    responseBytes?.fill(0);
  }
}

/**
 * Small authenticated client for the Profile changes endpoint. The host owns
 * identity/token acquisition and supplies a fetch-compatible transport. Tokens
 * are fetched for each request, held only in memory, and never logged or saved.
 */
export function createProfileSyncHttpClient({ apiBaseUrl, getBearerToken, fetchImpl = globalThis.fetch } = {}) {
  if (typeof getBearerToken !== "function") {
    throw new TypeError("A host-provided bearer-token callback is required.");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch-compatible transport is required.");
  const origin = normalizeBaseUrl(apiBaseUrl);

  async function request(method, { route = CHANGES_ROUTE, query, body } = {}) {
    let token;
    try {
      token = await getBearerToken();
    } catch {
      throw codedError("IDENTITY_PROVIDER_UNAVAILABLE", 503);
    }
    if (typeof token !== "string" || token.length < 1 || token.length > 8192 || !BEARER_TOKEN_PATTERN.test(token)) {
      throw codedError("AUTHENTICATION_REQUIRED", 401);
    }

    const url = new URL(route, origin);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, String(value));
    const headers = new Headers({ authorization: `Bearer ${token}`, accept: "application/json" });
    let requestBody;
    if (body !== undefined) {
      headers.set("content-type", "application/json");
      requestBody = JSON.stringify(body);
    }
    const outboundRequest = new Request(url, {
      method,
      headers,
      ...(requestBody === undefined ? {} : { body: requestBody }),
      cache: "no-store",
      redirect: "error",
    });

    let response;
    try {
      response = await fetchImpl(outboundRequest);
    } catch {
      throw codedError("PROFILE_API_UNAVAILABLE", 503);
    }
    if (!response || !Number.isInteger(response.status) || !response.headers || !response.body) {
      throw codedError("PROFILE_API_INVALID_RESPONSE", 502);
    }
    return { status: response.status, body: await readJsonLimited(response) };
  }

  return Object.freeze({
    async sendChange(change) {
      if (!change || typeof change !== "object" || Array.isArray(change)) {
        throw codedError("INVALID_CHANGE", 400);
      }
      return request("POST", { body: change });
    },
    async sendConsentChange(change) {
      if (!change || typeof change !== "object" || Array.isArray(change)) {
        throw codedError("INVALID_CONSENT_CHANGE", 400);
      }
      return request("POST", { route: CONSENTS_ROUTE, body: change });
    },
    async pullPage({ sharing_scope, cursor = 0, limit = 50 } = {}) {
      if (!["personal", "household"].includes(sharing_scope)
        || !Number.isSafeInteger(cursor) || cursor < 0
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw codedError("INVALID_SYNC_QUERY", 400);
      }
      const result = await request("GET", { query: { sharing_scope, cursor, limit } });
      if (result.status < 200 || result.status >= 300) {
        const code = typeof result.body.code === "string" && /^[A-Z0-9_]{1,64}$/.test(result.body.code)
          ? result.body.code
          : "PROFILE_API_REJECTED";
        throw codedError(code, result.status);
      }
      const page = result.body;
      if (Object.keys(page).sort().join("\0") !== ["changes", "has_more", "next_cursor"].sort().join("\0")
        || !Array.isArray(page.changes)
        || !Number.isSafeInteger(page.next_cursor) || page.next_cursor < 0
        || typeof page.has_more !== "boolean") {
        throw codedError("PROFILE_API_INVALID_RESPONSE", result.status);
      }
      return page;
    },
    async readCurrentPreferences({ sharing_scope, memory_type, scope = {} } = {}) {
      if (!["personal", "household"].includes(sharing_scope) || !MEMORY_TYPES.has(memory_type)
        || !scope || typeof scope !== "object" || Array.isArray(scope)) {
        throw codedError("INVALID_PREFERENCE_QUERY", 400);
      }
      const allowedScopeKeys = NUMERIC_MEMORY_TYPES.has(memory_type)
        ? ["room_id"]
        : ["room_id", "day_type", "time_zone"];
      if (Object.keys(scope).some((key) => !allowedScopeKeys.includes(key))) {
        throw codedError("INVALID_PREFERENCE_QUERY", 400);
      }
      const result = await request("GET", {
        route: CURRENT_PREFERENCES_ROUTE,
        query: { sharing_scope, memory_type, ...scope },
      });
      if (result.status < 200 || result.status >= 300) {
        const code = typeof result.body.code === "string" && /^[A-Z0-9_]{1,64}$/.test(result.body.code)
          ? result.body.code
          : "PROFILE_API_REJECTED";
        throw codedError(code, result.status);
      }
      if (Object.keys(result.body).join("\0") !== "preferences"
        || !Array.isArray(result.body.preferences) || result.body.preferences.length > 100) {
        throw codedError("PROFILE_API_INVALID_RESPONSE", result.status);
      }
      const preferences = result.body.preferences.map((record) => {
        if (!record || typeof record !== "object" || Array.isArray(record)
          || Object.keys(record).sort().join("\0") !== ["preference_id", "revision", "preference", "changed_at"].sort().join("\0")
          || !UUID_PATTERN.test(record.preference_id ?? "")
          || !Number.isSafeInteger(record.revision) || record.revision < 1
          || typeof record.changed_at !== "string" || !Number.isFinite(Date.parse(record.changed_at))
          || record.preference?.memory_type !== memory_type) {
          throw codedError("PROFILE_API_INVALID_RESPONSE", result.status);
        }
        let validated;
        try {
          validated = validateProfileSyncChange({
            schema_version: "0.1",
            change_id: PREFERENCE_VALIDATION_CHANGE_ID,
            preference_id: record.preference_id,
            operation: "upsert",
            sharing_scope,
            expected_revision: record.revision - 1,
            changed_at: record.changed_at,
            preference: record.preference,
          });
        } catch {
          throw codedError("PROFILE_API_INVALID_RESPONSE", result.status);
        }
        if (!Object.entries(scope).every(([scopeKey, value]) => validated.preference.scope?.[scopeKey] === value)) {
          throw codedError("PROFILE_API_INVALID_RESPONSE", result.status);
        }
        return {
          preference_id: validated.preference_id,
          revision: record.revision,
          preference: validated.preference,
          changed_at: validated.changed_at,
        };
      });
      return { preferences };
    },
  });
}
