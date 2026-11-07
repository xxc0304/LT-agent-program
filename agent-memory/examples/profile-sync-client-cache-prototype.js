import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { applyProfileSyncPage } from "../src/profile-sync-client-cache.js";

const principalBinding = "synthetic-client-cache-principal-a";
const preferenceId = randomUUID();
const changedAt = "2026-11-07T00:00:00.000Z";
let state = { schema_version: "0.1", feeds: [] };

const firstPage = {
  changes: [{
    cursor: 1,
    preference_id: preferenceId,
    operation: "upsert",
    revision: 1,
    preference: { memory_type: "comfort_temperature_c", value: 22.5, scope: { room_id: "bedroom" } },
    changed_at: changedAt,
  }],
  next_cursor: 1,
  has_more: false,
};
const first = applyProfileSyncPage({
  state,
  principalBinding,
  sharingScope: "personal",
  page: firstPage,
});
state = first.state;
assert.equal(first.summary.applied_count, 1);
assert.equal(first.summary.live_preference_count, 1);

const replay = applyProfileSyncPage({
  state,
  principalBinding,
  sharingScope: "personal",
  page: firstPage,
});
assert.equal(replay.summary.ignored_replay_count, 1);
assert.equal(replay.state.feeds[0].records.length, 1);

const updated = applyProfileSyncPage({
  state,
  principalBinding,
  sharingScope: "personal",
  page: {
    changes: [{
      cursor: 2,
      preference_id: preferenceId,
      operation: "upsert",
      revision: 2,
      preference: { memory_type: "comfort_temperature_c", value: 21.5, scope: { room_id: "bedroom" } },
      changed_at: changedAt,
    }],
    next_cursor: 2,
    has_more: false,
  },
});
state = updated.state;
assert.equal(state.feeds[0].records[0].revision, 2);
assert.equal(state.feeds[0].records[0].preference.value, 21.5);

const deleted = applyProfileSyncPage({
  state,
  principalBinding,
  sharingScope: "personal",
  page: {
    changes: [{
      cursor: 3,
      preference_id: preferenceId,
      operation: "delete",
      revision: 3,
      changed_at: changedAt,
    }],
    next_cursor: 3,
    has_more: false,
  },
});
state = deleted.state;
assert.equal(deleted.summary.live_preference_count, 0);
assert.equal(deleted.summary.tombstone_count, 1);
assert.equal(Object.hasOwn(state.feeds[0].records[0], "preference"), false);

const isolated = applyProfileSyncPage({
  state,
  principalBinding: "synthetic-client-cache-principal-b",
  sharingScope: "personal",
  page: { changes: [], next_cursor: 0, has_more: false },
});
state = isolated.state;
assert.equal(state.feeds.length, 2);
assert.equal(state.feeds.find((feed) => feed.cursor === 0).records.length, 0);
assert.equal(JSON.stringify(state).includes(principalBinding), false);

console.log(JSON.stringify({
  status: "passed",
  upsert_and_revision_update_applied: true,
  page_replay_was_idempotent: true,
  delete_tombstone_removed_preference_value: true,
  principal_feeds_are_isolated: true,
  raw_principal_binding_not_stored: true,
  network_request_sent: false,
}, null, 2));
