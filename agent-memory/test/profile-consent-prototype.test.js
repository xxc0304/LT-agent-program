import assert from "node:assert/strict";
import test from "node:test";

import { createInMemoryProfileConsentPrototype } from "../src/profile-consent-prototype.js";

const principal = { active: true, profile_id: "synthetic-profile-a" };

function consentChange({
  change_id,
  operation = "grant",
  permission = "profile:read",
  purpose = "preference_sync",
  sharing_scope = "personal",
  preference_type,
  expected_revision = 0,
} = {}) {
  return {
    schema_version: "0.1",
    change_id,
    operation,
    permission,
    purpose,
    sharing_scope,
    ...(preference_type ? { preference_type } : {}),
    expected_revision,
    changed_at: "2026-11-07T00:00:00.000Z",
  };
}

test("grant and revoke are revisioned, idempotent and purpose scoped", async () => {
  const ledger = createInMemoryProfileConsentPrototype();
  const syncRead = consentChange({ change_id: "11111111-1111-4111-8111-111111111111" });
  const grant = await ledger.applyChange({ principal, change: syncRead });
  assert.deepEqual(grant, { status: 200, applied: true, active: true, revision: 1, duplicate: false });
  assert.equal((await ledger.applyChange({ principal, change: syncRead })).duplicate, true);
  assert.equal(await ledger.hasCurrentConsent(principal, {
    permission: "profile:read",
    purpose: "preference_sync",
    sharing_scope: "personal",
  }), true);
  assert.equal(await ledger.hasCurrentConsent(principal, {
    permission: "profile:read",
    purpose: "agent_task",
    sharing_scope: "personal",
    preference_type: "comfort_temperature_c",
  }), false);

  const revoke = await ledger.applyChange({ principal, change: consentChange({
    change_id: "22222222-2222-4222-8222-222222222222",
    operation: "revoke",
    expected_revision: 1,
  }) });
  assert.deepEqual(revoke, { status: 200, applied: true, active: false, revision: 2, duplicate: false });
  assert.equal(await ledger.hasCurrentConsent(principal, {
    permission: "profile:read",
    purpose: "preference_sync",
    sharing_scope: "personal",
  }), false);
});

test("stale revisions and reused change IDs are rejected without overwriting consent", async () => {
  const ledger = createInMemoryProfileConsentPrototype();
  const grant = consentChange({ change_id: "33333333-3333-4333-8333-333333333333" });
  await ledger.applyChange({ principal, change: grant });

  const stale = await ledger.applyChange({ principal, change: consentChange({
    change_id: "44444444-4444-4444-8444-444444444444",
    operation: "revoke",
    expected_revision: 0,
  }) });
  assert.equal(stale.status, 409);
  assert.equal(stale.code, "REVISION_CONFLICT");
  assert.equal(stale.current_revision, 1);

  const reused = await ledger.applyChange({ principal, change: consentChange({
    ...grant,
    operation: "revoke",
    expected_revision: 1,
  }) });
  assert.equal(reused.status, 409);
  assert.equal(reused.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(await ledger.hasCurrentConsent(principal, {
    permission: "profile:read",
    purpose: "preference_sync",
    sharing_scope: "personal",
  }), true);
});

test("Agent task grants are category specific and household management fails closed", async () => {
  const ledger = createInMemoryProfileConsentPrototype();
  const taskGrant = await ledger.applyChange({ principal, change: consentChange({
    change_id: "55555555-5555-4555-8555-555555555555",
    purpose: "agent_task",
    preference_type: "comfort_temperature_c",
  }) });
  assert.equal(taskGrant.active, true);
  assert.equal(await ledger.hasCurrentConsent(principal, {
    permission: "profile:read",
    purpose: "agent_task",
    sharing_scope: "personal",
    preference_type: "comfort_temperature_c",
  }), true);
  assert.equal(await ledger.hasCurrentConsent(principal, {
    permission: "profile:read",
    purpose: "agent_task",
    sharing_scope: "personal",
    preference_type: "sleep_time",
  }), false);
  await assert.rejects(
    () => ledger.applyChange({ principal: { ...principal, home_id: "synthetic-home-a" }, change: consentChange({
      change_id: "66666666-6666-4666-8666-666666666666",
      sharing_scope: "household",
    }) }),
    (error) => error.code === "HOUSEHOLD_ACCESS_DENIED",
  );
});
