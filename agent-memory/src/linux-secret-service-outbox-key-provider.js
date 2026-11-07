import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensurePrivatePosixDirectory } from "./private-directory.js";
import { assertProfileSyncKeyPurpose, deriveProfileSyncKey } from "./profile-sync-key-derivation.js";

const OUTPUT_LIMIT_BYTES = 4096;
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function isWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`)
    && relative !== ".." && !path.isAbsolute(relative));
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function defaultStateDirectory(env) {
  const stateHome = env.XDG_STATE_HOME;
  const base = path.isAbsolute(stateHome ?? "")
    ? stateHome
    : path.join(os.homedir(), ".local", "state");
  return base;
}

function runSecretTool(secretToolPath, args, { input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(secretToolPath, args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      reject(codedError("LINUX_SECRET_SERVICE_UNAVAILABLE", "Linux Secret Service is unavailable."));
      return;
    }

    const stdoutParts = [];
    const stderrParts = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let outputTooLarge = false;
    let timedOut = false;
    let settled = false;
    const finishWithError = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const part of [...stdoutParts, ...stderrParts]) part.fill(0);
      reject(error);
    };
    const collect = (parts, chunk, kind) => {
      if (kind === "stdout") stdoutLength += chunk.length;
      else stderrLength += chunk.length;
      if (stdoutLength > OUTPUT_LIMIT_BYTES || stderrLength > OUTPUT_LIMIT_BYTES) {
        outputTooLarge = true;
        child.kill("SIGKILL");
        return;
      }
      parts.push(Buffer.from(chunk));
    };

    child.stdout.on("data", (chunk) => collect(stdoutParts, chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(stderrParts, chunk, "stderr"));
    child.stdin.on("error", () => {});
    child.on("error", () => finishWithError(
      codedError("LINUX_SECRET_SERVICE_UNAVAILABLE", "Linux Secret Service is unavailable."),
    ));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutParts);
      const stderr = Buffer.concat(stderrParts);
      for (const part of [...stdoutParts, ...stderrParts]) part.fill(0);
      if (timedOut || outputTooLarge) {
        stdout.fill(0);
        stderr.fill(0);
        reject(codedError(
          timedOut ? "LINUX_SECRET_SERVICE_TIMEOUT" : "LINUX_SECRET_SERVICE_INVALID_RESPONSE",
          timedOut ? "Linux Secret Service did not respond in time." : "Linux Secret Service returned an invalid response.",
        ));
        return;
      }
      resolve({ code, stdout, stderr });
    });

    if (input) child.stdin.end(input, () => input.fill(0));
    else child.stdin.end();
  });
}

async function lookupKey(secretToolPath, attributes, timeoutMs) {
  const result = await runSecretTool(secretToolPath, ["lookup", ...attributes], { timeoutMs });
  try {
    if (result.code === 1 && result.stderr.length === 0) return null;
    if (result.code !== 0) {
      throw codedError("LINUX_SECRET_SERVICE_UNAVAILABLE", "Linux Secret Service lookup failed.");
    }
    const encoded = result.stdout.toString("ascii");
    if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
      throw codedError("LINUX_SECRET_KEY_INVALID", "Linux Secret Service returned an invalid key.");
    }
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) {
      key.fill(0);
      throw codedError("LINUX_SECRET_KEY_INVALID", "Linux Secret Service returned an invalid key.");
    }
    return key;
  } finally {
    result.stdout.fill(0);
    result.stderr.fill(0);
  }
}

async function storeKey(secretToolPath, attributes, key, timeoutMs) {
  const encoded = Buffer.from(key.toString("base64"), "ascii");
  const args = [
    "store",
    "--label=LT Agent Program Profile sync outbox key",
    ...attributes,
  ];
  try {
    const result = await runSecretTool(secretToolPath, args, { input: encoded, timeoutMs });
    try {
      if (result.code !== 0) {
        throw codedError("LINUX_SECRET_SERVICE_UNAVAILABLE", "Linux Secret Service could not store the outbox key.");
      }
    } finally {
      result.stdout.fill(0);
      result.stderr.fill(0);
    }
  } finally {
    encoded.fill(0);
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withInitializationLock(lockPath, lockWaitMs, callback) {
  const deadline = Date.now() + lockWaitMs;
  let handle;
  while (!handle) {
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw codedError(
          "LINUX_SECRET_KEY_INITIALIZATION_LOCKED",
          "Linux outbox key initialization is already running or has a stale lock; no key was changed.",
        );
      }
      await wait(100);
    }
  }

  try {
    await handle.writeFile("initializing", "utf8");
    await handle.sync();
    return await callback();
  } finally {
    await handle.close();
    try {
      await fs.rm(lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

/**
 * Return an outbox-key callback backed by the Linux login-session Secret Service.
 * Requires `secret-tool` and an available user-session Secret Service. It has
 * no file/environment fallback; headless services without that session fail closed.
 */
export function createLinuxSecretServiceOutboxKeyProvider({
  stateDirectory,
  secretToolPath = "secret-tool",
  keyringApplication = "lt-agent-program",
  timeoutMs = 15000,
  lockWaitMs = 10000,
  env = process.env,
} = {}) {
  if (process.platform !== "linux") {
    throw new Error("The Linux Secret Service key provider is available only on Linux.");
  }
  if (typeof secretToolPath !== "string" || !secretToolPath.trim()) {
    throw new TypeError("secretToolPath must be a non-empty executable path.");
  }
  if (typeof keyringApplication !== "string" || !/^[a-z0-9][a-z0-9.-]{0,62}$/.test(keyringApplication)) {
    throw new TypeError("keyringApplication must be a short lowercase application identifier.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000
    || !Number.isSafeInteger(lockWaitMs) || lockWaitMs < 1000 || lockWaitMs > 60000) {
    throw new TypeError("timeoutMs and lockWaitMs must be integers between 1000 and 60000.");
  }
  const selectedStateDirectory = stateDirectory ?? defaultStateDirectory(env);
  if (typeof selectedStateDirectory !== "string" || !path.isAbsolute(selectedStateDirectory)) {
    throw new TypeError("stateDirectory must be an absolute path.");
  }

  return async function getEncryptionKey({ principal_binding: principalBinding, purpose } = {}) {
    assertProfileSyncKeyPurpose(purpose);
    if (typeof principalBinding !== "string" || !principalBinding.trim() || principalBinding.length > 256) {
      throw codedError("LINUX_SECRET_KEY_PRINCIPAL_REQUIRED", "A trusted principal binding is required.");
    }
    const attributes = [
      "application", keyringApplication,
      "purpose", "profile-sync-outbox-key",
    ];
    const lockDirectory = path.join(selectedStateDirectory, "lt-agent-program", "profile-sync", "key-init-locks");
    if (isWithin(REPOSITORY_ROOT, lockDirectory)) {
      throw new TypeError("Linux outbox key lock state must be stored outside the Git workspace.");
    }
    await ensurePrivatePosixDirectory(lockDirectory, {
      code: "LINUX_SECRET_KEY_LOCK_DIRECTORY_NOT_PRIVATE",
      unsafePathCode: "LINUX_SECRET_KEY_PATH_UNSAFE",
      message: "Linux outbox key lock directory must be owned by the current user and have mode 0700.",
    });

    const existingRootKey = await lookupKey(secretToolPath, attributes, timeoutMs);
    if (existingRootKey) {
      try {
        return deriveProfileSyncKey(existingRootKey, principalBinding, purpose);
      } finally {
        existingRootKey.fill(0);
      }
    }

    const lockPath = path.join(lockDirectory, "root-key.lock");
    return withInitializationLock(lockPath, lockWaitMs, async () => {
      const racedRootKey = await lookupKey(secretToolPath, attributes, timeoutMs);
      if (racedRootKey) {
        try {
          return deriveProfileSyncKey(racedRootKey, principalBinding, purpose);
        } finally {
          racedRootKey.fill(0);
        }
      }

      const generatedRootKey = randomBytes(32);
      try {
        await storeKey(secretToolPath, attributes, generatedRootKey, timeoutMs);
        const storedRootKey = await lookupKey(secretToolPath, attributes, timeoutMs);
        if (!storedRootKey || !timingSafeEqual(generatedRootKey, storedRootKey)) {
          storedRootKey?.fill(0);
          throw codedError("LINUX_SECRET_KEY_PERSISTENCE_FAILED", "Linux outbox key could not be verified after storage.");
        }
        try {
          return deriveProfileSyncKey(storedRootKey, principalBinding, purpose);
        } finally {
          storedRootKey.fill(0);
        }
      } finally {
        generatedRootKey.fill(0);
      }
    });
  };
}
