import assert from "node:assert/strict";
import test from "node:test";

import { startLocalProfileSyncHttpServer } from "../src/profile-sync-local-http-server.js";

function createService() {
  return {
    async applyChange() { return { status: 200, applied: true }; },
    async pull() { return { changes: [], next_cursor: 0, has_more: false }; },
    async readCurrentPreferences() { return { preferences: [] }; },
  };
}

test("loopback HTTP server stays on 127.0.0.1 and enforces authentication and body limits", async () => {
  const server = await startLocalProfileSyncHttpServer({
    service: createService(),
    consentService: { async applyChange() { return { status: 200, active: true }; } },
    resolveBearerToken: async () => null,
    hasCurrentConsent: async () => false,
  });

  try {
    assert.equal(server.host, "127.0.0.1");
    assert.match(server.apiBaseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

    const unauthenticated = await fetch(`${server.apiBaseUrl}/v1/preferences/changes?sharing_scope=personal`);
    assert.equal(unauthenticated.status, 401);
    assert.equal((await unauthenticated.json()).code, "AUTHENTICATION_REQUIRED");

    const oversized = await fetch(`${server.apiBaseUrl}/v1/preferences/changes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: "x".repeat(17 * 1024) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).code, "REQUEST_TOO_LARGE");
  } finally {
    await server.close();
  }
});

test("loopback HTTP server rejects non-loopback bind addresses and missing trusted callbacks", async () => {
  await assert.rejects(
    () => startLocalProfileSyncHttpServer({
      service: createService(),
      resolveBearerToken: async () => null,
      hasCurrentConsent: async () => false,
      host: "0.0.0.0",
    }),
    TypeError,
  );
  await assert.rejects(
    () => startLocalProfileSyncHttpServer({
      service: createService(),
      hasCurrentConsent: async () => false,
    }),
    TypeError,
  );
});
