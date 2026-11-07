import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";

import { createProfileSyncKeyProvider } from "../src/profile-sync-key-provider.js";

if (process.platform !== "linux") {
  throw new Error("This smoke check must run on Linux.");
}

const testKeyringApplication = "lt-agent-program-profile-sync-smoke";
const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "profile-sync-key-smoke-"));
const getEncryptionKey = createProfileSyncKeyProvider({
  linux: {
    keyringApplication: testKeyringApplication,
    stateDirectory,
  },
});
const principal = "synthetic-linux-key-provider-smoke";
const keys = [];

try {
  keys.push(await getEncryptionKey({ principal_binding: principal, purpose: "outbox" }));
  keys.push(await getEncryptionKey({ principal_binding: principal, purpose: "outbox" }));
  keys.push(await getEncryptionKey({ principal_binding: principal, purpose: "client-cache" }));
  keys.push(await getEncryptionKey({ principal_binding: `${principal}-other`, purpose: "outbox" }));

  if (keys.some((key) => !Buffer.isBuffer(key) || key.length !== 32)) {
    throw new Error("Linux Secret Service returned an invalid derived key.");
  }
  if (!timingSafeEqual(keys[0], keys[1])) {
    throw new Error("Linux Secret Service did not return a stable key for the same purpose and principal.");
  }
  if (timingSafeEqual(keys[0], keys[2]) || timingSafeEqual(keys[0], keys[3])) {
    throw new Error("Linux Secret Service did not isolate keys by purpose and principal.");
  }

  console.log(JSON.stringify({
    status: "passed",
    synthetic_principal: true,
    key_material_output: false,
  }, null, 2));
} finally {
  for (const key of keys) {
    if (Buffer.isBuffer(key) || key instanceof Uint8Array) key.fill(0);
  }
  await fs.rm(stateDirectory, { recursive: true, force: true });
}
