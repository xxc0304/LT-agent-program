import assert from "node:assert/strict";
import test from "node:test";

import { HomeAssistantRegistryClient, enrichEntitiesWithRegistries } from "../src/home-assistant-registry.js";
import { RealHomeAssistant } from "../src/real-ha.js";

function response(data) {
  return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
}

function sampleRegistries() {
  return {
    devices: [{
      id: "ha-device-1",
      area_id: "area-1",
      name: "Desk Lamp",
      name_by_user: "书桌灯设备",
      manufacturer: "Example",
      model: "L1",
    }],
    entities: [
      { entity_id: "light.study_desk", unique_id: "unique-lamp", device_id: "ha-device-1", area_id: null },
      { entity_id: "light.study_desk_disabled", unique_id: "disabled-lamp", device_id: "ha-device-1", disabled_by: "user" },
    ],
    areas: [{ area_id: "area-1", name: "书房" }],
  };
}

class FakeWebSocket {
  static replies = sampleRegistries();
  static failAuth = false;
  static silent = false;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.listeners = new Map();
    this.sent = [];
    FakeWebSocket.instances.push(this);
    if (!FakeWebSocket.silent) queueMicrotask(() => this.#emit("message", { data: JSON.stringify({ type: "auth_required" }) }));
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }

  send(value) {
    const message = JSON.parse(value);
    this.sent.push(message);
    if (message.type === "auth") {
      queueMicrotask(() => this.#emit("message", { data: JSON.stringify(FakeWebSocket.failAuth
        ? { type: "auth_invalid", message: "invalid" }
        : { type: "auth_ok", ha_version: "test" }) }));
      return;
    }
    if (message.id) {
      const registryName = message.type.includes("device_registry")
        ? "devices"
        : message.type.includes("entity_registry") ? "entities" : "areas";
      queueMicrotask(() => this.#emit("message", { data: JSON.stringify({
        id: message.id,
        type: "result",
        success: true,
        result: FakeWebSocket.replies[registryName],
      }) }));
    }
  }

  close() { this.readyState = 3; }

  #emit(name, event) {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

test("HA WebSocket 注册表客户端按协议认证并顺序读取 device/entity/area registry", async () => {
  FakeWebSocket.failAuth = false;
  FakeWebSocket.silent = false;
  FakeWebSocket.instances = [];
  const client = new HomeAssistantRegistryClient({
    baseUrl: "https://ha.example.test/",
    token: "test-secret-token",
    WebSocketImpl: FakeWebSocket,
  });

  const result = await client.listRegistries();
  assert.equal(result.success, true);
  assert.deepEqual(Object.keys(result.registries), ["devices", "entities", "areas"]);
  assert.equal(FakeWebSocket.instances[0].url, "wss://ha.example.test/api/websocket");
  assert.equal(FakeWebSocket.instances[0].sent[0].type, "auth");
  assert.equal(FakeWebSocket.instances[0].sent[0].access_token, "test-secret-token");
  assert.deepEqual(FakeWebSocket.instances[0].sent.slice(1).map((item) => item.type), [
    "config/device_registry/list",
    "config/entity_registry/list",
    "config/area_registry/list",
  ]);
  assert.equal(FakeWebSocket.instances[0].url.includes("test-secret-token"), false);
});

test("短期缓存避免每次设备清单刷新都重复读取 HA Registry", async () => {
  FakeWebSocket.failAuth = false;
  FakeWebSocket.silent = false;
  FakeWebSocket.instances = [];
  const client = new HomeAssistantRegistryClient({
    baseUrl: "http://ha.local:8123",
    token: "test-token",
    WebSocketImpl: FakeWebSocket,
  });
  const first = await client.listRegistries();
  const second = await client.listRegistries();
  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(FakeWebSocket.instances.length, 1);
});

test("HA entity registry join 同步物理设备与房间，并过滤 disabled_by 实体", () => {
  const entities = [
    { entity_id: "light.study_desk", state: "on", attributes: { friendly_name: "台灯" } },
    { entity_id: "light.study_desk_disabled", state: "off", attributes: { friendly_name: "已禁用灯" } },
  ];
  const result = enrichEntitiesWithRegistries(entities, sampleRegistries());
  assert.equal(result.disabled_entity_count, 1);
  assert.equal(result.devices.length, 1);
  assert.deepEqual({
    ha_device_id: result.devices[0].ha_device_id,
    ha_entity_unique_id: result.devices[0].ha_entity_unique_id,
    ha_area_id: result.devices[0].ha_area_id,
    area_name: result.devices[0].area_name,
    source_device_name: result.devices[0].source_device_name,
    manufacturer: result.devices[0].manufacturer,
    model: result.devices[0].model,
  }, {
    ha_device_id: "ha-device-1",
    ha_entity_unique_id: "unique-lamp",
    ha_area_id: "area-1",
    area_name: "书房",
    source_device_name: "书桌灯设备",
    manufacturer: "Example",
    model: "L1",
  });
});

test("WebSocket 认证或查询失败返回安全的 fallback 错误，不含令牌", async () => {
  FakeWebSocket.failAuth = true;
  FakeWebSocket.silent = false;
  const client = new HomeAssistantRegistryClient({
    baseUrl: "http://ha.local:8123",
    token: "secret-do-not-print",
    WebSocketImpl: FakeWebSocket,
  });

  const result = await client.listRegistries();
  assert.equal(result.success, false);
  assert.equal(result.error.code, "HA_AUTHENTICATION_FAILED");
  assert.equal(JSON.stringify(result).includes("secret-do-not-print"), false);
  FakeWebSocket.failAuth = false;
});

test("真实 HA REST 清单合并注册表并过滤禁用实体；注册表失败时 REST fallback 成功", async () => {
  const fetchImpl = async () => response([
    { entity_id: "light.study_desk", state: "on", attributes: { friendly_name: "台灯" } },
    { entity_id: "light.study_desk_disabled", state: "off", attributes: { friendly_name: "已禁用灯" } },
  ]);
  const client = new RealHomeAssistant({
    baseUrl: "http://ha.local:8123",
    token: "test-token",
    fetchImpl,
    registryClient: { listRegistries: async () => ({ success: true, registries: sampleRegistries() }) },
  });
  const enriched = await client.listDevices();
  assert.equal(enriched.success, true);
  assert.equal(enriched.count, 1);
  assert.equal(enriched.registry_enrichment.status, "available");
  assert.equal(enriched.disabled_entity_count, 1);
  assert.equal(enriched.devices[0].ha_device_id, "ha-device-1");
  assert.equal(enriched.devices[0].area_name, "书房");

  const fallbackClient = new RealHomeAssistant({
    baseUrl: "http://ha.local:8123",
    token: "test-token",
    fetchImpl,
    registryClient: { listRegistries: async () => ({
      success: false,
      error: { code: "HA_WEBSOCKET_TIMEOUT", message: "test fallback" },
    }) },
  });
  const fallback = await fallbackClient.listDevices();
  assert.equal(fallback.success, true);
  assert.equal(fallback.count, 2);
  assert.equal(fallback.registry_enrichment.status, "unavailable");
  assert.equal(fallback.devices[0].ha_device_id, undefined);
});

test("注册表响应超时明确降级，不会挂起清单调用", async () => {
  FakeWebSocket.silent = true;
  const client = new HomeAssistantRegistryClient({
    baseUrl: "http://ha.local:8123",
    token: "test-token",
    WebSocketImpl: FakeWebSocket,
    timeoutMs: 10,
  });
  const result = await client.listRegistries();
  assert.equal(result.success, false);
  assert.equal(result.error.code, "HA_WEBSOCKET_TIMEOUT");
  FakeWebSocket.silent = false;
});
