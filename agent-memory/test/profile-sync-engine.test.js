import assert from "node:assert/strict";
import test from "node:test";

import { createProfileSyncEngine } from "../src/profile-sync-engine.js";

const PRINCIPAL_BINDING = "synthetic-engine-principal";

function page(cursor, hasMore) {
  return { changes: [], next_cursor: cursor, has_more: hasMore };
}

test("one-shot sync sends queued changes and applies every authorized page", async () => {
  let dispatchCount = 0;
  const pages = [page(1, true), page(2, false)];
  const applied = [];
  const consentRequests = [];
  const engine = createProfileSyncEngine({
    principalBinding: PRINCIPAL_BINDING,
    sharingScopes: ["personal"],
    isConsentCurrent: async (request) => {
      consentRequests.push(request);
      return true;
    },
    outbox: {
      async dispatchOne({ send, isConsentCurrent }) {
        if (dispatchCount > 0) return { status: "idle" };
        dispatchCount += 1;
        assert.equal(await isConsentCurrent({
          principal_binding: PRINCIPAL_BINDING,
          sharing_scope: "personal",
          change_id: "synthetic-change",
          operation: "upsert",
          permission: "profile:write",
          purpose: "preference_sync",
        }), true);
        const response = await send({ change_id: "synthetic-change" });
        assert.equal(response.status, 200);
        return { status: "acknowledged" };
      },
    },
    client: {
      async sendChange() { return { status: 200, body: { applied: true } }; },
      async pullPage({ cursor }) {
        assert.equal(cursor, applied.at(-1)?.next_cursor ?? 0);
        return pages.shift();
      },
    },
    cache: {
      async readFeed({ authenticatedPrincipalBinding }) {
        assert.equal(authenticatedPrincipalBinding, PRINCIPAL_BINDING);
        return { cursor: 0, records: [] };
      },
      async applyPage({ page: incoming, authenticatedPrincipalBinding }) {
        assert.equal(authenticatedPrincipalBinding, PRINCIPAL_BINDING);
        applied.push(incoming);
        return {
          next_cursor: incoming.next_cursor,
          has_more: incoming.has_more,
          applied_count: 0,
          ignored_stale_count: 0,
          ignored_replay_count: 0,
        };
      },
    },
  });

  const result = await engine.syncOnce({ maxPullPages: 2 });
  assert.equal(result.status, "complete");
  assert.equal(result.push.acknowledged, 1);
  assert.equal(result.push.idle, 1);
  assert.deepEqual(result.pull, [{
    sharing_scope: "personal",
    status: "complete",
    pages: 2,
    cursor: 2,
    applied_count: 0,
    ignored_stale_count: 0,
    ignored_replay_count: 0,
  }]);
  assert.equal(consentRequests.some((request) => request.permission === "profile:read"), true);
  assert.equal(JSON.stringify(result).includes("preference"), false);
});

test("missing current read consent skips cache access and network pull", async () => {
  let pullCalls = 0;
  let cacheReads = 0;
  const engine = createProfileSyncEngine({
    principalBinding: PRINCIPAL_BINDING,
    isConsentCurrent: async () => false,
    outbox: { async dispatchOne() { return { status: "idle" }; } },
    client: {
      async sendChange() { throw new Error("must not send"); },
      async pullPage() { pullCalls += 1; throw new Error("must not pull"); },
    },
    cache: {
      async readFeed() { cacheReads += 1; throw new Error("must not read"); },
      async applyPage() { throw new Error("must not apply"); },
    },
  });

  const result = await engine.syncOnce();
  assert.equal(result.status, "partial");
  assert.deepEqual(result.pull, [{ sharing_scope: "personal", status: "consent_required" }]);
  assert.equal(pullCalls, 0);
  assert.equal(cacheReads, 0);
});

test("overlapping syncOnce calls are rejected instead of competing for the outbox", async () => {
  let finishDispatch;
  const dispatchGate = new Promise((resolve) => { finishDispatch = resolve; });
  const engine = createProfileSyncEngine({
    principalBinding: PRINCIPAL_BINDING,
    isConsentCurrent: async () => false,
    outbox: {
      async dispatchOne() {
        await dispatchGate;
        return { status: "idle" };
      },
    },
    client: { async sendChange() {}, async pullPage() {} },
    cache: { async readFeed() {}, async applyPage() {} },
  });

  const first = engine.syncOnce();
  await assert.rejects(() => engine.syncOnce(), (error) => error.code === "PROFILE_SYNC_ALREADY_RUNNING");
  finishDispatch();
  assert.equal((await first).status, "partial");
});
