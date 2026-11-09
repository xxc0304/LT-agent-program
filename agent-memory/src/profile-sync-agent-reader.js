import { resolveOpenClawProfilePrincipal } from "./profile-identity.js";
import { createProfileSyncHttpClient } from "./profile-sync-http-client.js";

const MEMORY_TYPES = new Set(["comfort_temperature_c", "comfort_brightness_pct", "sleep_time", "wake_time"]);

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/**
 * Build a read-only, personal-scope bridge for an OpenClaw tool factory.
 * Tool arguments can select a supported preference category and narrow its
 * structured scope, but cannot select a profile, household, token, or identity.
 */
export function createOpenClawProfilePreferenceReader({
  toolContext,
  resolveIdentity,
  getBearerToken,
  apiBaseUrl,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof resolveIdentity !== "function" || typeof getBearerToken !== "function") {
    throw new TypeError("Trusted identity and bearer-token providers are required.");
  }

  return Object.freeze({
    async readForTask(params = {}) {
      if (!params || typeof params !== "object" || Array.isArray(params)
        || Object.keys(params).some((key) => !["memory_type", "scope"].includes(key))) {
        throw codedError("INVALID_PROFILE_READ_ARGUMENTS");
      }
      const { memory_type, scope = {} } = params;
      if (!MEMORY_TYPES.has(memory_type) || !scope || typeof scope !== "object" || Array.isArray(scope)) {
        throw codedError("INVALID_PROFILE_READ_ARGUMENTS");
      }

      const principal = await resolveOpenClawProfilePrincipal(toolContext, resolveIdentity);
      const client = createProfileSyncHttpClient({
        apiBaseUrl,
        getBearerToken: () => getBearerToken({
          principal,
          purpose: "agent_task",
          preference_type: memory_type,
          sharing_scope: "personal",
        }),
        fetchImpl,
      });
      const { preferences } = await client.readCurrentPreferences({
        sharing_scope: "personal",
        memory_type,
        scope,
      });

      return {
        memory_type,
        preferences: preferences.map(({ preference, revision }) => ({
          revision,
          value: preference.value,
          ...(preference.scope && Object.keys(preference.scope).length > 0 ? { scope: preference.scope } : {}),
        })),
      };
    },
  });
}
