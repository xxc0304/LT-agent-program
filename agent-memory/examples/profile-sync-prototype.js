import { createInMemoryProfileSyncPrototype } from "../src/profile-sync-prototype.js";
import {
  buildPreferenceDeleteChange,
  buildPreferenceUpsertChange,
} from "../src/profile-sync-payload.js";

// Synthetic-only end-to-end illustration: Gateway and cloud agent share one
// server-like in-memory profile store. No network or real profile is involved.
const service = createInMemoryProfileSyncPrototype({ clock: () => Date.parse("2026-11-06T09:00:00.000Z") });
const syntheticPrincipal = {
  active: true,
  profile_id: "profile_demo_owner",
  home_id: "home_demo_01",
  permissions: ["profile:read", "profile:write"],
  sharing_scopes: ["personal", "household"],
  can_write_household: true,
};
const preferenceId = "457045ef-bdd0-4caf-bab1-b2baf4697119";

const localMemoryRecord = {
  memory_id: preferenceId,
  memory_type: "comfort_temperature_c",
  value: 25,
  subject_id: "household",
  scope: { room_id: "bedroom" },
  status: "confirmed",
  source: "user_explicit",
  confidence: 1,
  consent: "explicit",
  evidence_event_ids: ["synthetic-event-01"],
  updated_at: "2026-11-06T08:30:00.000Z",
  expires_at: null,
};
const firstChange = buildPreferenceUpsertChange({
  memory: localMemoryRecord,
  change_id: "3de93b82-4102-4617-9b35-5d83c2fa35d1",
  expected_revision: 0,
  sharing_scope: "personal",
  remote_sync_confirmed: true,
});

const firstWrite = service.applyChange({ principal: syntheticPrincipal, change: firstChange });
const cloudInitialPull = service.pull({ principal: syntheticPrincipal, sharing_scope: "personal", cursor: 0 });
const repeatedWrite = service.applyChange({ principal: syntheticPrincipal, change: firstChange });

const secondChange = buildPreferenceUpsertChange({
  memory: { ...localMemoryRecord, value: 24, updated_at: "2026-11-06T08:40:00.000Z" },
  change_id: "454f5282-dc04-48ec-968e-a4476a151bbb",
  expected_revision: 1,
  sharing_scope: "personal",
  remote_sync_confirmed: true,
});
const secondWrite = service.applyChange({ principal: syntheticPrincipal, change: secondChange });
const staleWrite = service.applyChange({
  principal: syntheticPrincipal,
  change: buildPreferenceUpsertChange({
    memory: { ...localMemoryRecord, value: 23, updated_at: "2026-11-06T08:41:00.000Z" },
    change_id: "552eb28a-af4c-45ed-9bbc-7f251fba8c3b",
    expected_revision: 1,
    sharing_scope: "personal",
    remote_sync_confirmed: true,
  }),
});
const cloudIncrementalPull = service.pull({ principal: syntheticPrincipal, sharing_scope: "personal", cursor: cloudInitialPull.next_cursor });

const deleteChange = buildPreferenceDeleteChange({
  change_id: "a8d1ba90-9081-4d34-8de1-c4e34fa8c8b8",
  preference_id: preferenceId,
  sharing_scope: "personal",
  expected_revision: 2,
  user_requested_delete: true,
  clock: () => Date.parse("2026-11-06T08:45:00.000Z"),
});
const deleteWrite = service.applyChange({ principal: syntheticPrincipal, change: deleteChange });
const cloudDeletePull = service.pull({ principal: syntheticPrincipal, sharing_scope: "personal", cursor: cloudIncrementalPull.next_cursor });

console.log(JSON.stringify({
  first_write: firstWrite,
  exported_payload_fields: Object.keys(firstChange),
  cloud_first_value: cloudInitialPull.changes[0]?.preference,
  repeated_write: repeatedWrite,
  second_write: secondWrite,
  stale_write: staleWrite,
  cloud_update: cloudIncrementalPull.changes[0],
  delete_write: deleteWrite,
  cloud_delete: cloudDeletePull.changes[0],
}, null, 2));
