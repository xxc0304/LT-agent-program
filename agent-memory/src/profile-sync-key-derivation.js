import { createHash, hkdfSync } from "node:crypto";

const PURPOSES = new Map([
  ["outbox", "profile-sync-outbox"],
  ["client-cache", "profile-sync-client-cache"],
]);

export function assertProfileSyncKeyPurpose(purpose) {
  if (!PURPOSES.has(purpose)) throw new TypeError("An approved profile-sync key purpose is required.");
}

export function deriveProfileSyncKey(rootKey, principalBinding, purpose) {
  if (typeof principalBinding !== "string" || !principalBinding.trim() || principalBinding.length > 256) {
    throw new TypeError("A trusted principal binding is required for profile-sync key derivation.");
  }
  assertProfileSyncKeyPurpose(purpose);
  const purposeNamespace = PURPOSES.get(purpose);
  if (!(Buffer.isBuffer(rootKey) || rootKey instanceof Uint8Array) || rootKey.byteLength !== 32) {
    throw new TypeError("The profile-sync root key must contain exactly 32 bytes.");
  }

  const principalHash = createHash("sha256").update(principalBinding, "utf8").digest();
  const info = Buffer.concat([
    Buffer.from(`lt-agent-program/${purposeNamespace}/v0.1/`, "utf8"),
    principalHash,
  ]);
  try {
    return Buffer.from(hkdfSync("sha256", rootKey, Buffer.alloc(0), info, 32));
  } finally {
    principalHash.fill(0);
    info.fill(0);
  }
}
