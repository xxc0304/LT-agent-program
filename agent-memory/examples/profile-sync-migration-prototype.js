import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createProfileSyncOutbox } from "../src/profile-sync-outbox.js";
import {
  buildPreferenceMigrationPreview,
  enqueuePreferenceMigration,
} from "../src/profile-sync-migration.js";

const now = "2026-11-07T00:00:00.000Z";
const clock = () => Date.parse(now);
const memories = [
  {
    memory_id: randomUUID(),
    memory_type: "comfort_temperature_c",
    value: 22.5,
    unit: "°C",
    subject_id: "adult_1",
    scope: { room_id: "bedroom" },
    status: "confirmed",
    consent: "explicit",
    updated_at: now,
    expires_at: null,
    evidence_event_ids: ["synthetic-event"],
  },
  {
    memory_id: randomUUID(),
    memory_type: "wake_time",
    value: "07:00",
    subject_id: "adult_1",
    scope: { time_zone: "Asia/Shanghai" },
    status: "confirmed",
    consent: "user_confirmed",
    updated_at: now,
    expires_at: null,
  },
  {
    memory_id: randomUUID(),
    memory_type: "sleep_time",
    value: "23:00",
    subject_id: "adult_1",
    scope: { time_zone: "Asia/Shanghai" },
    status: "pending_confirmation",
    updated_at: now,
    expires_at: null,
  },
];
const originalMemories = structuredClone(memories);
const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "profile-sync-migration-"));
const encryptionKey = randomBytes(32);
let outbox;

try {
  const preview = buildPreferenceMigrationPreview({ memories, clock });
  assert.equal(preview.total_count, 3);
  assert.equal(preview.eligible_count, 2);
  assert.equal(preview.excluded_count, 1);
  const previewText = JSON.stringify(preview);
  for (const privateField of ["22.5", "bedroom", "adult_1", "evidence_event_ids"]) {
    assert.equal(previewText.includes(privateField), false);
  }

  const databasePath = path.join(temporaryDirectory, "outbox.sqlite");
  outbox = await createProfileSyncOutbox({
    databasePath,
    principalBinding: "synthetic-profile-migration-principal",
    getEncryptionKey: async () => Buffer.from(encryptionKey),
    clock,
  });
  const selections = memories.slice(0, 2).map((memory) => ({
    memory_id: memory.memory_id,
    item_consent_confirmed: true,
    sharing_scope: "personal",
    change_id: randomUUID(),
  }));
  const rollbackProbe = new DatabaseSync(databasePath);
  try {
    rollbackProbe.exec(`
      CREATE TRIGGER fail_second_migration_insert
      BEFORE INSERT ON profile_sync_outbox
      WHEN NEW.preference_id = '${memories[1].memory_id}'
      BEGIN SELECT RAISE(ABORT, 'synthetic atomicity probe'); END;
    `);
    await assert.rejects(enqueuePreferenceMigration({
      outbox,
      memories,
      selections,
      remote_sync_confirmed: true,
      clock,
    }));
    assert.equal(outbox.listSummary().length, 0);
  } finally {
    rollbackProbe.exec("DROP TRIGGER IF EXISTS fail_second_migration_insert;");
    rollbackProbe.close();
  }

  const firstReceipt = await enqueuePreferenceMigration({
    outbox,
    memories,
    selections,
    remote_sync_confirmed: true,
    clock,
  });
  const retryReceipt = await enqueuePreferenceMigration({
    outbox,
    memories,
    selections,
    remote_sync_confirmed: true,
    clock,
  });

  assert.deepEqual(firstReceipt, {
    queued_count: 2,
    duplicate_count: 0,
    items: selections.map((selection) => ({
      queued: true,
      duplicate: false,
      change_id: selection.change_id,
      state: "pending",
    })),
  });
  assert.equal(retryReceipt.queued_count, 0);
  assert.equal(retryReceipt.duplicate_count, 2);
  assert.equal(outbox.listSummary().length, 2);
  assert.equal(JSON.stringify(outbox.listSummary()).includes("22.5"), false);
  assert.deepEqual(memories, originalMemories);

  console.log(JSON.stringify({
    status: "passed",
    preview_omits_values_and_local_identity: true,
    eligible_count: preview.eligible_count,
    excluded_count: preview.excluded_count,
    two_selected_changes_queued_once: true,
    failed_batch_left_no_partial_queue: true,
    exact_retry_was_idempotent: true,
    outbox_summary_omits_values: true,
    source_memories_unchanged: true,
    network_request_sent: false,
  }, null, 2));
} finally {
  outbox?.close();
  encryptionKey.fill(0);
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
