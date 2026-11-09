import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLinuxSecretServiceOutboxKeyProvider } from "../src/linux-secret-service-outbox-key-provider.js";

const LINUX_ONLY = { skip: process.platform !== "linux" };

async function makeFakeSecretTool(directory, { lookupResponse, storeExitCode = 0 } = {}) {
  const storePath = path.join(directory, "synthetic-secret-store");
  const scriptPath = path.join(directory, "secret-tool-mock.mjs");
  const source = `#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
const storePath = ${JSON.stringify(storePath)};
const lookupResponse = ${JSON.stringify(lookupResponse ?? null)};
const storeExitCode = ${storeExitCode};
const action = process.argv[2];
if (action === "lookup") {
  if (lookupResponse !== null) {
    process.stdout.write(lookupResponse);
    process.exitCode = 0;
  } else {
    try { process.stdout.write(await readFile(storePath)); }
    catch (error) { if (error.code === "ENOENT") process.exitCode = 1; else throw error; }
  }
} else if (action === "store") {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const value = Buffer.concat(chunks);
  if (storeExitCode !== 0) process.exitCode = storeExitCode;
  else await writeFile(storePath, value, { mode: 0o600 });
  value.fill(0);
} else {
  process.exitCode = 2;
}
`;
  await writeFile(scriptPath, source, { mode: 0o700 });
  await chmod(scriptPath, 0o700);
  return { scriptPath, storePath };
}

function makeProvider({ stateDirectory, secretToolPath }) {
  return createLinuxSecretServiceOutboxKeyProvider({
    stateDirectory,
    secretToolPath,
    keyringApplication: "lt-agent-program-test",
    timeoutMs: 5000,
    lockWaitMs: 1000,
  });
}

test("Linux provider stores one synthetic root key and derives stable isolated keys", LINUX_ONLY, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "profile-sync-secret-tool-test-"));
  const keys = [];
  try {
    const { scriptPath, storePath } = await makeFakeSecretTool(directory);
    const stateDirectory = path.join(directory, "state");
    const getKey = makeProvider({ stateDirectory, secretToolPath: scriptPath });
    const principal = "synthetic-linux-test-principal";
    keys.push(await getKey({ principal_binding: principal, purpose: "outbox" }));
    keys.push(await getKey({ principal_binding: principal, purpose: "outbox" }));
    keys.push(await getKey({ principal_binding: principal, purpose: "client-cache" }));
    keys.push(await getKey({ principal_binding: `${principal}-other`, purpose: "outbox" }));

    assert.ok(keys.every((key) => Buffer.isBuffer(key) && key.length === 32));
    assert.deepEqual(keys[0], keys[1]);
    assert.notDeepEqual(keys[0], keys[2]);
    assert.notDeepEqual(keys[0], keys[3]);

    const storedRootKey = await readFile(storePath);
    assert.equal(storedRootKey.length, 44);
    storedRootKey.fill(0);
    assert.equal((await stat(storePath)).mode & 0o777, 0o600);

    const lockDirectory = path.join(stateDirectory, "lt-agent-program", "profile-sync", "key-init-locks");
    assert.equal((await stat(lockDirectory)).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(lockDirectory), []);
  } finally {
    for (const key of keys) key.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Linux provider fails closed when secret-tool is unavailable", LINUX_ONLY, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "profile-sync-secret-tool-missing-"));
  try {
    const missingTool = path.join(directory, "missing-secret-tool");
    const getKey = makeProvider({ stateDirectory: path.join(directory, "state"), secretToolPath: missingTool });
    await assert.rejects(
      getKey({ principal_binding: "synthetic-principal", purpose: "outbox" }),
      (error) => error.code === "LINUX_SECRET_SERVICE_UNAVAILABLE",
    );
    assert.deepEqual(await readdir(directory), ["state"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Linux provider rejects malformed Secret Service output", LINUX_ONLY, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "profile-sync-secret-tool-invalid-"));
  try {
    const { scriptPath } = await makeFakeSecretTool(directory, { lookupResponse: "not-a-key\n" });
    const getKey = makeProvider({ stateDirectory: path.join(directory, "state"), secretToolPath: scriptPath });
    await assert.rejects(
      getKey({ principal_binding: "synthetic-principal", purpose: "outbox" }),
      (error) => error.code === "LINUX_SECRET_KEY_INVALID",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Linux provider does not fall back when synthetic secret storage fails", LINUX_ONLY, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "profile-sync-secret-tool-store-fail-"));
  try {
    const { scriptPath, storePath } = await makeFakeSecretTool(directory, { storeExitCode: 1 });
    const getKey = makeProvider({ stateDirectory: path.join(directory, "state"), secretToolPath: scriptPath });
    await assert.rejects(
      getKey({ principal_binding: "synthetic-principal", purpose: "outbox" }),
      (error) => error.code === "LINUX_SECRET_SERVICE_UNAVAILABLE",
    );
    await assert.rejects(readFile(storePath), (error) => error.code === "ENOENT");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
