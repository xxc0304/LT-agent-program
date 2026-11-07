import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { assertProfileSyncKeyPurpose, deriveProfileSyncKey } from "./profile-sync-key-derivation.js";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(new URL("../scripts/get-windows-dpapi-outbox-key.ps1", import.meta.url));

function isWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Return a key-provider callback protected by current-user Windows DPAPI.
 * Decrypted key bytes are captured from a hidden PowerShell child process and
 * returned to the caller only in memory; they are never printed or passed in
 * command-line arguments.
 */
export function createWindowsDpapiOutboxKeyProvider({ baseDirectory } = {}) {
  if (process.platform !== "win32") throw new Error("Windows current-user DPAPI is available only on Windows.");
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("LOCALAPPDATA is unavailable; no DPAPI key path can be selected.");
  const resolvedLocalAppData = path.resolve(localAppData);
  const resolvedBase = path.resolve(baseDirectory ?? path.join(resolvedLocalAppData, "LT-agent-program", "profile-sync-outbox", "dpapi-keys"));
  if (!isWithin(resolvedLocalAppData, resolvedBase)) {
    throw new Error("DPAPI key files must be stored under the current user's LOCALAPPDATA directory.");
  }

  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  if (isWithin(repositoryRoot, resolvedBase)) {
    throw new Error("DPAPI key files must be stored outside the Git workspace.");
  }

  return async function getEncryptionKey({ principal_binding: principalBinding, purpose } = {}) {
    assertProfileSyncKeyPurpose(purpose);
    if (typeof principalBinding !== "string" || !principalBinding.trim() || principalBinding.length > 256) {
      throw new Error("A trusted principal binding is required for the DPAPI key lookup.");
    }
    const principalHash = createHash("sha256").update(principalBinding, "utf8").digest("hex");
    const keyFilePath = path.join(resolvedBase, `user-${principalHash}.dpapi`);
    await fs.mkdir(resolvedBase, { recursive: true });

    let stdout;
    try {
      ({ stdout } = await execFileAsync("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        SCRIPT_PATH,
        "-KeyFile",
        keyFilePath,
      ], {
        windowsHide: true,
        encoding: "buffer",
        maxBuffer: 4096,
        timeout: 15000,
      }));
      const encoded = stdout.toString("ascii").trim();
      if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error("invalid key response");
      const key = Buffer.from(encoded, "base64");
      if (key.length !== 32) {
        key.fill(0);
        throw new Error("invalid key length");
      }
      try {
        return deriveProfileSyncKey(key, principalBinding, purpose);
      } finally {
        key.fill(0);
      }
    } catch (error) {
      error.stdout?.fill?.(0);
      const stderr = error.stderr;
      const stderrText = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? "");
      stderr?.fill?.(0);
      if (/user profile.{0,80}not loaded|not having the user profile loaded|data protection operation was unsuccessful/i.test(stderrText)) {
        throw new Error("Windows DPAPI failed in this process; the error suggests the user profile may not be loaded. Run the host in a signed-in Windows session with that profile loaded.");
      }
      throw new Error("Windows DPAPI outbox key is unavailable; no key material was returned.");
    } finally {
      stdout?.fill?.(0);
    }
  };
}
