import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createProfileSyncHttpAdapter } from "../src/profile-sync-http-adapter.js";
import { createSqliteProfileSyncPrototype } from "../src/profile-sync-sqlite-prototype.js";
import { buildPreferenceDeleteChange, buildPreferenceUpsertChange } from "../src/profile-sync-payload.js";

// Synthetic-only durability illustration. The temporary SQLite file is removed
// afterward. No real user data, credentials, external service, or socket is used.
const tempRoot = path.resolve(os.tmpdir());
const demoDirectory = await fs.mkdtemp(path.join(tempRoot, "lt-profile-sync-sqlite-demo-"));
const relativeDirectory = path.relative(tempRoot, demoDirectory);
if (!relativeDirectory || relativeDirectory === ".." || relativeDirectory.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDirectory)) {
  throw new Error("Refusing an unexpected temporary demo directory.");
}

const databasePath = path.join(demoDirectory, "profile-sync.sqlite");
const syntheticToken = "synthetic-sqlite-demo-token-not-a-credential";
const principal = {
  active: true,
  profile_id: "profile_sqlite_demo",
  home_id: "home_sqlite_demo",
  permissions: ["profile:read", "profile:write"],
  sharing_scopes: ["personal"],
  can_write_household: false,
};
let writerService;
let readerService;
let tombstoneService;

try {
  writerService = await createSqliteProfileSyncPrototype({
    databasePath,
    clock: () => Date.parse("2026-11-06T11:00:00.000Z"),
  });
  const writer = createProfileSyncHttpAdapter({
    service: writerService,
    resolveBearerToken: async (token) => token === syntheticToken ? principal : null,
    hasCurrentConsent: async (actor, { permission, sharing_scope }) => actor === principal
      && sharing_scope === "personal"
      && ["profile:read", "profile:write"].includes(permission),
  });
  const change = buildPreferenceUpsertChange({
    memory: {
      memory_id: "457045ef-bdd0-4caf-bab1-b2baf4697119",
      memory_type: "comfort_temperature_c",
      value: 24,
      scope: { room_id: "sqlite-demo-room" },
      status: "confirmed",
      consent: "explicit",
      updated_at: "2026-11-06T10:55:00.000Z",
      expires_at: null,
    },
    change_id: "3de93b82-4102-4617-9b35-5d83c2fa35d1",
    expected_revision: 0,
    sharing_scope: "personal",
    remote_sync_confirmed: true,
  });
  const writeResponse = await writer(new Request("https://local.invalid/v1/preferences/changes", {
    method: "POST",
    headers: { authorization: `Bearer ${syntheticToken}`, "content-type": "application/json" },
    body: JSON.stringify(change),
  }));
  const writeResult = await writeResponse.json();
  writerService.close();
  writerService = null;

  // Reopen the same database as if the service process had restarted.
  readerService = await createSqliteProfileSyncPrototype({
    databasePath,
    clock: () => Date.parse("2026-11-06T11:01:00.000Z"),
  });
  const reader = createProfileSyncHttpAdapter({
    service: readerService,
    resolveBearerToken: async (token) => token === syntheticToken ? principal : null,
    hasCurrentConsent: async (actor, { permission, sharing_scope }) => actor === principal
      && sharing_scope === "personal"
      && permission === "profile:read",
  });
  const pullResponse = await reader(new Request("https://local.invalid/v1/preferences/changes?sharing_scope=personal&cursor=0", {
    headers: { authorization: `Bearer ${syntheticToken}` },
  }));
  const pullResult = await pullResponse.json();

  const writerAfterRestart = createProfileSyncHttpAdapter({
    service: readerService,
    resolveBearerToken: async (token) => token === syntheticToken ? principal : null,
    hasCurrentConsent: async (actor, { permission, sharing_scope }) => actor === principal
      && sharing_scope === "personal"
      && ["profile:read", "profile:write"].includes(permission),
  });
  const retryResponse = await writerAfterRestart(new Request("https://local.invalid/v1/preferences/changes", {
    method: "POST",
    headers: { authorization: `Bearer ${syntheticToken}`, "content-type": "application/json" },
    body: JSON.stringify(change),
  }));
  const retryResult = await retryResponse.json();
  const deleteChange = buildPreferenceDeleteChange({
    preference_id: change.preference_id,
    change_id: "a8d1ba90-9081-4d34-8de1-c4e34fa8c8b8",
    expected_revision: 1,
    sharing_scope: "personal",
    user_requested_delete: true,
    clock: () => Date.parse("2026-11-06T11:02:00.000Z"),
  });
  const deleteResponse = await writerAfterRestart(new Request("https://local.invalid/v1/preferences/changes", {
    method: "POST",
    headers: { authorization: `Bearer ${syntheticToken}`, "content-type": "application/json" },
    body: JSON.stringify(deleteChange),
  }));
  const deleteResult = await deleteResponse.json();
  readerService.close();
  readerService = null;

  tombstoneService = await createSqliteProfileSyncPrototype({
    databasePath,
    clock: () => Date.parse("2026-11-06T11:03:00.000Z"),
  });
  const tombstoneReader = createProfileSyncHttpAdapter({
    service: tombstoneService,
    resolveBearerToken: async (token) => token === syntheticToken ? principal : null,
    hasCurrentConsent: async (actor, { permission, sharing_scope }) => actor === principal
      && sharing_scope === "personal"
      && permission === "profile:read",
  });
  const tombstoneResponse = await tombstoneReader(new Request("https://local.invalid/v1/preferences/changes?sharing_scope=personal&cursor=1", {
    headers: { authorization: `Bearer ${syntheticToken}` },
  }));
  const tombstoneResult = await tombstoneResponse.json();

  console.log(JSON.stringify({
    write_status: writeResponse.status,
    write_revision: writeResult.revision,
    reopened_pull_status: pullResponse.status,
    persisted_change_count: pullResult.changes.length,
    persisted_cursor: pullResult.next_cursor,
    retry_status: retryResponse.status,
    retry_duplicate: retryResult.duplicate === true,
    retry_revision: retryResult.revision,
    delete_status: deleteResponse.status,
    delete_revision: deleteResult.revision,
    reopened_tombstone_status: tombstoneResponse.status,
    tombstone_operation: tombstoneResult.changes[0]?.operation,
    tombstone_cursor: tombstoneResult.next_cursor,
    temporary_database_removed_after_demo: true,
    network_listener_started: false,
    persistence_encryption: "not_provided; synthetic data only",
  }, null, 2));
} finally {
  writerService?.close();
  readerService?.close();
  tombstoneService?.close();
  await fs.rm(demoDirectory, { recursive: true, force: true });
}
