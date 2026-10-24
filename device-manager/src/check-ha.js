import { RealHomeAssistant } from "./real-ha.js";
import { HomeAssistantRegistryClient } from "./home-assistant-registry.js";

function parseEntityAllowlist(value) {
  if (!value?.trim()) return undefined;
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

async function main() {
  if (!process.env.HA_URL || !process.env.HA_TOKEN) {
    console.error("缺少配置：请先设置 HA_URL 和 HA_TOKEN。令牌不会被本脚本输出。");
    process.exitCode = 1;
    return;
  }

  const client = new RealHomeAssistant({
    baseUrl: process.env.HA_URL,
    token: process.env.HA_TOKEN,
    entityAllowlist: parseEntityAllowlist(process.env.HA_ENTITY_ALLOWLIST),
    confirmationRequiredEntityIds: parseEntityAllowlist(process.env.HA_CONFIRMATION_REQUIRED_ENTITIES),
    registryClient: process.env.HA_REGISTRY_ENRICHMENT === "false"
      ? null
      : new HomeAssistantRegistryClient({ baseUrl: process.env.HA_URL, token: process.env.HA_TOKEN }),
  });
  const result = await client.listDevices();
  if (!result.success) {
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({
    status: "PASS",
    backend: "Home Assistant REST API",
    device_count: result.count,
  registry_enrichment: result.registry_enrichment,
  disabled_entity_count: result.disabled_entity_count ?? 0,
  physical_device_count: new Set(result.devices.map((device) => device.ha_device_id).filter(Boolean)).size,
  devices: result.devices.map(({
    device_id,
    name,
    domain,
    state,
    available,
    ha_device_id,
    ha_area_id,
    area_name,
    source_device_name,
    manufacturer,
    model,
    capabilities,
  }) => ({
      device_id,
      name,
      domain,
      state,
      available,
    ...(ha_device_id ? { ha_device_id } : {}),
    ...(ha_area_id ? { ha_area_id } : {}),
    ...(area_name ? { area_name } : {}),
    ...(source_device_name ? { source_device_name } : {}),
    ...(manufacturer ? { manufacturer } : {}),
    ...(model ? { model } : {}),
    ...(capabilities ? { capabilities } : {}),
    })),
  }, null, 2));
}

await main();
