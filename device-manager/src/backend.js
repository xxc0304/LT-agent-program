import { MockHomeAssistant } from "./mock-ha.js";
import { RealHomeAssistant } from "./real-ha.js";

function parseEntityAllowlist(value) {
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
    return new RealHomeAssistant({
      baseUrl: env.HA_URL,
      token: env.HA_TOKEN,
      entityAllowlist: parseEntityAllowlist(env.HA_ENTITY_ALLOWLIST),
      fetchImpl,
    });
  }

  throw new Error(`不支持的 DEVICE_MANAGER_BACKEND：${backend}；可选值为 mock 或 home-assistant`);
}
