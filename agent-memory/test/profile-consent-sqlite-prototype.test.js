import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSqliteProfileConsentPrototype } from "../src/profile-consent-sqlite-prototype.js";

const principal = { active: true, profile_id: "synthetic-profile-a" };
const databasePathFor = (directory) => path.join(directory, "consent.sqlite");

async function createTemporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "profile-consent-sqlite-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

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

test("SQLite consent ledger survives restart and preserves idempotency and revisions", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const databasePath = databasePathFor(directory);
  const changeId = "11111111-1111-4111-8111-111111111111";
  const grant = consentChange({ change_id: changeId });

  let ledger = await createSqliteProfileConsentPrototype({ databasePath });
  assert.deepEqual(await ledger.applyChange({ principal, change: grant }), {
    status: 200, applied: true, active: true, revision: 1, duplicate: false,
  });
  await ledger.close();

  ledger = await createSqliteProfileConsentPrototype({ databasePath });
  assert.equal(await ledger.hasCurrentConsent(principal, {
    permission: "profile:read",
    purpose: "preference_sync",
    sharing_scope: "personal",
  }), true);
  assert.deepEqual(await ledger.applyChange({ principal, change: grant }), {
    status: 200, applied: true, active: true, revision: 1, duplicate: true,
  });

  const reusedKey = await ledger.applyChange({ principal, change: consentChange({
    change_id: changeId,
    operation: "revoke",
    expected_revision: 1,
  }) });
  assert.deepEqual(reusedKey, { status: 409, applied: false, code: "IDEMPOTENCY_KEY_REUSED" });

  const revokeId = "22222222-2222-4222-8222-222222222222";
  assert.deepEqual(await ledger.applyChange({ principal, change: consentChange({
    change_id: revokeId,
    operation: "revoke",
    expected_revision: 1,
  }) }), { status: 200, applied: true, active: false, revision: 2, duplicate: false });
  await ledger.close();

  ledger = await createSqliteProfileConsentPrototype({ databasePath });
  assert.equal(await ledger.hasCurrentConsent(principal, {
    permission: "profile:read",
    purpose: "preference_sync",
    sharing_scope: "personal",
  }), false);
  const current = await ledger.listCurrent({ principal, sharing_scope: "personal" });
  assert.equal(current.length, 1);
  assert.equal(current[0].revision, 2);
  assert.equal(current[0].active, false);
  await ledger.close();
});

test("SQLite consent ledger fails closed for household changes without trusted authorization", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const ledger = await createSqliteProfileConsentPrototype({ databasePath: databasePathFor(directory) });
  await assert.rejects(
    () => ledger.applyChange({
      principal: { ...principal, home_id: "synthetic-household-a" },
      change: consentChange({
        change_id: "33333333-3333-4333-8333-333333333333",
        sharing_scope: "household",
      }),
    }),
    (error) => error.code === "HOUSEHOLD_ACCESS_DENIED",
  );
  await ledger.close();
});

test("SQLite consent ledger accepts household changes only through injected host authorization", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const ledger = await createSqliteProfileConsentPrototype({
    databasePath: databasePathFor(directory),
    authorizeScope: async ({ principal: actor, sharing_scope, operation }) => actor.home_id === "synthetic-household-a"
      && sharing_scope === "household" && operation === "grant",
  });
  const result = await ledger.applyChange({
    principal: { ...principal, home_id: "synthetic-household-a" },
    change: consentChange({
      change_id: "44444444-4444-4444-8444-444444444444",
      sharing_scope: "household",
    }),
  });
  assert.equal(result.status, 200);
  assert.equal(result.active, true);
  await ledger.close();
});

test("SQLite consent ledger drains queued writes before close and rejects new work", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const databasePath = databasePathFor(directory);
  let allowAuthorization;
  const authorizationGate = new Promise((resolve) => { allowAuthorization = resolve; });
  const ledger = await createSqliteProfileConsentPrototype({
    databasePath,
    authorizeScope: async () => authorizationGate,
  });
  const grant = ledger.applyChange({
    principal: { ...principal, home_id: "synthetic-household-a" },
    change: consentChange({
      change_id: "55555555-5555-4555-8555-555555555555",
      sharing_scope: "household",
    }),
  });
  let didClose = false;
  const closing = ledger.close().then(() => { didClose = true; });
  await Promise.resolve();
  assert.equal(didClose, false);
  await assert.rejects(
    () => ledger.hasCurrentConsent(principal, {
      permission: "profile:read",
      purpose: "preference_sync",
      sharing_scope: "personal",
    }),
    /closed/,
  );
  allowAuthorization(true);
  assert.equal((await grant).status, 200);
  await closing;
  await ledger.close();

  const reopened = await createSqliteProfileConsentPrototype({
    databasePath,
    authorizeScope: async () => true,
  });
  assert.equal(await reopened.hasCurrentConsent({
    ...principal,
    home_id: "synthetic-household-a",
  }, {
    permission: "profile:read",
    purpose: "preference_sync",
    sharing_scope: "household",
  }), true);
  await reopened.close();
});

test("SQLite consent ledger requires an explicit on-disk path", async () => {
  await assert.rejects(() => createSqliteProfileConsentPrototype({ databasePath: ":memory:" }), TypeError);
  await assert.rejects(() => createSqliteProfileConsentPrototype({}), TypeError);
});
