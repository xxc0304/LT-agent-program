import { createProfileSyncHttpAdapter } from "../src/profile-sync-http-adapter.js";
import { createInMemoryProfileSyncPrototype } from "../src/profile-sync-prototype.js";
import { buildPreferenceUpsertChange } from "../src/profile-sync-payload.js";

// Synthetic-only transport demo. It creates no listener and uses no real token,
// account, preference, database, network service, or identity provider.
const service = createInMemoryProfileSyncPrototype({ clock: () => Date.parse("2026-11-06T10:00:00.000Z") });
const syntheticPrincipal = {
  active: true,
  profile_id: "profile_demo_http_owner",
  home_id: "home_demo_http_01",
  permissions: ["profile:read", "profile:write"],
  sharing_scopes: ["personal"],
  can_write_household: false,
};
const syntheticNoConsentPrincipal = {
  ...syntheticPrincipal,
  profile_id: "profile_demo_no_consent",
};
const syntheticBearerToken = "synthetic-demo-token-not-a-credential";
const syntheticNoConsentToken = "synthetic-demo-token-without-consent";

const handle = createProfileSyncHttpAdapter({
  service,
  resolveBearerToken: async (token) => token === syntheticBearerToken
    ? syntheticPrincipal
    : token === syntheticNoConsentToken ? syntheticNoConsentPrincipal : null,
  hasCurrentConsent: async (principal, { permission, sharing_scope }) => principal === syntheticPrincipal
    && sharing_scope === "personal"
    && ["profile:read", "profile:write"].includes(permission),
});

const change = buildPreferenceUpsertChange({
  memory: {
    memory_id: "457045ef-bdd0-4caf-bab1-b2baf4697119",
    memory_type: "comfort_temperature_c",
    value: 24,
    scope: { room_id: "demo-bedroom" },
    status: "confirmed",
    consent: "explicit",
    updated_at: "2026-11-06T09:55:00.000Z",
    expires_at: null,
  },
  change_id: "3de93b82-4102-4617-9b35-5d83c2fa35d1",
  expected_revision: 0,
  sharing_scope: "personal",
  remote_sync_confirmed: true,
});

const writeResponse = await handle(new Request("https://local.invalid/v1/preferences/changes", {
  method: "POST",
  headers: {
    authorization: `Bearer ${syntheticBearerToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(change),
}));
const pullResponse = await handle(new Request("https://local.invalid/v1/preferences/changes?sharing_scope=personal&cursor=0", {
  headers: { authorization: `Bearer ${syntheticBearerToken}` },
}));
const unauthenticatedResponse = await handle(new Request("https://local.invalid/v1/preferences/changes?sharing_scope=personal"));
const noConsentResponse = await handle(new Request("https://local.invalid/v1/preferences/changes?sharing_scope=personal", {
  headers: { authorization: `Bearer ${syntheticNoConsentToken}` },
}));

console.log(JSON.stringify({
  write: { status: writeResponse.status, body: await writeResponse.json() },
  pull: { status: pullResponse.status, body: await pullResponse.json() },
  missing_auth_status: unauthenticatedResponse.status,
  missing_consent_status: noConsentResponse.status,
  network_listener_started: false,
}, null, 2));
