import assert from "node:assert/strict";
import test from "node:test";

import { createOpenClawProfilePreferenceReader } from "../src/profile-sync-agent-reader.js";
import { createInMemoryProfileConsentPrototype } from "../src/profile-consent-prototype.js";
import { createProfileSyncHttpAdapter } from "../src/profile-sync-http-adapter.js";
import { createProfileSyncHttpClient } from "../src/profile-sync-http-client.js";
import { createInMemoryProfileSyncPrototype } from "../src/profile-sync-prototype.js";
import { buildPreferenceUpsertChange } from "../src/profile-sync-payload.js";

const TOKEN_A = "synthetic-profile-sync-test-token-a";
const TOKEN_B = "synthetic-profile-sync-test-token-b";
const PRINCIPAL_A = Object.freeze({
  active: true,
  profile_id: "profile_test_a",
  permissions: ["profile:read", "profile:write"],
  sharing_scopes: ["personal"],
});
const PRINCIPAL_B = Object.freeze({ ...PRINCIPAL_A, profile_id: "profile_test_b" });
const CLOCK = () => Date.parse("2026-11-07T00:00:00.000Z");

function createFixture({ consent = () => true } = {}) {
  const service = createInMemoryProfileSyncPrototype({ clock: CLOCK });
  const tokens = new Map([[TOKEN_A, PRINCIPAL_A], [TOKEN_B, PRINCIPAL_B]]);
  const consentCalls = [];
  const adapter = createProfileSyncHttpAdapter({
    service,
    resolveBearerToken: async (token) => tokens.get(token) ?? null,
    hasCurrentConsent: async (principal, request) => {
      consentCalls.push({ profile_id: principal.profile_id, ...request });
      return consent(principal, request);
    },
  });
  const makeClient = (token = TOKEN_A) => createProfileSyncHttpClient({
    apiBaseUrl: "https://profile.test.invalid",
    getBearerToken: async () => token,
    fetchImpl: adapter,
  });
  return { service, adapter, consentCalls, makeClient };
}

function makeChange({ preferenceId, changeId, memoryType = "comfort_temperature_c", value = 22, roomId = "bedroom" }) {
  const memory = {
    memory_id: preferenceId,
    memory_type: memoryType,
    value,
    scope: memoryType === "comfort_temperature_c"
      ? { room_id: roomId }
      : { time_zone: "Asia/Shanghai" },
    status: "confirmed",
    consent: "explicit",
    updated_at: "2026-11-06T23:55:00.000Z",
    expires_at: null,
  };
  return buildPreferenceUpsertChange({
    memory,
    change_id: changeId,
    expected_revision: 0,
    sharing_scope: "personal",
    remote_sync_confirmed: true,
  });
}

test("task read is category- and scope-limited and sends matching consent purpose", async () => {
  const fixture = createFixture({
    consent: (_principal, request) => request.purpose !== "agent_task"
      || request.preference_type === "comfort_temperature_c",
  });
  fixture.service.applyChange({ principal: PRINCIPAL_A, change: makeChange({
    preferenceId: "457045ef-bdd0-4caf-bab1-b2baf4697119",
    changeId: "3de93b82-4102-4617-9b35-5d83c2fa35d1",
    value: 22,
  }) });
  fixture.service.applyChange({ principal: PRINCIPAL_A, change: makeChange({
    preferenceId: "557045ef-bdd0-4caf-bab1-b2baf4697119",
    changeId: "4de93b82-4102-4617-9b35-5d83c2fa35d1",
    value: 25,
    roomId: "office",
  }) });
  fixture.service.applyChange({ principal: PRINCIPAL_A, change: makeChange({
    preferenceId: "657045ef-bdd0-4caf-bab1-b2baf4697119",
    changeId: "5de93b82-4102-4617-9b35-5d83c2fa35d1",
    memoryType: "sleep_time",
    value: "22:30",
  }) });

  await assert.rejects(
    () => fixture.makeClient().readCurrentPreferences({
      sharing_scope: "personal",
      memory_type: "comfort_temperature_c",
      scope: { room_id: "Bad Room" },
    }),
    (error) => error.status === 400 && error.code === "INVALID_ROOM_ID",
  );
  assert.equal(fixture.consentCalls.length, 0, "invalid scope must be rejected before consent lookup");

  const result = await fixture.makeClient().readCurrentPreferences({
    sharing_scope: "personal",
    memory_type: "comfort_temperature_c",
    scope: { room_id: "bedroom" },
  });
  assert.equal(result.preferences.length, 1);
  assert.equal(result.preferences[0].preference.value, 22);
  assert.equal(result.preferences[0].preference.memory_type, "comfort_temperature_c");
  assert.deepEqual(fixture.consentCalls.at(-1), {
    profile_id: PRINCIPAL_A.profile_id,
    permission: "profile:read",
    sharing_scope: "personal",
    purpose: "agent_task",
    preference_type: "comfort_temperature_c",
    preference_scope: { room_id: "bedroom" },
  });

  await assert.rejects(
    () => fixture.makeClient().readCurrentPreferences({ sharing_scope: "personal", memory_type: "sleep_time" }),
    (error) => error.status === 403 && error.code === "PROFILE_CONSENT_REQUIRED",
  );
});

test("missing identity and revoked sync consent fail closed for reads and writes", async () => {
  let consentGranted = true;
  const fixture = createFixture({ consent: () => consentGranted });
  const unauthenticated = await fixture.adapter(new Request(
    "https://profile.test.invalid/v1/preferences/current?sharing_scope=personal&memory_type=comfort_temperature_c",
  ));
  assert.equal(unauthenticated.status, 401);

  consentGranted = false;
  const deniedRead = await fixture.makeClient().pullPage({ sharing_scope: "personal" }).catch((error) => error);
  assert.equal(deniedRead.status, 403);
  assert.equal(deniedRead.code, "PROFILE_CONSENT_REQUIRED");

  const deniedWrite = await fixture.makeClient().sendChange(makeChange({
    preferenceId: "757045ef-bdd0-4caf-bab1-b2baf4697119",
    changeId: "6de93b82-4102-4617-9b35-5d83c2fa35d1",
  }));
  assert.equal(deniedWrite.status, 403);
  assert.equal(deniedWrite.body.code, "PROFILE_CONSENT_REQUIRED");
  assert.deepEqual(fixture.service.pull({ principal: PRINCIPAL_A, sharing_scope: "personal" }).changes, []);
});

test("a queued consent revocation completes before the next profile write is authorized", async () => {
  let consentGranted = true;
  let signalRevocationEntered;
  let releaseRevocation;
  const revocationEntered = new Promise((resolve) => { signalRevocationEntered = resolve; });
  const revocationGate = new Promise((resolve) => { releaseRevocation = resolve; });
  const profileStore = createInMemoryProfileSyncPrototype({ clock: CLOCK });
  let appliedChanges = 0;
  const service = {
    applyChange: async (args) => {
      appliedChanges += 1;
      return profileStore.applyChange(args);
    },
    pull: (...args) => profileStore.pull(...args),
    readCurrentPreferences: (...args) => profileStore.readCurrentPreferences(...args),
  };
  const tokens = new Map([[TOKEN_A, PRINCIPAL_A]]);
  const adapter = createProfileSyncHttpAdapter({
    service,
    consentService: {
      applyChange: async () => {
        signalRevocationEntered();
        await revocationGate;
        consentGranted = false;
        return { status: 200, applied: true, active: false, revision: 2 };
      },
    },
    resolveBearerToken: async (token) => tokens.get(token) ?? null,
    hasCurrentConsent: async () => consentGranted,
  });
  const post = (route, body) => adapter(new Request(`https://profile.test.invalid${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN_A}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

  const revocationPromise = post("/v1/preferences/consents", { operation: "revoke", sharing_scope: "personal" });
  await revocationEntered;
  const writePromise = post("/v1/preferences/changes", makeChange({
    preferenceId: "957045ef-bdd0-4caf-bab1-b2baf4697119",
    changeId: "8de93b82-4102-4617-9b35-5d83c2fa35d1",
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(appliedChanges, 0, "profile write must wait while the revocation is being committed");

  releaseRevocation();
  const revocationResponse = await revocationPromise;
  const writeResponse = await writePromise;
  assert.equal(revocationResponse.status, 200);
  assert.equal(writeResponse.status, 403);
  assert.equal((await writeResponse.json()).code, "PROFILE_CONSENT_REQUIRED");
  assert.equal(appliedChanges, 0);
});

test("an authorization service outage is returned as unavailable, not missing consent", async () => {
  const principal = {
    ...PRINCIPAL_A,
    home_id: "synthetic-home-a",
    sharing_scopes: ["personal", "household"],
  };
  const ledger = createInMemoryProfileConsentPrototype({
    authorizeScope: async () => { throw new Error("synthetic authorization service outage"); },
  });
  const adapter = createProfileSyncHttpAdapter({
    service: createInMemoryProfileSyncPrototype({ clock: CLOCK }),
    consentService: ledger,
    resolveBearerToken: async (token) => token === TOKEN_A ? principal : null,
    hasCurrentConsent: ledger.hasCurrentConsent,
  });
  const response = await adapter(new Request(
    "https://profile.test.invalid/v1/preferences/changes?sharing_scope=household",
    { headers: { authorization: `Bearer ${TOKEN_A}` } },
  ));

  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "CONSENT_SERVICE_UNAVAILABLE");
});

test("OpenClaw bridge derives identity from trusted context and rejects model identity fields", async () => {
  const fixture = createFixture();
  fixture.service.applyChange({ principal: PRINCIPAL_A, change: makeChange({
    preferenceId: "857045ef-bdd0-4caf-bab1-b2baf4697119",
    changeId: "7de93b82-4102-4617-9b35-5d83c2fa35d1",
    value: 23,
  }) });
  const reader = createOpenClawProfilePreferenceReader({
    toolContext: {
      requesterSenderId: "sender-a",
      deliveryContext: { channel: "test-channel", accountId: "test-account" },
    },
    resolveIdentity: async ({ sender_id }) => sender_id === "sender-a"
      ? { active: true, profile_id: PRINCIPAL_A.profile_id }
      : { active: true, profile_id: PRINCIPAL_B.profile_id },
    getBearerToken: async ({ principal }) => principal.profile_id === PRINCIPAL_A.profile_id ? TOKEN_A : TOKEN_B,
    apiBaseUrl: "https://profile.test.invalid",
    fetchImpl: fixture.adapter,
  });
  const result = await reader.readForTask({ memory_type: "comfort_temperature_c" });
  assert.deepEqual(result, {
    memory_type: "comfort_temperature_c",
    preferences: [{ revision: 1, value: 23, scope: { room_id: "bedroom" } }],
  });

  await assert.rejects(
    () => reader.readForTask({ memory_type: "comfort_temperature_c", subject_id: PRINCIPAL_B.profile_id }),
    (error) => error.code === "INVALID_PROFILE_READ_ARGUMENTS",
  );

  const noContext = createOpenClawProfilePreferenceReader({
    toolContext: {},
    resolveIdentity: async () => null,
    getBearerToken: async () => TOKEN_A,
    apiBaseUrl: "https://profile.test.invalid",
    fetchImpl: fixture.adapter,
  });
  await assert.rejects(
    () => noContext.readForTask({ memory_type: "comfort_temperature_c" }),
    (error) => error.code === "PROFILE_IDENTITY_CONTEXT_REQUIRED",
  );
});

test("HTTP client rejects insecure non-loopback origins and missing bearer tokens", async () => {
  const getBearerToken = async () => TOKEN_A;
  assert.throws(() => createProfileSyncHttpClient({
    apiBaseUrl: "http://profile.example.invalid",
    getBearerToken,
    fetchImpl: async () => new Response("{}"),
  }), TypeError);
  assert.throws(() => createProfileSyncHttpClient({
    apiBaseUrl: "https://user:password@profile.example.invalid",
    getBearerToken,
    fetchImpl: async () => new Response("{}"),
  }), TypeError);

  let transportCalled = false;
  const noTokenClient = createProfileSyncHttpClient({
    apiBaseUrl: "https://profile.test.invalid",
    getBearerToken: async () => null,
    fetchImpl: async () => {
      transportCalled = true;
      return Response.json({ preferences: [] });
    },
  });
  await assert.rejects(
    () => noTokenClient.pullPage({ sharing_scope: "personal" }),
    (error) => error.status === 401 && error.code === "AUTHENTICATION_REQUIRED",
  );
  assert.equal(transportCalled, false);
});
