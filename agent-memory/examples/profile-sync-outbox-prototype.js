import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { createProfileSyncHttpAdapter } from "../src/profile-sync-http-adapter.js";
import { createProfileSyncOutbox } from "../src/profile-sync-outbox.js";
import { createSqliteProfileSyncPrototype } from "../src/profile-sync-sqlite-prototype.js";
import { buildPreferenceUpsertChange } from "../src/profile-sync-payload.js";

// Synthetic-only client/server illustration. The encryption key remains only in
// memory and is reused by this process to simulate a host key-provider callback.
// The temporary databases are removed; no real identity, preference or network
// listener is involved.
const tempRoot = path.resolve(os.tmpdir());
const demoDirectory = await fs.mkdtemp(path.join(tempRoot, "lt-profile-sync-outbox-demo-"));
const relativeDirectory = path.relative(tempRoot, demoDirectory);
if (!relativeDirectory || relativeDirectory === ".." || relativeDirectory.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDirectory)) {
  throw new Error("Refusing an unexpected temporary demo directory.");
}

const profileDatabasePath = path.join(demoDirectory, "profile-sync.sqlite");
const outboxDatabasePath = path.join(demoDirectory, "profile-sync-outbox.sqlite");
const syntheticToken = "synthetic-outbox-demo-token-not-a-credential";
const syntheticPrincipalBinding = "synthetic-profile-outbox-owner-v0";
const encryptionKey = randomBytes(32);
const principal = {
  active: true,
  profile_id: "profile_outbox_demo",
  home_id: "home_outbox_demo",
  permissions: ["profile:read", "profile:write"],
  sharing_scopes: ["personal"],
  can_write_household: false,
};
let now = Date.parse("2026-11-06T12:00:00.000Z");
let consentGranted = true;
let profileService;
let outbox;

try {
  profileService = await createSqliteProfileSyncPrototype({ databasePath: profileDatabasePath, clock: () => now });
  const api = createProfileSyncHttpAdapter({
    service: profileService,
    resolveBearerToken: async (token) => token === syntheticToken ? principal : null,
    hasCurrentConsent: async (actor, { permission, sharing_scope }) => consentGranted
      && actor === principal
      && sharing_scope === "personal"
      && ["profile:read", "profile:write"].includes(permission),
  });
  const consentGate = async ({ sharing_scope }) => consentGranted && sharing_scope === "personal";
  const getEncryptionKey = async () => Buffer.from(encryptionKey);
  const change = buildPreferenceUpsertChange({
    memory: {
      memory_id: "457045ef-bdd0-4caf-bab1-b2baf4697119",
      memory_type: "comfort_temperature_c",
      value: 24,
      scope: { room_id: "outbox-demo-room" },
      status: "confirmed",
      consent: "explicit",
      updated_at: "2026-11-06T11:55:00.000Z",
      expires_at: null,
    },
    change_id: "3de93b82-4102-4617-9b35-5d83c2fa35d1",
    expected_revision: 0,
    sharing_scope: "personal",
    remote_sync_confirmed: true,
  });

  outbox = await createProfileSyncOutbox({ databasePath: outboxDatabasePath, principalBinding: syntheticPrincipalBinding, getEncryptionKey, clock: () => now });
  const queued = await outbox.enqueueChange({ change, consentConfirmed: true });
  const beforeSendSummary = outbox.listSummary();
  outbox.close();
  outbox = null;

  // Reopen the encrypted outbox. First request reaches the synthetic service,
  // but its response is lost to simulate an ambiguous network failure.
  outbox = await createProfileSyncOutbox({ databasePath: outboxDatabasePath, principalBinding: syntheticPrincipalBinding, getEncryptionKey, clock: () => now });
  const firstAttempt = await outbox.dispatchOne({
    isConsentCurrent: consentGate,
    send: async (queuedChange) => {
      const response = await api(new Request("https://local.invalid/v1/preferences/changes", {
        method: "POST",
        headers: { authorization: `Bearer ${syntheticToken}`, "content-type": "application/json" },
        body: JSON.stringify(queuedChange),
      }));
      await response.json();
      throw new Error("synthetic response lost after server commit");
    },
  });
  outbox.close();
  outbox = null;

  // Retry after backoff with the same encrypted payload and change_id. Server
  // idempotency acknowledges the duplicate without incrementing the revision.
  now += 6000;
  outbox = await createProfileSyncOutbox({ databasePath: outboxDatabasePath, principalBinding: syntheticPrincipalBinding, getEncryptionKey, clock: () => now });
  let retryWasDuplicate = false;
  const retryAttempt = await outbox.dispatchOne({
    isConsentCurrent: consentGate,
    send: async (queuedChange) => {
      const response = await api(new Request("https://local.invalid/v1/preferences/changes", {
        method: "POST",
        headers: { authorization: `Bearer ${syntheticToken}`, "content-type": "application/json" },
        body: JSON.stringify(queuedChange),
      }));
      const body = await response.json();
      retryWasDuplicate = body.duplicate === true;
      return { status: response.status, body };
    },
  });
  const acknowledgedSummary = outbox.listSummary();

  const pendingChange = buildPreferenceUpsertChange({
    memory: {
      memory_id: "bcf9c6e5-5a74-45d8-bc7b-e5b727783821",
      memory_type: "comfort_temperature_c",
      value: 23,
      scope: { room_id: "outbox-demo-room" },
      status: "confirmed",
      consent: "explicit",
      updated_at: "2026-11-06T12:01:00.000Z",
      expires_at: null,
    },
    change_id: "454f5282-dc04-48ec-968e-a4476a151bbb",
    expected_revision: 0,
    sharing_scope: "personal",
    remote_sync_confirmed: true,
  });
  await outbox.enqueueChange({ change: pendingChange, consentConfirmed: true });
  consentGranted = false;
  const revoked = outbox.revokePending({ sharing_scope: "personal" });
  const finalSummary = outbox.listSummary();

  console.log(JSON.stringify({
    queued: queued.queued,
    plaintext_value_in_summary: Object.values(beforeSendSummary[0] ?? {}).includes(24),
    first_attempt: firstAttempt.status,
    retry_attempt: retryAttempt.status,
    retry_reused_same_change_id: retryWasDuplicate,
    acknowledged_state: acknowledgedSummary[0]?.state,
    revoked_pending_count: revoked.cancelled_count,
    final_states: finalSummary.map(({ state }) => state),
    encryption_key_saved_to_sqlite: false,
    temporary_databases_removed_after_demo: true,
    network_listener_started: false,
  }, null, 2));
} finally {
  outbox?.close();
  profileService?.close();
  encryptionKey.fill(0);
  await fs.rm(demoDirectory, { recursive: true, force: true });
}
