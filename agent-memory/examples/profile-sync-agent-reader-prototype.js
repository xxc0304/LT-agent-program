import assert from "node:assert/strict";

import { createOpenClawProfilePreferenceReader } from "../src/profile-sync-agent-reader.js";
import { createProfileSyncHttpAdapter } from "../src/profile-sync-http-adapter.js";
import { createInMemoryProfileSyncPrototype } from "../src/profile-sync-prototype.js";
import { buildPreferenceUpsertChange } from "../src/profile-sync-payload.js";

// Synthetic-only OpenClaw bridge demo. It uses no installed plugin, real
// identity, user token, profile service, listener, or network connection.
const principalA = {
  active: true,
  profile_id: "profile_agent_reader_a",
  permissions: ["profile:read", "profile:write"],
  sharing_scopes: ["personal"],
};
const principalB = {
  ...principalA,
  profile_id: "profile_agent_reader_b",
};
const tokenToPrincipal = new Map([
  ["synthetic-agent-reader-token-a", principalA],
  ["synthetic-agent-reader-token-b", principalB],
]);
const service = createInMemoryProfileSyncPrototype({ clock: () => Date.parse("2026-11-07T00:00:00.000Z") });

function seedPreference(principal, memory, preferenceId) {
  const change = buildPreferenceUpsertChange({
    memory: {
      memory_id: preferenceId,
      status: "confirmed",
      consent: "explicit",
      updated_at: "2026-11-06T23:55:00.000Z",
      expires_at: null,
      ...memory,
    },
    change_id: `${preferenceId.slice(0, 8)}-0000-4000-8000-000000000001`,
    expected_revision: 0,
    sharing_scope: "personal",
    remote_sync_confirmed: true,
  });
  const result = service.applyChange({ principal, change });
  assert.equal(result.applied, true);
}

seedPreference(principalA, {
  memory_type: "comfort_temperature_c",
  value: 22.5,
  scope: { room_id: "bedroom" },
}, "457045ef-bdd0-4caf-bab1-b2baf4697119");
seedPreference(principalA, {
  memory_type: "sleep_time",
  value: "22:30",
  scope: { time_zone: "Asia/Shanghai" },
}, "557045ef-bdd0-4caf-bab1-b2baf4697119");
seedPreference(principalB, {
  memory_type: "comfort_temperature_c",
  value: 26.5,
  scope: { room_id: "bedroom" },
}, "657045ef-bdd0-4caf-bab1-b2baf4697119");

const handle = createProfileSyncHttpAdapter({
  service,
  resolveBearerToken: async (token) => tokenToPrincipal.get(token) ?? null,
  hasCurrentConsent: async (principal, { permission, sharing_scope, purpose, preference_type }) => {
    if (permission !== "profile:read" || sharing_scope !== "personal") return false;
    if (purpose === "agent_task") {
      return principal.profile_id === principalA.profile_id && preference_type === "comfort_temperature_c";
    }
    return true;
  },
});

function makeReader(senderId) {
  return createOpenClawProfilePreferenceReader({
    toolContext: {
      requesterSenderId: senderId,
      deliveryContext: { channel: "synthetic-channel", accountId: "synthetic-account" },
    },
    resolveIdentity: async ({ sender_id }) => sender_id === "sender-a"
      ? { active: true, profile_id: principalA.profile_id }
      : sender_id === "sender-b" ? { active: true, profile_id: principalB.profile_id } : null,
    getBearerToken: async ({ principal }) => principal.profile_id === principalA.profile_id
      ? "synthetic-agent-reader-token-a"
      : "synthetic-agent-reader-token-b",
    apiBaseUrl: "https://local.invalid",
    fetchImpl: handle,
  });
}

const readerA = makeReader("sender-a");
const resultA = await readerA.readForTask({
  memory_type: "comfort_temperature_c",
  scope: { room_id: "bedroom" },
});
assert.equal(resultA.preferences.length, 1);
assert.equal(resultA.preferences[0].value, 22.5);
assert.equal(Object.hasOwn(resultA.preferences[0], "preference_id"), false);
assert.equal(JSON.stringify(resultA).includes(principalA.profile_id), false);
assert.equal(JSON.stringify(resultA).includes(principalB.profile_id), false);

await assert.rejects(
  () => readerA.readForTask({ memory_type: "sleep_time" }),
  (error) => error.status === 403 && error.code === "PROFILE_CONSENT_REQUIRED",
);
await assert.rejects(
  () => readerA.readForTask({ memory_type: "comfort_temperature_c", subject_id: principalB.profile_id }),
  (error) => error.code === "INVALID_PROFILE_READ_ARGUMENTS",
);

const readerWithoutContext = createOpenClawProfilePreferenceReader({
  toolContext: {},
  resolveIdentity: async () => null,
  getBearerToken: async () => "synthetic-agent-reader-token-a",
  apiBaseUrl: "https://local.invalid",
  fetchImpl: handle,
});
await assert.rejects(
  () => readerWithoutContext.readForTask({ memory_type: "comfort_temperature_c" }),
  (error) => error.code === "PROFILE_IDENTITY_CONTEXT_REQUIRED",
);

console.log(JSON.stringify({
  status: "passed",
  trusted_openclaw_sender_mapped_to_profile: true,
  task_read_limited_to_requested_category_and_scope: resultA.preferences.length === 1,
  unrelated_profile_data_exposed: false,
  model_supplied_identity_accepted: false,
  missing_runtime_identity_rejected: true,
  unconsented_category_rejected: true,
  network_listener_started: false,
}, null, 2));
