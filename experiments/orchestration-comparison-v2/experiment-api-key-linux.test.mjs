import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HELPER = new URL("./tools/experiment-api-key-linux.sh", import.meta.url);
const HELPER_PATH = fileURLToPath(HELPER);

function withFakeSecretService(run) {
  const directory = mkdtempSync(join(tmpdir(), "lt-api-key-test-"));
  const fakeSecretTool = join(directory, "secret-tool");
  writeFileSync(fakeSecretTool, [
    "#!/usr/bin/env bash",
    "set -eu",
    'case "$1" in',
    '  lookup) [[ -n "${FAKE_TEST_SECRET:-}" ]] || exit 1; printf \'%s\\n\' "$FAKE_TEST_SECRET" ;;',
    "  store) cat >/dev/null ;;",
    "  *) exit 2 ;;",
    "esac",
    "",
  ].join("\n"));
  chmodSync(fakeSecretTool, 0o700);
  try {
    run({ directory, fakeSecretTool });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("Linux API-key helper injects a stored key only into the requested child process", { skip: process.platform !== "linux" }, () => {
  withFakeSecretService(({ fakeSecretTool }) => {
    const syntheticSecret = "test-only-synthetic-key";
    const result = spawnSync("bash", [
      HELPER_PATH,
      "with-key",
      "--",
      "node",
      "-e",
      "process.stdout.write(process.env.LT_EXPERIMENT_API_KEY === 'test-only-synthetic-key' ? 'key-available' : 'missing')",
    ], {
      encoding: "utf8",
      env: { ...process.env, SECRET_TOOL: fakeSecretTool, FAKE_TEST_SECRET: syntheticSecret },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "key-available");
    assert.equal(result.stdout.includes(syntheticSecret), false);
    assert.equal(result.stderr.includes(syntheticSecret), false);

    const status = spawnSync("bash", [HELPER_PATH, "check"], {
      encoding: "utf8",
      env: { ...process.env, SECRET_TOOL: fakeSecretTool, FAKE_TEST_SECRET: syntheticSecret },
    });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /API key is available/);
    assert.equal(status.stdout.includes(syntheticSecret), false);
  });
});

test("Linux API-key helper fails closed when Secret Service has no stored value", { skip: process.platform !== "linux" }, () => {
  withFakeSecretService(({ fakeSecretTool }) => {
    const result = spawnSync("bash", [
      HELPER_PATH,
      "with-key",
      "--",
      "node",
      "-e",
      "process.stdout.write('child-ran')",
    ], {
      encoding: "utf8",
      env: { ...process.env, SECRET_TOOL: fakeSecretTool, FAKE_TEST_SECRET: "" },
    });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /API key is unavailable/);
    assert.equal(result.stdout.includes("child-ran"), false);
  });
});
