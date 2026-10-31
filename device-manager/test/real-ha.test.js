import assert from "node:assert/strict";
import test from "node:test";

import { createHomeAssistantBackend } from "../src/backend.js";
import { MockHomeAssistant } from "../src/mock-ha.js";
import { RealHomeAssistant } from "../src/real-ha.js";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function entity(entity_id, state, attributes = {}) {
  return {
    entity_id,
    state,
    attributes,
    last_changed: "2026-09-17T00:00:00Z",
    last_updated: "2026-09-17T00:00:00Z",
  };
}

test("后端工厂默认使用 Mock，真实模式缺少配置时明确报错", () => {
  const mock = createHomeAssistantBackend({ env: {} });
  assert.ok(mock instanceof MockHomeAssistant);

  assert.throws(
    () => createHomeAssistantBackend({ env: { DEVICE_MANAGER_BACKEND: "home-assistant" } }),
    /HA_URL/,
  );
});

test("后端工厂将高风险实体环境变量传入真实 HA 适配器", async () => {
  const backend = createHomeAssistantBackend({
    env: {
      DEVICE_MANAGER_BACKEND: "home-assistant",
      HA_URL: "http://ha.local:8123",
      HA_TOKEN: "test-token",
      HA_REGISTRY_ENRICHMENT: "false",
      HA_CONFIRMATION_REQUIRED_ENTITIES: "switch.heater, climate.boiler",
    },
    fetchImpl: async () => jsonResponse([
      entity("switch.heater", "off", { friendly_name: "取暖器" }),
      entity("climate.boiler", "off", { friendly_name: "热水器" }),
    ]),
  });

  const result = await backend.listDevices();
  assert.equal(result.devices.find((device) => device.device_id === "switch.heater").requires_confirmation, true);
  assert.equal(result.devices.find((device) => device.device_id === "climate.boiler").requires_confirmation, true);
});

test("真实 HA 会清理地址中的用户信息，避免出现在事件来源里", () => {
  const client = new RealHomeAssistant({
    baseUrl: "http://user:password@ha.local:8123/",
    token: "test-token",
    fetchImpl: async () => jsonResponse([]),
  });
  assert.equal(client.baseUrl, "http://ha.local:8123");
  assert.equal(JSON.stringify(client).includes("password"), false);
});

test("真实 HA 可以列出允许的设备并归一化状态", async () => {
  let authorization;
  const fetchImpl = async (_url, options) => {
    authorization = options.headers.Authorization;
    return jsonResponse([
      entity("light.living_room", "on", { friendly_name: "客厅灯", brightness: 128 }),
      entity("sensor.temperature", "22.5", { friendly_name: "温度", unit_of_measurement: "°C" }),
      entity("automation.hidden", "on", { friendly_name: "自动化" }),
    ]);
  };
  const client = new RealHomeAssistant({
    baseUrl: "http://ha.local:8123/",
    token: "test-token",
    entityAllowlist: ["light.living_room"],
    confirmationRequiredEntityIds: ["light.living_room"],
    fetchImpl,
  });

  const result = await client.listDevices();
  assert.equal(result.success, true);
  assert.equal(result.count, 1);
  assert.equal(result.devices[0].name, "客厅灯");
  assert.equal(result.devices[0].attributes.brightness, 50);
  assert.equal(result.devices[0].requires_confirmation, true);
  assert.equal(authorization, "Bearer test-token");
});

test("真实 HA 可从实体属性读取高风险标记", async () => {
  const client = new RealHomeAssistant({
    baseUrl: "http://ha.local:8123",
    token: "test-token",
    fetchImpl: async () => jsonResponse([
      entity("switch.heater", "off", { friendly_name: "取暖器", risk_level: "high" }),
    ]),
  });

  const result = await client.listDevices();
  assert.equal(result.success, true);
  assert.equal(result.devices[0].attributes.risk_level, "high");
});

test("不在实体允许列表中的设备会在发请求前被拒绝", async () => {
  let called = false;
  const client = new RealHomeAssistant({
    baseUrl: "http://ha.local:8123",
    token: "test-token",
    entityAllowlist: ["light.living_room"],
    fetchImpl: async () => {
      called = true;
      return jsonResponse({});
    },
  });

  const result = await client.getState({ device_id: "lock.front_door" });
  assert.equal(result.success, false);
  assert.equal(result.error.code, "DEVICE_NOT_ALLOWED");
  assert.equal(called, false);
});

test("真实 HA 灯光控制映射到 REST service 并回读验证", async () => {
  let current = entity("light.living_room", "off", {
    friendly_name: "客厅灯",
    brightness: 0,
  });
  let serviceCall;
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === "/api/states/light.living_room") return jsonResponse(current);
    if (path === "/api/services/light/turn_on" && options.method === "POST") {
      serviceCall = JSON.parse(options.body);
      current = entity("light.living_room", "on", {
        friendly_name: "客厅灯",
        brightness: Math.round((serviceCall.brightness_pct / 100) * 255),
      });
      return jsonResponse([]);
    }
    return jsonResponse({ message: "not found" }, 404);
  };
  const client = new RealHomeAssistant({
    baseUrl: "http://ha.local:8123",
    token: "test-token",
    fetchImpl,
  });

  const result = await client.controlDevice({
    device_id: "light.living_room",
    action: "set_brightness",
    parameters: { brightness: 70 },
  });
  assert.equal(result.success, true);
  assert.deepEqual(serviceCall, { entity_id: "light.living_room", brightness_pct: 70 });
  assert.equal(result.old_state, "off");
  assert.equal(result.new_state, "on");
  assert.equal(result.device.attributes.brightness, 70);
  assert.equal(client.getAuditLog().length, 1);
});

test("真实 HA 智能插座控制映射到 switch service 并回读验证", async () => {
  let current = entity("switch.living_room_plug", "off", { friendly_name: "客厅小米插座" });
  let serviceCall;
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === "/api/states/switch.living_room_plug") return jsonResponse(current);
    if (path === "/api/services/switch/turn_on" && options.method === "POST") {
      serviceCall = JSON.parse(options.body);
      current = entity("switch.living_room_plug", "on", { friendly_name: "客厅小米插座" });
      return jsonResponse([]);
    }
    return jsonResponse({ message: "not found" }, 404);
  };
  const client = new RealHomeAssistant({
    baseUrl: "http://ha.local:8123",
    token: "test-token",
    fetchImpl,
  });

  const result = await client.controlDevice({
    device_id: "switch.living_room_plug",
    action: "turn_on",
  });
  assert.equal(result.success, true);
  assert.deepEqual(serviceCall, { entity_id: "switch.living_room_plug" });
  assert.equal(result.old_state, "off");
  assert.equal(result.new_state, "on");
});

test("真实 HA 服务成功但状态未改变时返回回读验证失败并记录事件", async () => {
  const current = entity("light.living_room", "off", {
    friendly_name: "客厅灯",
    brightness: 0,
  });
  let serviceCalls = 0;
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === "/api/states/light.living_room") return jsonResponse(current);
    if (path === "/api/services/light/turn_on" && options.method === "POST") {
      serviceCalls += 1;
      return jsonResponse([]);
    }
    return jsonResponse({ message: "not found" }, 404);
  };
  const client = new RealHomeAssistant({
    baseUrl: "http://ha.local:8123",
    token: "test-token",
    fetchImpl,
  });

  const result = await client.controlDevice({
    device_id: "light.living_room",
    action: "turn_on",
    trace_id: "trace-stale-state-001",
  });
  assert.equal(serviceCalls, 1);
  assert.equal(result.success, false);
  assert.equal(result.error.code, "POST_ACTION_VERIFICATION_FAILED");
  assert.equal(client.getAuditLog().length, 1);
  assert.equal(client.getAuditLog()[0].verified, false);
  assert.equal(client.getEvents()[0].event_type, "action_failed");
  assert.equal(client.getEvents()[0].trace_id, "trace-stale-state-001");
});

test("真实 HA 状态回读超时时返回明确错误并记录失败事件", async () => {
  const fetchImpl = async () => {
    const error = new Error("simulated timeout");
    error.name = "AbortError";
    throw error;
  };
  const client = new RealHomeAssistant({
    baseUrl: "http://ha.local:8123",
    token: "test-token",
    fetchImpl,
    timeoutMs: 10,
  });

  const result = await client.controlDevice({
    device_id: "light.living_room",
    action: "turn_on",
    trace_id: "trace-timeout-001",
  });
  assert.equal(result.success, false);
  assert.equal(result.error.code, "HA_TIMEOUT");
  assert.equal(client.getEvents()[0].event_type, "action_failed");
  assert.equal(client.getEvents()[0].payload.code, "HA_TIMEOUT");
  assert.equal(JSON.stringify(client.getEvents()).includes("test-token"), false);
});

test("真实 HA 门锁锁定和解锁都要求明确确认且不会调用服务", async () => {
  let postCount = 0;
  const fetchImpl = async (url, options) => {
    if (options.method === "POST") postCount += 1;
    const path = new URL(url).pathname;
    if (path === "/api/states/lock.front_door") {
      return jsonResponse(entity("lock.front_door", "locked", { friendly_name: "入户门锁" }));
    }
    return jsonResponse([]);
  };
  const client = new RealHomeAssistant({
    baseUrl: "http://ha.local:8123",
    token: "test-token",
    fetchImpl,
  });

  for (const action of ["lock", "unlock"]) {
    const result = await client.controlDevice({
      device_id: "lock.front_door",
      action,
    });
    assert.equal(result.success, false, action);
    assert.equal(result.error.code, "CONFIRMATION_REQUIRED", action);
  }
  assert.equal(postCount, 0);
});

test("真实 HA 的 confirmed=true 不能绕过解锁强认证门禁", async () => {
  let postCount = 0;
  const client = new RealHomeAssistant({
    baseUrl: "http://ha.local:8123",
    token: "test-token",
    fetchImpl: async (url, options) => {
      if (options.method === "POST") postCount += 1;
      if (new URL(url).pathname === "/api/states/lock.front_door") {
        return jsonResponse(entity("lock.front_door", "locked", { friendly_name: "入户门锁" }));
      }
      return jsonResponse([]);
    },
  });

  const result = await client.controlDevice({
    device_id: "lock.front_door",
    action: "unlock",
    confirmed: true,
  });

  assert.equal(result.success, false);
  assert.equal(result.error.code, "TRUSTED_AUTHENTICATION_REQUIRED");
  assert.equal(postCount, 0);
});

test("真实 HA 只有收到与审批上下文匹配的可信授权后才发送 unlock 服务", async () => {
  let state = "locked";
  let postCount = 0;
  const expectedContext = {
    approval_id: "approval-real-1",
    plan_id: "plan-real-1",
    plan_fingerprint: "b".repeat(64),
    device_id: "lock.front_door",
    action: "unlock",
  };
  const client = new RealHomeAssistant({
    baseUrl: "http://ha.local:8123",
    token: "test-token",
    lockAuthorizationVerifier: {
      verifyLockAuthorization({ proof, expected }) {
        return proof === "valid-internal-proof" && JSON.stringify(expected) === JSON.stringify(expectedContext)
          ? { success: true, subject: "test-user" }
          : { success: false, error: { code: "LOCK_AUTHORIZATION_SCOPE_MISMATCH", message: "scope mismatch" } };
      },
    },
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      if (options.method === "POST") {
        postCount += 1;
        state = "unlocked";
        return jsonResponse({});
      }
      if (path === "/api/states/lock.front_door") {
        return jsonResponse(entity("lock.front_door", state, { friendly_name: "入户门锁" }));
      }
      return jsonResponse([]);
    },
  });

  const result = await client.controlDevice({
    ...expectedContext,
    device_id: "lock.front_door",
    parameters: {},
    confirmed: true,
    lock_authorization_proof: "valid-internal-proof",
    lock_authorization_context: expectedContext,
  });

  assert.equal(result.success, true);
  assert.equal(result.verified, true);
  assert.equal(postCount, 1);
  assert.equal(result.new_state, "unlocked");
  assert.equal(JSON.stringify(client.getAuditLog()).includes("valid-internal-proof"), false);
});

test("真实 HA 对配置清单中的高风险设备控制前要求确认", async () => {
  let postCount = 0;
  const client = new RealHomeAssistant({
    baseUrl: "http://ha.local:8123",
    token: "test-token",
    confirmationRequiredEntityIds: ["switch.heater"],
    fetchImpl: async (url, options) => {
      if (options.method === "POST") postCount += 1;
      if (new URL(url).pathname === "/api/states/switch.heater") {
        return jsonResponse(entity("switch.heater", "off", { friendly_name: "取暖器" }));
      }
      return jsonResponse([]);
    },
  });

  const result = await client.controlDevice({ device_id: "switch.heater", action: "turn_on" });
  assert.equal(result.success, false);
  assert.equal(result.error.code, "CONFIRMATION_REQUIRED");
  assert.equal(postCount, 0);
});

test("真实 HA 认证错误不会暴露令牌", async () => {
  const client = new RealHomeAssistant({
    baseUrl: "http://ha.local:8123",
    token: "secret-test-token",
    fetchImpl: async () => jsonResponse({ message: "Unauthorized" }, 401),
  });

  const result = await client.listDevices();
  assert.equal(result.success, false);
  assert.equal(result.error.code, "HA_AUTHENTICATION_FAILED");
  assert.equal(JSON.stringify(result).includes("secret-test-token"), false);
});

test("真实 HA 诊断异常会带 trace_id 写入事件", async () => {
  const client = new RealHomeAssistant({
    baseUrl: "http://ha.local:8123",
    token: "test-token",
    fetchImpl: async () => jsonResponse(entity("light.living_room", "unavailable", { friendly_name: "客厅灯" })),
  });

  const result = await client.diagnoseDevice({
    device_id: "light.living_room",
    trace_id: "trace-diagnose-real-001",
  });
  assert.equal(result.success, true);
  assert.equal(result.diagnoses[0].status, "offline");
  assert.equal(client.getEvents()[0].event_type, "diagnostic_alert");
  assert.equal(client.getEvents()[0].severity, "warning");
  assert.equal(client.getEvents()[0].trace_id, "trace-diagnose-real-001");
});

test("真实 HA 记录脱敏诊断恢复事件，不包含原始状态或属性", () => {
  const client = new RealHomeAssistant({
    baseUrl: "http://ha.local:8123",
    token: "test-token",
    fetchImpl: async () => jsonResponse([]),
  });

  const event = client.recordDiagnosticRecovery({
    device_id: "light.living_room",
    previous_code: "DEVICE_OFFLINE",
  });

  assert.equal(event.event_type, "diagnostic_recovered");
  assert.equal(event.severity, "info");
  assert.deepEqual(event.payload, {
    previous_code: "DEVICE_OFFLINE",
    summary: "设备当前健康状态已恢复，活动诊断告警已清除。",
  });
  assert.equal(JSON.stringify(event).includes("unavailable"), false);
  assert.equal(JSON.stringify(event).includes("attributes"), false);

  const sharedIncident = client.recordDiagnosticSharedInfrastructure({
    affected_device_count: 4,
    summary: "共同基础设施提示；不包含实体状态或设备属性。",
  });
  assert.equal(sharedIncident.event_type, "diagnostic_shared_infrastructure_suspected");
  assert.equal(sharedIncident.subject.device_id, undefined);
  assert.equal(sharedIncident.severity, "warning");
  assert.deepEqual(sharedIncident.payload, {
    affected_device_count: 4,
    summary: "共同基础设施提示；不包含实体状态或设备属性。",
  });
  const resolved = client.recordDiagnosticSharedInfrastructureResolved({ affected_device_count: 1 });
  assert.equal(resolved.event_type, "diagnostic_shared_infrastructure_cleared");
  assert.equal(resolved.severity, "info");
});

test("真实 HA 场景预检失败时不执行任何控制服务", async () => {
  let postCount = 0;
  const existing = {
    "light.living_room": entity("light.living_room", "off", { brightness: 0 }),
    "cover.living_room_curtain": entity("cover.living_room_curtain", "closed", { current_position: 0 }),
  };
  const fetchImpl = async (url, options) => {
    if (options.method === "POST") postCount += 1;
    const path = decodeURIComponent(new URL(url).pathname);
    const prefix = "/api/states/";
    if (path.startsWith(prefix)) {
      const found = existing[path.slice(prefix.length)];
      return found ? jsonResponse(found) : jsonResponse({ message: "not found" }, 404);
    }
    return jsonResponse([]);
  };
  const client = new RealHomeAssistant({
    baseUrl: "http://ha.local:8123",
    token: "test-token",
    fetchImpl,
  });

  const result = await client.runScene({ scene_id: "home" });
  assert.equal(result.success, false);
  assert.equal(result.error.code, "SCENE_PREFLIGHT_FAILED");
  assert.equal(result.error.cause, "DEVICE_NOT_FOUND");
  assert.equal(postCount, 0);
});

test("真实 HA 执行已确认的个性化场景时使用目标温度并逐项回读", async () => {
  const states = {
    "light.living_room": entity("light.living_room", "on", { brightness: 255 }),
    "cover.living_room_curtain": entity("cover.living_room_curtain", "open", { current_position: 100 }),
    "climate.bedroom": entity("climate.bedroom", "off", {
      temperature: 26,
      min_temp: 16,
      max_temp: 30,
    }),
  };
  const serviceCalls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    const statePrefix = "/api/states/";
    if (parsed.pathname.startsWith(statePrefix)) {
      const deviceId = decodeURIComponent(parsed.pathname.slice(statePrefix.length));
      return states[deviceId] ? jsonResponse(states[deviceId]) : jsonResponse({ message: "not found" }, 404);
    }

    if (parsed.pathname.startsWith("/api/services/") && options.method === "POST") {
      const request = JSON.parse(options.body);
      const service = parsed.pathname.split("/").slice(-2).join("/");
      serviceCalls.push({ service, request });
      const deviceId = request.entity_id;
      const current = states[deviceId];
      if (!current) return jsonResponse({ message: "not found" }, 404);

      if (service === "light/turn_off") {
        states[deviceId] = entity(deviceId, "off", { brightness: 0 });
      } else if (service === "cover/close_cover") {
        states[deviceId] = entity(deviceId, "closed", { current_position: 0 });
      } else if (service === "climate/turn_on") {
        states[deviceId] = entity(deviceId, "cool", current.attributes);
      } else if (service === "climate/set_temperature") {
        states[deviceId] = entity(deviceId, "cool", {
          ...current.attributes,
          temperature: request.temperature,
        });
      } else {
        return jsonResponse({ message: `unexpected service ${service}` }, 400);
      }
      return jsonResponse([]);
    }
    return jsonResponse({ message: "not found" }, 404);
  };
  const client = new RealHomeAssistant({
    baseUrl: "http://ha.local:8123",
    token: "test-token",
    fetchImpl,
  });

  const result = await client.runScene({
    scene_id: "sleep",
    planned_temperature_c: 24,
    task_id: "plan-real-001",
    trace_id: "plan-real-001",
  });

  assert.equal(result.success, true);
  assert.equal(result.planned_temperature_c, 24);
  assert.equal(result.task_id, "plan-real-001");
  assert.ok(result.verification.every((entry) => entry.verified));
  assert.deepEqual(serviceCalls.find((call) => call.service === "climate/set_temperature")?.request, {
    entity_id: "climate.bedroom",
    temperature: 24,
  });
  assert.equal(client.getAuditLog().length, 4);
  assert.ok(client.getAuditLog().every((entry) => entry.task_id === "plan-real-001"));
  assert.equal(client.getEvents().length, 4);
  assert.ok(client.getEvents().every((event) => event.trace_id === "plan-real-001"));
});

test("真实 HA 回家场景使用个性化亮度并逐项回读实际状态", async () => {
  const states = {
    "light.living_room": entity("light.living_room", "off", {
      brightness: 0,
      supported_color_modes: ["brightness"],
    }),
    "cover.living_room_curtain": entity("cover.living_room_curtain", "closed", { current_position: 0 }),
    "climate.bedroom": entity("climate.bedroom", "off", {
      temperature: 26,
      min_temp: 16,
      max_temp: 30,
    }),
  };
  const serviceCalls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith("/api/states/")) {
      const deviceId = decodeURIComponent(parsed.pathname.slice("/api/states/".length));
      return states[deviceId] ? jsonResponse(states[deviceId]) : jsonResponse({ message: "not found" }, 404);
    }
    if (parsed.pathname.startsWith("/api/services/") && options.method === "POST") {
      const request = JSON.parse(options.body);
      const service = parsed.pathname.split("/").slice(-2).join("/");
      serviceCalls.push({ service, request });
      const current = states[request.entity_id];
      if (service === "light/turn_on") {
        states[request.entity_id] = entity(request.entity_id, "on", {
          ...current.attributes,
          brightness: Math.round((request.brightness_pct / 100) * 255),
        });
      } else if (service === "cover/open_cover") {
        states[request.entity_id] = entity(request.entity_id, "open", { current_position: 100 });
      } else if (service === "climate/turn_on") {
        states[request.entity_id] = entity(request.entity_id, "cool", current.attributes);
      } else if (service === "climate/set_temperature") {
        states[request.entity_id] = entity(request.entity_id, "cool", {
          ...current.attributes,
          temperature: request.temperature,
        });
      } else {
        return jsonResponse({ message: `unexpected service ${service}` }, 400);
      }
      return jsonResponse([]);
    }
    return jsonResponse({ message: "not found" }, 404);
  };
  const client = new RealHomeAssistant({
    baseUrl: "http://ha.local:8123",
    token: "test-token",
    fetchImpl,
  });

  const result = await client.runScene({
    scene_id: "home",
    planned_brightness_pct: 65,
    task_id: "plan-real-brightness-001",
    trace_id: "plan-real-brightness-001",
  });

  assert.equal(result.success, true);
  assert.equal(result.planned_brightness_pct, 65);
  assert.ok(result.verification.every((entry) => entry.verified));
  assert.deepEqual(serviceCalls.find((call) => call.service === "light/turn_on")?.request, {
    entity_id: "light.living_room",
    brightness_pct: 65,
  });
  assert.equal(client.getAuditLog().length, 4);
  assert.ok(client.getAuditLog().every((entry) => entry.task_id === "plan-real-brightness-001"));
});

test("真实 HA 个性化亮度在能力不支持时预检失败且不调用任何控制服务", async () => {
  let postCount = 0;
  const states = {
    "light.living_room": entity("light.living_room", "off", { supported_color_modes: ["onoff"] }),
    "cover.living_room_curtain": entity("cover.living_room_curtain", "closed", { current_position: 0 }),
    "climate.bedroom": entity("climate.bedroom", "off", { temperature: 26, min_temp: 16, max_temp: 30 }),
  };
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith("/api/states/")) {
      const deviceId = decodeURIComponent(parsed.pathname.slice("/api/states/".length));
      return states[deviceId] ? jsonResponse(states[deviceId]) : jsonResponse({ message: "not found" }, 404);
    }
    if (options.method === "POST") postCount += 1;
    return jsonResponse([]);
  };
  const client = new RealHomeAssistant({ baseUrl: "http://ha.local:8123", token: "test-token", fetchImpl });

  const result = await client.runScene({ scene_id: "home", planned_brightness_pct: 65 });

  assert.equal(result.success, false);
  assert.equal(result.error.code, "SCENE_PREFLIGHT_FAILED");
  assert.equal(result.error.cause, "DEVICE_ACTION_UNSUPPORTED");
  assert.equal(result.error.device_id, "light.living_room");
  assert.equal(postCount, 0);
});

test("真实 HA 个性化温度在预检时越界则不调用任何控制服务", async () => {
  let postCount = 0;
  const states = {
    "light.living_room": entity("light.living_room", "on", { brightness: 255 }),
    "cover.living_room_curtain": entity("cover.living_room_curtain", "open", { current_position: 100 }),
    "climate.bedroom": entity("climate.bedroom", "off", {
      temperature: 26,
      min_temp: 25,
      max_temp: 30,
    }),
  };
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    const prefix = "/api/states/";
    if (parsed.pathname.startsWith(prefix)) {
      const deviceId = decodeURIComponent(parsed.pathname.slice(prefix.length));
      return states[deviceId] ? jsonResponse(states[deviceId]) : jsonResponse({ message: "not found" }, 404);
    }
    if (options.method === "POST") postCount += 1;
    return jsonResponse([]);
  };
  const client = new RealHomeAssistant({
    baseUrl: "http://ha.local:8123",
    token: "test-token",
    fetchImpl,
  });

  const result = await client.runScene({ scene_id: "sleep", planned_temperature_c: 24 });

  assert.equal(result.success, false);
  assert.equal(result.error.code, "SCENE_PREFLIGHT_FAILED");
  assert.equal(result.error.cause, "PREFERENCE_OUTSIDE_DEVICE_RANGE");
  assert.equal(postCount, 0);
  assert.equal(client.getAuditLog().length, 0);
});
