import { createLinuxSecretServiceOutboxKeyProvider } from "./linux-secret-service-outbox-key-provider.js";
import { createWindowsDpapiOutboxKeyProvider } from "./windows-dpapi-outbox-key-provider.js";

/**
 * Select the current user's OS-backed Profile-sync key provider. The returned
 * callback derives separate keys for the encrypted outbox and client cache.
 */
export function createProfileSyncKeyProvider(options = {}) {
  if (process.platform === "linux") {
    return createLinuxSecretServiceOutboxKeyProvider(options.linux);
  }
  if (process.platform === "win32") {
    return createWindowsDpapiOutboxKeyProvider(options.windows);
  }
  throw new Error("Profile-sync key storage is supported only on Linux and Windows.");
}
