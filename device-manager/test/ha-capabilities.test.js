import assert from "node:assert/strict";
import test from "node:test";

import { discoverHomeAssistantCapabilities } from "../src/ha-capabilities.js";
import { RealHomeAssistant } from "../src/real-ha.js";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function entity(entity_id, state, attributes = {}) {
  return { entity_id, state, attributes, last_updated: "2026-10-10T00:00:00Z" };
}

test("灯的亮度能力按 supported_color_modes 判断，onoff-only 不暴露亮度控制", () => {
  const onOffOnly = discoverHomeAssistantCapabilities(entity("light.hall", "off", {
    supported_color_modes: ["onoff"],
  }));
  assert.equal(onOffOnly.actions.turn_on.supported, true);
  assert.equal(onOffOnly.actions.turn_off.supported, true);
  assert.equal(onOffOnly.actions.set_brightness.supported, false);

  const dimmable = discoverHomeAssistantCapabilities(entity("light.study", "on", {
    supported_color_modes: ["brightness"],
  }));
  assert.equal(dimmable.actions.set_brightness.supported, true);
});

test("空调和窗帘按 supported_features 位标记解码，未知信息不被猜成不支持", () => {
  const climate = discoverHomeAssistantCapabilities(entity("climate.room", "cool", {
    supported_features: 1 | 512 | 1024,
  }));
  assert.equal(climate.actions.set_temperature.supported, true);
  assert.equal(climate.actions.turn_off.supported, true);
  assert.equal(climate.actions.turn_on.supported, true);

  const cover = discoverHomeAssistantCapabilities(entity("cover.window", "closed", {
    supported_features: 1 | 4,
  }));
  assert.equal(cover.actions.open.supported, true);
  assert.equal(cover.actions.close.supported, false);
  assert.equal(cover.actions.set_position.supported, true);

  const incomplete = discoverHomeAssistantCapabilities(entity("cover.legacy", "open", {}));
  assert.equal(incomplete.actions.close.supported, null);
});

test("实时 HA 明确报告不支持的动作时，控制前拦截且 canonical 能力不再虚报", async () => {
  let serviceCalls = 0;
  const current = entity("light.hall", "off", {
    friendly_name: "走廊灯",
    supported_color_modes: ["onoff"],
  });
  const client = new RealHomeAssistant({
    baseUrl: "http://ha.local:8123",
    token: "test-token",
    fetchImpl: async (url, options = {}) => {
      if (new URL(url).pathname === "/api/states/light.hall") return jsonResponse(current);
      if (options.method === "POST") serviceCalls += 1;
      return jsonResponse([]);
    },
  });

  const denied = await client.controlDevice({
    device_id: "light.hall",
    action: "set_brightness",
    parameters: { brightness: 40 },
  });
  assert.equal(denied.success, false);
  assert.equal(denied.error.code, "UNSUPPORTED_ACTION");
  assert.match(denied.error.capability_evidence, /supported_color_modes=onoff/);
  assert.equal(serviceCalls, 0);

  const canonical = await client.getState({ device_id: "light.hall", canonical: true });
  assert.ok(canonical.device.capabilities.actions.turn_on);
  assert.equal(canonical.device.capabilities.actions.set_brightness, undefined);
});

test("个性化场景预检所有动作能力，发现不支持时不执行场景前面的步骤", async () => {
  const states = {
    "light.living_room": entity("light.living_room", "on", {
      brightness: 255,
      supported_color_modes: ["brightness"],
    }),
    // OPEN only; the sleep scene also needs CLOSE.
    "cover.living_room_curtain": entity("cover.living_room_curtain", "open", {
      current_position: 100,
      supported_features: 1,
    }),
    "climate.bedroom": entity("climate.bedroom", "off", {
      temperature: 26,
      min_temp: 16,
      max_temp: 30,
    }),
  };
  let serviceCalls = 0;
  const client = new RealHomeAssistant({
    baseUrl: "http://ha.local:8123",
    token: "test-token",
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname.startsWith("/api/states/")) {
        const deviceId = decodeURIComponent(parsed.pathname.slice("/api/states/".length));
        return jsonResponse(states[deviceId]);
      }
      if (options.method === "POST") serviceCalls += 1;
      return jsonResponse([]);
    },
  });

  const result = await client.runScene({ scene_id: "sleep" });
  assert.equal(result.success, false);
  assert.equal(result.error.code, "SCENE_PREFLIGHT_FAILED");
  assert.equal(result.error.cause, "UNSUPPORTED_ACTION");
  assert.equal(result.error.device_id, "cover.living_room_curtain");
  assert.equal(serviceCalls, 0);
});

test("家庭设备清单持久化最近能力快照及其采集时间", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DeviceInventory } = await import("../src/device-inventory.js");
  const directory = mkdtempSync(join(tmpdir(), "lt-ha-capability-inventory-"));
  try {
    const capabilities = discoverHomeAssistantCapabilities(entity("light.study", "on", {
      supported_color_modes: ["brightness"],
    }));
    const inventory = new DeviceInventory({
      filePath: join(directory, "inventory.json"),
      clock: () => Date.parse("2026-10-10T00:00:00Z"),
      deviceClient: {
        listDevices: () => ({
          success: true,
          registry_enrichment: { status: "available" },
          devices: [{
            device_id: "light.study",
            name: "书房灯",
            domain: "light",
            state: "on",
            available: true,
            attributes: {},
            capabilities,
          }],
        }),
      },
    });
    const scan = await inventory.discover();
    assert.equal(scan.devices[0].current_capabilities.actions.set_brightness.supported, true);
    const saved = JSON.parse(readFileSync(join(directory, "inventory.json"), "utf8"));
    assert.equal(saved.devices[0].capability_snapshot.actions.set_brightness.supported, true);
    assert.equal(saved.devices[0].capabilities_last_seen_at, "2026-10-10T00:00:00.000Z");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
