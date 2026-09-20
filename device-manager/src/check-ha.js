import { RealHomeAssistant } from "./real-ha.js";

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
    devices: result.devices.map(({ device_id, name, domain, state, available }) => ({
      device_id,
      name,
      domain,
      state,
      available,
    })),
  }, null, 2));
}

await main();
