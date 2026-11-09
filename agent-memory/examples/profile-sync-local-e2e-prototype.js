import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createEncryptedProfileSyncClientCache } from "../src/profile-sync-client-cache-sqlite.js";
import { createSqliteProfileConsentPrototype } from "../src/profile-consent-sqlite-prototype.js";
import { createProfileSyncEngine } from "../src/profile-sync-engine.js";
import { createProfileSyncOutbox } from "../src/profile-sync-outbox.js";
import { buildPreferenceDeleteChange } from "../src/profile-sync-payload.js";
import { createProfileSyncHttpClient } from "../src/profile-sync-http-client.js";
import { createSqliteProfileSyncPrototype } from "../src/profile-sync-sqlite-prototype.js";
import { buildPreferenceMigrationPreview, enqueuePreferenceMigration } from "../src/profile-sync-migration.js";
import { startLocalProfileSyncHttpServer } from "../src/profile-sync-local-http-server.js";

const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "profile-sync-local-e2e-"));
const principalBinding = "synthetic-local-e2e-profile";
const principal = {
  active: true,
  profile_id: "synthetic-profile-owner",
  permissions: ["profile:read", "profile:write"],
  sharing_scopes: ["personal"],
};
const now = "2026-11-07T00:00:00.000Z";
const clock = () => Date.parse(now);
const encryptionKey = randomBytes(32);
let consentLedger;
const syntheticBearerToken = "synthetic-local-e2e-token-not-a-credential";
const memory = {
  memory_id: randomUUID(),
  memory_type: "comfort_temperature_c",
  value: 22.5,
  subject_id: "adult_1",
  scope: {},
  status: "confirmed",
  consent: "explicit",
  updated_at: now,
  expires_at: null,
};
const memories = [memory];
let service;
let server;
let outbox;
let cache;
let profileClient;

const resolveBearerToken = async (token) => token === syntheticBearerToken ? principal : null;
const hasCurrentConsent = (actor, request) => consentLedger.hasCurrentConsent(actor, request);
async function startServer() {
  server = await startLocalProfileSyncHttpServer({
    service,
    consentService: consentLedger,
    resolveBearerToken,
    hasCurrentConsent,
  });
  profileClient = createProfileSyncHttpClient({
    apiBaseUrl: server.apiBaseUrl,
    getBearerToken: async () => syntheticBearerToken,
  });
}

try {
  consentLedger = await createSqliteProfileConsentPrototype({
    databasePath: path.join(temporaryDirectory, "profile-consent.sqlite"),
  });
  service = await createSqliteProfileSyncPrototype({
    databasePath: path.join(temporaryDirectory, "profile-service.sqlite"),
    clock,
  });
  await startServer();
  const postChange = (change) => profileClient.sendChange(change);
  const pullPage = (cursor) => profileClient.pullPage({ sharing_scope: "personal", cursor });
  async function changeConsent({ operation = "grant", permission, purpose, preference_type, expected_revision = 0 }) {
    return profileClient.sendConsentChange({
      schema_version: "0.1",
      change_id: randomUUID(),
      operation,
      permission,
      purpose,
      sharing_scope: "personal",
      ...(preference_type ? { preference_type } : {}),
      expected_revision,
      changed_at: now,
    });
  }

  // The adapter must fail closed for missing identity and missing current
  // consent before the authorized migration is allowed to proceed.
  const deniedChange = buildPreferenceDeleteChange({
    preference_id: randomUUID(),
    change_id: randomUUID(),
    expected_revision: 0,
    sharing_scope: "personal",
    user_requested_delete: true,
    clock,
  });
  const unauthenticatedResponse = await fetch(
    `${server.apiBaseUrl}/v1/preferences/changes?sharing_scope=personal&cursor=0`,
  );
  const unauthenticatedRead = { status: unauthenticatedResponse.status, body: await unauthenticatedResponse.json() };
  assert.equal(unauthenticatedRead.status, 401);
  const consentDeniedWrite = await postChange(deniedChange);
  assert.equal(consentDeniedWrite.status, 403);
  assert.equal(consentDeniedWrite.body.code, "PROFILE_CONSENT_REQUIRED");
  const consentDeniedRead = await pullPage(0).then(
    () => ({ status: 200, body: {} }),
    (error) => ({ status: error.status, body: { code: error.code } }),
  );
  assert.equal(consentDeniedRead.status, 403);
  assert.equal(consentDeniedRead.body.code, "PROFILE_CONSENT_REQUIRED");

  const initialGrants = await Promise.all([
    changeConsent({ permission: "profile:read", purpose: "preference_sync" }),
    changeConsent({ permission: "profile:write", purpose: "preference_sync" }),
    changeConsent({ permission: "profile:read", purpose: "agent_task", preference_type: "comfort_temperature_c" }),
  ]);
  assert.equal(initialGrants.every((result) => result.status === 200 && result.body.active === true), true);
  const revokedWriteConsent = await changeConsent({
    operation: "revoke",
    permission: "profile:write",
    purpose: "preference_sync",
    expected_revision: 1,
  });
  assert.equal(revokedWriteConsent.status, 200);
  const revokedWriteAttempt = await postChange(deniedChange);
  assert.equal(revokedWriteAttempt.status, 403);
  const restoredWriteConsent = await changeConsent({
    permission: "profile:write",
    purpose: "preference_sync",
    expected_revision: 2,
  });
  assert.equal(restoredWriteConsent.status, 200);

  outbox = await createProfileSyncOutbox({
    databasePath: path.join(temporaryDirectory, "client-outbox.sqlite"),
    principalBinding,
    getEncryptionKey: async () => Buffer.from(encryptionKey),
    clock,
  });
  cache = await createEncryptedProfileSyncClientCache({
    databasePath: path.join(temporaryDirectory, "client-cache.sqlite"),
    principalBinding,
    getEncryptionKey: async () => Buffer.from(encryptionKey),
    isConsentCurrent: async ({ principal_binding, sharing_scope, permission, purpose, preference_type }) => principal_binding === principalBinding
      && consentLedger.hasCurrentConsent(principal, { sharing_scope, permission, purpose, preference_type }),
    clock,
  });
  const isConsentCurrent = async ({ principal_binding, sharing_scope, permission, purpose, preference_type }) => principal_binding === principalBinding
    && consentLedger.hasCurrentConsent(principal, { sharing_scope, permission, purpose, preference_type });
  const syncEngine = createProfileSyncEngine({
    outbox,
    client: profileClient,
    cache,
    principalBinding,
    isConsentCurrent,
  });

  const preview = buildPreferenceMigrationPreview({ memories, clock });
  assert.equal(preview.eligible_count, 1);
  const migration = await enqueuePreferenceMigration({
    outbox,
    memories,
    remote_sync_confirmed: true,
    selections: [{
      memory_id: memory.memory_id,
      item_consent_confirmed: true,
      sharing_scope: "personal",
      change_id: randomUUID(),
    }],
    clock,
  });
  assert.equal(migration.queued_count, 1);

  const firstSync = await syncEngine.syncOnce();
  assert.equal(firstSync.status, "complete");
  assert.equal(firstSync.push.acknowledged, 1);
  assert.equal(firstSync.pull[0].status, "complete");
  const taskRead = await profileClient.readCurrentPreferences({
    sharing_scope: "personal",
    memory_type: "comfort_temperature_c",
  });
  assert.equal(taskRead.preferences.length, 1);
  assert.equal(taskRead.preferences[0].preference.memory_type, "comfort_temperature_c");
  const unconsentedCategoryRead = await profileClient.readCurrentPreferences({
    sharing_scope: "personal",
    memory_type: "sleep_time",
  }).then(
    () => ({ status: 200, code: null }),
    (error) => ({ status: error.status, code: error.code }),
  );
  assert.equal(unconsentedCategoryRead.status, 403);
  assert.equal(unconsentedCategoryRead.code, "PROFILE_CONSENT_REQUIRED");
  const firstFeed = await cache.readFeed({
    sharingScope: "personal",
    authenticatedPrincipalBinding: principalBinding,
  });
  assert.equal(firstFeed.records[0].preference.value, 22.5);

  const deleteChange = buildPreferenceDeleteChange({
    preference_id: memory.memory_id,
    change_id: randomUUID(),
    expected_revision: 1,
    sharing_scope: "personal",
    user_requested_delete: true,
    clock,
  });
  await outbox.enqueueChange({ change: deleteChange, consentConfirmed: true });
  const deleteSync = await syncEngine.syncOnce();
  assert.equal(deleteSync.status, "complete");
  assert.equal(deleteSync.push.acknowledged, 1);
  assert.equal(deleteSync.pull[0].status, "complete");
  const finalFeed = await cache.readFeed({
    sharingScope: "personal",
    authenticatedPrincipalBinding: principalBinding,
  });
  assert.equal(finalFeed.records[0].deleted, true);
  assert.equal(Object.hasOwn(finalFeed.records[0], "preference"), false);

  await server.close();
  server = null;
  service.close();
  await consentLedger.close();
  consentLedger = null;
  service = await createSqliteProfileSyncPrototype({
    databasePath: path.join(temporaryDirectory, "profile-service.sqlite"),
    clock,
  });
  consentLedger = await createSqliteProfileConsentPrototype({
    databasePath: path.join(temporaryDirectory, "profile-consent.sqlite"),
  });
  await startServer();
  const restoredPage = await profileClient.pullPage({ sharing_scope: "personal", cursor: 0 });
  assert.equal(restoredPage.changes.some((change) => change.operation === "delete"), true);
  const restoredCurrent = await profileClient.readCurrentPreferences({
    sharing_scope: "personal",
    memory_type: "comfort_temperature_c",
  });
  assert.equal(restoredCurrent.preferences.length, 0);
  assert.equal(await consentLedger.hasCurrentConsent(principal, {
    permission: "profile:read",
    purpose: "preference_sync",
    sharing_scope: "personal",
  }), true);

  console.log(JSON.stringify({
    status: "passed",
    migration_queued_encrypted: true,
    unauthenticated_read_rejected: unauthenticatedRead.status === 401,
    consent_denied_read_and_write_rejected: consentDeniedRead.status === 403 && consentDeniedWrite.status === 403,
    consent_grant_revoke_and_revision_flow: initialGrants.every((result) => result.body.revision === 1)
      && revokedWriteConsent.body.active === false && restoredWriteConsent.body.active === true,
    revoked_write_consent_rejected: revokedWriteAttempt.status === 403,
    task_read_returned_only_consented_category: taskRead.preferences.length === 1
      && taskRead.preferences[0].preference.memory_type === "comfort_temperature_c",
    unconsented_category_read_rejected: unconsentedCategoryRead.status === 403,
    local_service_acknowledged_upsert: firstSync.push.acknowledged === 1,
    client_cache_applied_revision: firstFeed.records[0].revision,
    local_service_acknowledged_delete: deleteSync.push.acknowledged === 1,
    client_cache_applied_tombstone: finalFeed.records[0].deleted,
    sqlite_service_survived_server_restart: restoredPage.changes.some((change) => change.operation === "delete"),
    sqlite_consent_survived_server_restart: await consentLedger.hasCurrentConsent(principal, {
      permission: "profile:read",
      purpose: "preference_sync",
      sharing_scope: "personal",
    }),
    loopback_http_listener_used: server.host === "127.0.0.1",
    profile_http_client_used: true,
    profile_http_adapter_used: true,
    external_network_used: false,
  }, null, 2));
} finally {
  await server?.close();
  cache?.close();
  outbox?.close();
  service?.close();
  await consentLedger?.close();
  encryptionKey.fill(0);
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
