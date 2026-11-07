import assert from "node:assert/strict";
import test from "node:test";

import { deriveProfileSyncKey } from "../src/profile-sync-key-derivation.js";
import { createProfileSyncKeyProvider } from "../src/profile-sync-key-provider.js";

test("Profile sync key derivation is stable and isolated by principal and purpose", () => {
  const rootKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
  try {
    const outboxKey = deriveProfileSyncKey(rootKey, "synthetic-principal-a", "outbox");
    const sameOutboxKey = deriveProfileSyncKey(rootKey, "synthetic-principal-a", "outbox");
    const cacheKey = deriveProfileSyncKey(rootKey, "synthetic-principal-a", "client-cache");
    const otherPrincipalKey = deriveProfileSyncKey(rootKey, "synthetic-principal-b", "outbox");

    assert.deepEqual(outboxKey, sameOutboxKey);
    assert.notDeepEqual(outboxKey, cacheKey);
    assert.notDeepEqual(outboxKey, otherPrincipalKey);
    assert.throws(() => deriveProfileSyncKey(rootKey, "synthetic-principal-a", "unknown-purpose"), TypeError);

    outboxKey.fill(0);
    sameOutboxKey.fill(0);
    cacheKey.fill(0);
    otherPrincipalKey.fill(0);
  } finally {
    rootKey.fill(0);
  }
});

test("platform key-provider factory initializes without opening the OS vault", () => {
  const getEncryptionKey = createProfileSyncKeyProvider();
  assert.equal(typeof getEncryptionKey, "function");
});
