import { MockHomeAssistant } from "./mock-ha.js";
import { RealHomeAssistant } from "./real-ha.js";
import { HomeAssistantRegistryClient } from "./home-assistant-registry.js";
import { PersistentDeviceEventLedger } from "./events.js";

function parseEntityAllowlist(value) {
  if (!value?.trim()) return undefined;
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseConfirmationRequiredEntityIds(value) {
  if (!value?.trim()) return undefined;
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function createHomeAssistantBackend({ env = process.env, fetchImpl } = {}) {
  const backend = (env.DEVICE_MANAGER_BACKEND ?? "mock").trim().toLowerCase();

  if (backend === "mock") return new MockHomeAssistant();
  if (["home-assistant", "home_assistant", "ha", "real"].includes(backend)) {
    const registryClient = ["false", "0", "off"].includes((env.HA_REGISTRY_ENRICHMENT ?? "true").trim().toLowerCase())
      ? null
      : new HomeAssistantRegistryClient({ baseUrl: env.HA_URL, token: env.HA_TOKEN });
    const eventLedgerPath = env.DEVICE_MANAGER_EVENT_LEDGER_PATH?.trim();
    return new RealHomeAssistant({
      baseUrl: env.HA_URL,
      token: env.HA_TOKEN,
      entityAllowlist: parseEntityAllowlist(env.HA_ENTITY_ALLOWLIST),
      confirmationRequiredEntityIds: parseConfirmationRequiredEntityIds(env.HA_CONFIRMATION_REQUIRED_ENTITIES),
      fetchImpl,
      registryClient,
      ...(eventLedgerPath ? { eventLedger: new PersistentDeviceEventLedger({ filePath: eventLedgerPath }) } : {}),
    });
  }

  throw new Error(`不支持的 DEVICE_MANAGER_BACKEND：${backend}；可选值为 mock 或 home-assistant`);
}
