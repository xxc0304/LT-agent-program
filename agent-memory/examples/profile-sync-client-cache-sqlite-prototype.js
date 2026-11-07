import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createEncryptedProfileSyncClientCache } from "../src/profile-sync-client-cache-sqlite.js";

const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "profile-sync-client-cache-"));
const databasePath = path.join(temporaryDirectory, "client-cache.sqlite");
const principalBinding = "synthetic-client-cache-sqlite-principal";
const preferenceId = randomUUID();
const encryptionKey = randomBytes(32);
let consent = true;
let cache;

try {
  cache = await createEncryptedProfileSyncClientCache({
    databasePath,
    principalBinding,
    getEncryptionKey: async () => Buffer.from(encryptionKey),
    isConsentCurrent: async () => consent,
  });

  const summary = await cache.applyPage({
    sharingScope: "personal",
    authenticatedPrincipalBinding: principalBinding,
    page: {
      changes: [{
        cursor: 1,
        preference_id: preferenceId,
        operation: "upsert",
        revision: 1,
        preference: { memory_type: "comfort_temperature_c", value: 22.5, scope: { room_id: "synthetic-room" } },
        changed_at: "2026-11-07T00:00:00.000Z",
      }],
      next_cursor: 1,
      has_more: false,
    },
  });
  assert.equal(summary.applied_count, 1);
  const feed = await cache.readFeed({ sharingScope: "personal", authenticatedPrincipalBinding: principalBinding });
  assert.equal(feed.cursor, 1);
  assert.equal(feed.records[0].preference.value, 22.5);

  const database = new DatabaseSync(databasePath);
  try {
    const row = database.prepare("SELECT ciphertext FROM profile_sync_client_cache WHERE sharing_scope = 'personal'").get();
    assert.ok(row?.ciphertext instanceof Uint8Array);
    const encryptedBytes = Buffer.from(row.ciphertext);
    assert.equal(encryptedBytes.includes(Buffer.from("22.5")), false);
    assert.equal(encryptedBytes.includes(Buffer.from("synthetic-room")), false);
    encryptedBytes.fill(0);
  } finally {
    database.close();
  }

  consent = false;
  await assert.rejects(
    cache.readFeed({ sharingScope: "personal", authenticatedPrincipalBinding: principalBinding }),
    (error) => error.code === "PROFILE_CONSENT_REQUIRED",
  );
  const cleared = cache.clearScopeAfterRevocation({ sharingScope: "personal", revocationConfirmed: true });
  assert.deepEqual(cleared, { cleared: true });

  console.log(JSON.stringify({
    status: "passed",
    encrypted_cache_round_trip: true,
    sqlite_ciphertext_omits_sample_value: true,
    read_blocked_after_consent_revocation: true,
    revoked_scope_cache_cleared: true,
    network_request_sent: false,
  }, null, 2));
} finally {
  cache?.close();
  encryptionKey.fill(0);
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
