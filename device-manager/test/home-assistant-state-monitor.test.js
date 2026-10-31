import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PreferenceMemoryStore } from "../../agent-memory/src/memory-store.js";
import { createHomeAssistantDeviceActionObserver } from "../../agent-memory/src/home-assistant-device-action-observer.js";
import { HomeAssistantStateMonitor, summarizeDirectUserServiceActions } from "../src/home-assistant-state-monitor.js";
import { createHouseholdDeviceMonitorTools } from "../src/device-monitor-tools.js";
import { DeviceInventory } from "../src/device-inventory.js";
import { RealHomeAssistant } from "../src/real-ha.js";

class FakeMonitorWebSocket {
  static instances = [];
  static authInvalid = false;

  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.listeners = new Map();
    this.sent = [];
    FakeMonitorWebSocket.instances.push(this);
    queueMicrotask(() => this.emit("message", { data: JSON.stringify({ type: "auth_required" }) }));
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
      queueMicrotask(() => this.emit("message", { data: JSON.stringify(FakeMonitorWebSocket.authInvalid
        ? { type: "auth_invalid" }
        : { type: "auth_ok" }) }));
    } else if (message.type === "subscribe_events") {
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ id: message.id, type: "result", success: true, result: { id: message.id } }) }));
    }
  }

  close() {
    this.readyState = 3;
    this.emit("close", {});
  }

  emit(name, event) {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

function makeMonitor(options = {}) {
  FakeMonitorWebSocket.instances = [];
  FakeMonitorWebSocket.authInvalid = false;
  return new HomeAssistantStateMonitor({
    baseUrl: "https://ha.example.test/ha",
    token: "never-print-this-token",
    WebSocketImpl: FakeMonitorWebSocket,
    timeoutMs: 100,
    reconnectBaseMs: 5,
    reconnectMaxMs: 10,
    ...options,
  });
}

async function waitForCondition(predicate, description, { timeoutMs = 1500, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

test("只订阅 HA state_changed 并向回调发送脱敏变化摘要", async () => {
  const changes = [];
  const monitor = makeMonitor({ onStateChange: (event) => changes.push(event) });
  const started = await monitor.start();
  assert.equal(started.success, true);
  assert.equal(started.connection_state, "connected");

  const socket = FakeMonitorWebSocket.instances[0];
  assert.equal(socket.url, "wss://ha.example.test/ha/api/websocket");
  assert.deepEqual(socket.sent.map((message) => message.type), ["auth", "subscribe_events"]);
  assert.equal(socket.sent[1].event_type, "state_changed");
  socket.emit("message", { data: JSON.stringify({
    id: socket.sent[1].id,
    type: "event",
    event: {
      event_type: "state_changed",
      time_fired: "2026-10-10T01:02:03Z",
      data: {
        entity_id: "light.study",
        old_state: { state: "on", attributes: { brightness: 100, supported_color_modes: ["brightness"], private_note: "do-not-forward" } },
        new_state: { state: "unavailable", attributes: { supported_color_modes: ["onoff"], private_note: "also-private" } },
      },
    },
  }) });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], {
    device_id: "light.study",
    domain: "light",
    change_type: "state_changed",
    state_changed: true,
    availability_changed: true,
    previous_available: true,
    available: false,
    capability_changes: [{ action: "set_brightness", previous: true, current: false }],
    occurred_at: "2026-10-10T01:02:03Z",
  });
  assert.equal(JSON.stringify(changes).includes("private_note"), false);
  assert.equal(JSON.stringify(monitor.status()).includes("never-print-this-token"), false);
  monitor.stop();
});

test("只把 HA 顶层已登录用户的温度/亮度服务调用转成脱敏学习事件", () => {
  const source = {
    event_type: "call_service",
    time_fired: "2026-10-10T01:02:03Z",
    context: { id: "context-123", user_id: "sensitive-user-id", parent_id: null },
    data: {
      domain: "climate",
      service: "set_temperature",
      service_data: { entity_id: "climate.bedroom", temperature: 24, private_text: "do-not-forward" },
    },
  };
  const [action] = summarizeDirectUserServiceActions(source, { trustedUserIds: ["sensitive-user-id"] });
  assert.equal(action.event_type, "ha_user_service_action");
  assert.equal(action.trusted_source, "ha_call_service_context");
  assert.equal(action.entity_id, "climate.bedroom");
  assert.equal(action.value, 24);
  assert.equal(action.actor_source, "user_manual");
  assert.match(action.event_id, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(action).includes("sensitive-user-id"), false);
  assert.equal(JSON.stringify(action).includes("context-123"), false);
  assert.equal(JSON.stringify(action).includes("private_text"), false);

  assert.deepEqual(summarizeDirectUserServiceActions(source), [], "未配置用户白名单时不信任 HA 用户上下文");
  assert.deepEqual(summarizeDirectUserServiceActions({
    ...source,
    context: { ...source.context, parent_id: "parent-call" },
  }, { trustedUserIds: ["sensitive-user-id"] }), [], "有父调用的 automation/agent 链路必须失败关闭");
  assert.deepEqual(summarizeDirectUserServiceActions({
    ...source,
    context: { id: "context-automation", user_id: null, parent_id: null },
  }, { trustedUserIds: ["sensitive-user-id"] }), [], "没有认证用户上下文的变化不得作为人工偏好样本");
  assert.deepEqual(summarizeDirectUserServiceActions({
    ...source,
    data: { domain: "climate", service: "turn_on", service_data: { entity_id: "climate.bedroom" } },
  }, { trustedUserIds: ["sensitive-user-id"] }), [], "只观察明确设值的服务，不把开关机动作推断为舒适偏好");
});

test("HA 状态监测仅在配置白名单用户后订阅 call_service，并发送安全摘要", async () => {
  const actions = [];
  const monitor = makeMonitor({ onUserAction: (event) => actions.push(event), trustedUserIds: ["private-user"] });
  const started = await monitor.start();
  assert.equal(started.success, true);
  const socket = FakeMonitorWebSocket.instances[0];
  const subscriptions = socket.sent.filter((message) => message.type === "subscribe_events");
  assert.deepEqual(subscriptions.map((message) => message.event_type), ["state_changed", "call_service"]);
  const callServiceSubscription = subscriptions.find((message) => message.event_type === "call_service");
  socket.emit("message", { data: JSON.stringify({
    id: callServiceSubscription.id,
    type: "event",
    event: {
      event_type: "call_service",
      time_fired: "2026-10-10T01:02:03Z",
      context: { id: "private-context", user_id: "private-user", parent_id: null },
      data: { domain: "light", service: "turn_on", service_data: { entity_id: "light.study", brightness_pct: 65, label: "private" } },
    },
  }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(actions.length, 1);
  assert.equal(actions[0].value, 65);
  assert.equal(actions[0].entity_id, "light.study");
  assert.equal(JSON.stringify(actions).includes("private-user"), false);
  assert.equal(JSON.stringify(actions).includes("private-context"), false);
  assert.equal(JSON.stringify(actions).includes("private"), false);
  monitor.setUserActionObserver(null);
  assert.equal(socket.sent.some((message) => message.type === "unsubscribe_events"
    && message.subscription === callServiceSubscription.id), true,
  "撤回授权后应立即取消 call_service 订阅");
  monitor.stop();

  const noAllowlistMonitor = makeMonitor({ onUserAction: () => {} });
  assert.equal((await noAllowlistMonitor.start()).success, true);
  const noAllowlistSubscriptions = FakeMonitorWebSocket.instances[0].sent
    .filter((message) => message.type === "subscribe_events")
    .map((message) => message.event_type);
  assert.deepEqual(noAllowlistSubscriptions, ["state_changed"]);
  noAllowlistMonitor.stop();
});

test("Mock HA WebSocket 到本地记忆候选端到端闭环只记重复手动温度并等待确认", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lt-ha-memory-pipeline-"));
  try {
    const store = new PreferenceMemoryStore({ filePath: join(directory, "memory.json") });
    await store.setDeviceActionObservationConsent({ enabled: true, user_explicit_confirmation: true });
    const observer = createHomeAssistantDeviceActionObserver({
      store,
      timeZone: "Asia/Shanghai",
      deviceInventory: { list: () => ({ success: true, devices: [{
        device_id: "climate.bedroom",
        domain: "climate",
        approval_status: "approved",
        area_confirmed: true,
        area_id: "bedroom",
      }] }) },
    });
    const observed = [];
    const monitor = makeMonitor({
      onUserAction: async (event) => observed.push(await observer.observe(event)),
      trustedUserIds: ["user-0", "user-1", "user-2"],
    });
    assert.equal((await monitor.start()).success, true);
    const socket = FakeMonitorWebSocket.instances[0];
    const subscription = socket.sent.find((message) => message.type === "subscribe_events" && message.event_type === "call_service");
    for (const [index, day] of ["2026-09-20", "2026-09-21", "2026-09-22"].entries()) {
      socket.emit("message", { data: JSON.stringify({
        id: subscription.id,
        type: "event",
        event: {
          event_type: "call_service",
          time_fired: `${day}T16:00:00Z`,
          context: { id: `context-${index}`, user_id: `user-${index}`, parent_id: null },
          data: { domain: "climate", service: "set_temperature", service_data: { entity_id: "climate.bedroom", temperature: 24 } },
        },
      }) });
      const deadline = Date.now() + 1_000;
      while (observed.length <= index && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    assert.equal(observed.length, 3, JSON.stringify(observed));
    const [candidate] = await store.listMemories({ includePending: true });
    assert.equal(candidate.status, "pending_confirmation");
    assert.deepEqual(candidate.evidence_dates, ["2026-09-21", "2026-09-22", "2026-09-23"]);
    assert.equal(await store.getPreference({ memory_type: "comfort_temperature_c", room_id: "bedroom" }), null);
    await store.confirmCandidate(candidate.memory_id, { user_confirmed: true });
    assert.equal((await store.getPreference({ memory_type: "comfort_temperature_c", room_id: "bedroom" })).value, 24);
    const savedJson = await import("node:fs/promises").then(({ readFile }) => readFile(join(directory, "memory.json"), "utf8"));
    assert.equal(savedJson.includes("user-0"), false);
    assert.equal(savedJson.includes("context-0"), false);
    assert.equal(savedJson.includes("climate.bedroom"), false);
    monitor.stop();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("连接断开后有限速重连，停止后不再重连", async () => {
  const monitor = makeMonitor();
  assert.equal((await monitor.start()).success, true);
  FakeMonitorWebSocket.instances[0].close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(FakeMonitorWebSocket.instances.length, 2);
  assert.equal(monitor.status().connection_state, "connected");

  monitor.stop();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(FakeMonitorWebSocket.instances.length, 2);
  assert.equal(monitor.status().connection_state, "stopped");
});

test("认证失败是致命错误，不会无限重连且不会泄露令牌", async () => {
  const monitor = makeMonitor();
  FakeMonitorWebSocket.authInvalid = true;
  const result = await monitor.start();
  assert.equal(result.success, false);
  assert.equal(result.monitoring, false);
  assert.equal(result.last_error_code, "HA_AUTHENTICATION_FAILED");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(FakeMonitorWebSocket.instances.length, 1);
  assert.equal(JSON.stringify(result).includes("never-print-this-token"), false);
  monitor.stop();
  FakeMonitorWebSocket.authInvalid = false;
});

test("设备事件突发会合并成一次清单刷新，监测状态不含原始状态值", async () => {
  let callback;
  let scanCount = 0;
  let monitorRunning = false;
  const tools = createHouseholdDeviceMonitorTools({
    deviceInventory: { discover: async () => {
      scanCount += 1;
      return { success: true, scanned_at: `scan-${scanCount}`, discovered_count: 2, newly_discovered_count: 0, missing_count: 0 };
    } },
    createMonitor: (options) => {
      callback = options.onStateChange;
      return {
        async start() { monitorRunning = true; return { success: true, monitoring: true, connection_state: "connected" }; },
        stop() { monitorRunning = false; return { success: true, monitoring: false, connection_state: "stopped" }; },
        status() { return { monitoring: monitorRunning, connection_state: monitorRunning ? "connected" : "stopped" }; },
      };
    },
    debounceMs: 5,
  });

  const started = await tools.start_household_device_monitor();
  assert.equal(started.success, true);
  assert.equal(scanCount, 1);
  callback({ device_id: "light.a", domain: "light", change_type: "state_changed", state_changed: true, available: true, old_state: "on", new_state: "off" });
  callback({ device_id: "light.b", domain: "light", change_type: "state_changed", state_changed: true, available: true, old_state: "on", new_state: "off" });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(scanCount, 2);
  const status = tools.get_household_device_monitor_status();
  assert.equal(status.last_refresh.event_count, 2);
  assert.equal(JSON.stringify(status).includes("old_state"), false);
  assert.equal(JSON.stringify(status).includes('"on"'), false);
  assert.equal(JSON.stringify(status).includes('"off"'), false);
  assert.equal(tools.stop_household_device_monitor().connection_state, "stopped");
});

test("真实 HA 模拟链路会从 WebSocket 故障事件走到告警、恢复事件和告警清除", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lt-real-ha-monitor-integration-"));
  FakeMonitorWebSocket.instances = [];
  FakeMonitorWebSocket.authInvalid = false;
  let currentState = {
    entity_id: "light.study",
    state: "unavailable",
    attributes: { friendly_name: "书房灯" },
    last_changed: "2026-10-10T00:00:00Z",
    last_updated: "2026-10-10T00:00:00Z",
  };
  let monitorTools;
  try {
    const homeAssistant = new RealHomeAssistant({
      baseUrl: "https://ha.example.test/ha",
      token: "never-print-this-token",
      fetchImpl: async (url) => new Response(JSON.stringify(
        url.endsWith("/api/states") ? (currentState ? [currentState] : []) : currentState,
      ), { status: 200, headers: { "Content-Type": "application/json" } }),
    });
    const deviceInventory = new DeviceInventory({
      deviceClient: { listDevices: () => homeAssistant.listDevices() },
      filePath: join(directory, "device-inventory.json"),
    });
    monitorTools = createHouseholdDeviceMonitorTools({
      deviceInventory,
      createMonitor: (options) => homeAssistant.createStateMonitor({
        WebSocketImpl: FakeMonitorWebSocket,
        timeoutMs: 100,
        ...options,
      }),
      diagnoseDevice: (params) => homeAssistant.diagnoseDevice(params),
      recordDiagnosticAlert: (diagnosis) => homeAssistant.recordDiagnosticAlert(diagnosis),
      recordDiagnosticTransient: (transient) => homeAssistant.recordDiagnosticTransient(transient),
      recordDiagnosticRecovery: (recovery) => homeAssistant.recordDiagnosticRecovery(recovery),
      recordDiagnosticTrackingEnded: (resolution) => homeAssistant.recordDiagnosticTrackingEnded(resolution),
      debounceMs: 5,
      offlineGraceMs: 10,
    });

    const started = await monitorTools.start_household_device_monitor();
    assert.equal(started.success, true);
    assert.equal(started.backend_mode, "home-assistant");
    await waitForCondition(
      () => homeAssistant.getEvents({ event_type: "diagnostic_alert", device_id: "light.study" }).length === 1,
      "the initial offline alert",
    );
    assert.equal(homeAssistant.getEvents({ event_type: "diagnostic_alert", device_id: "light.study" }).length, 1);

    currentState = { ...currentState, state: "off" };
    const socket = FakeMonitorWebSocket.instances[0];
    const subscriptionId = socket.sent.find((message) => message.type === "subscribe_events").id;
    socket.emit("message", { data: JSON.stringify({
      id: subscriptionId,
      type: "event",
      event: {
        event_type: "state_changed",
        time_fired: "2026-10-10T00:01:00Z",
        data: {
          entity_id: "light.study",
          old_state: { state: "unavailable", attributes: { friendly_name: "书房灯", internal_value: "private" } },
          new_state: { state: "off", attributes: { friendly_name: "书房灯", internal_value: "private" } },
        },
      },
    }) });
    await waitForCondition(
      () => homeAssistant.getEvents({ event_type: "diagnostic_recovered", device_id: "light.study" }).length === 1,
      "the recovery event",
    );

    const status = monitorTools.get_household_device_monitor_status();
    const recoveryEvents = homeAssistant.getEvents({ event_type: "diagnostic_recovered", device_id: "light.study" });
    assert.equal(status.last_diagnosis.alerts.some((item) => item.device_id === "light.study"), false);
    assert.equal(recoveryEvents.length, 1);
    assert.deepEqual(recoveryEvents[0].payload, {
      previous_code: "DEVICE_OFFLINE",
      summary: "设备当前健康状态已恢复，活动诊断告警已清除。",
    });
    assert.equal(JSON.stringify(status).includes("internal_value"), false);
    assert.equal(JSON.stringify(recoveryEvents).includes("internal_value"), false);
    assert.equal(JSON.stringify(status).includes("never-print-this-token"), false);
    assert.equal(homeAssistant.getAuditLog().length, 0);

    currentState = { ...currentState, state: "unavailable" };
    socket.emit("message", { data: JSON.stringify({
      id: subscriptionId,
      type: "event",
      event: {
        event_type: "state_changed",
        time_fired: "2026-10-10T00:02:00Z",
        data: {
          entity_id: "light.study",
          old_state: { state: "off", attributes: { friendly_name: "书房灯" } },
          new_state: { state: "unavailable", attributes: { friendly_name: "书房灯" } },
        },
      },
    }) });
    await waitForCondition(
      () => homeAssistant.getEvents({ event_type: "diagnostic_alert", device_id: "light.study" }).length === 2,
      "the second offline alert",
    );
    assert.equal(homeAssistant.getEvents({ event_type: "diagnostic_alert", device_id: "light.study" }).length, 2);

    const removedState = currentState;
    currentState = null;
    socket.emit("message", { data: JSON.stringify({
      id: subscriptionId,
      type: "event",
      event: {
        event_type: "state_changed",
        time_fired: "2026-10-10T00:03:00Z",
        data: { entity_id: "light.study", old_state: removedState, new_state: null },
      },
    }) });
    await waitForCondition(
      () => homeAssistant.getEvents({ event_type: "diagnostic_tracking_ended", device_id: "light.study" }).length === 1,
      "the tracking-ended event after entity removal",
    );

    const trackingEndedEvents = homeAssistant.getEvents({ event_type: "diagnostic_tracking_ended", device_id: "light.study" });
    assert.equal(monitorTools.get_household_device_monitor_status().last_diagnosis.alerts.some((item) => item.device_id === "light.study"), false);
    assert.equal(trackingEndedEvents.length, 1);
    assert.deepEqual(trackingEndedEvents[0].payload, {
      previous_code: "DEVICE_OFFLINE",
      reason: "entity_missing_from_ha_inventory",
      summary: "实体未出现在成功的 Home Assistant 清单扫描中，已停止跟踪该活动告警；设备是否修复未知。",
    });
    assert.equal(homeAssistant.getEvents({ event_type: "diagnostic_recovered", device_id: "light.study" }).length, 1);
  } finally {
    monitorTools?.stop_household_device_monitor();
    rmSync(directory, { recursive: true, force: true });
  }
});

