import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeviceInventory } from "../src/device-inventory.js";
import { createHouseholdDeviceMonitorTools } from "../src/device-monitor-tools.js";
import { MockHomeAssistant } from "../src/mock-ha.js";
import { createDeviceToolRuntime } from "../src/tools.js";

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("测试条件未在期限内满足");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("Mock 状态变化触发设备清单刷新和只读故障诊断，不自动控制设备", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lt-mock-device-monitor-test-"));
  let monitorTools;
  try {
    const homeAssistant = new MockHomeAssistant();
    const runtime = createDeviceToolRuntime(homeAssistant);
    const inventory = new DeviceInventory({
      deviceClient: { listDevices: () => runtime.invoke("list_devices") },
      filePath: join(directory, "device-inventory.json"),
    });
    monitorTools = createHouseholdDeviceMonitorTools({
      deviceInventory: inventory,
      createMonitor: (options) => homeAssistant.createStateMonitor(options),
      diagnoseDevice: (params) => runtime.invoke("diagnose_device", params),
      recordDiagnosticAlert: (diagnosis) => homeAssistant.recordDiagnosticAlert(diagnosis),
      recordDiagnosticTransient: (transient) => homeAssistant.recordDiagnosticTransient(transient),
      recordDiagnosticRecovery: (recovery) => homeAssistant.recordDiagnosticRecovery(recovery),
      offlineGraceMs: 15,
      debounceMs: 5,
    });

    const started = await monitorTools.start_household_device_monitor();
    assert.equal(started.success, true);
    assert.equal(started.backend_mode, "mock");
    assert.equal(started.initial_scan.discovered_count, 10);
    assert.equal(homeAssistant.getEvents({ event_type: "diagnostic_alert" }).length, 0, "sample devices whose state is off are normal");

    const changed = homeAssistant.simulateStateChange({
      device_id: "light.living_room",
      state: "unavailable",
      available: false,
    });
    assert.equal(changed.success, true);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const status = monitorTools.get_household_device_monitor_status();
    assert.equal(status.monitoring, true);
    assert.equal(status.backend_mode, "mock");
    assert.equal(status.last_event.device_id, "light.living_room");
    assert.equal(status.last_event.availability_changed, true);
    assert.deepEqual(status.last_diagnosis.alerts.map(({ device_id, status: health }) => ({ device_id, status: health })), [
      { device_id: "light.living_room", status: "offline" },
    ]);
    assert.equal(JSON.stringify(status).includes("old_state"), false);
    assert.equal(JSON.stringify(status).includes('"unavailable"'), false);
    assert.equal(homeAssistant.getAuditLog().length, 0);
    assert.equal(homeAssistant.getEvents({ event_type: "diagnostic_alert" }).length, 1);
    assert.equal(homeAssistant.getEvents({ event_type: "diagnostic_alert", device_id: "light.living_room" })[0].severity, "warning");

    homeAssistant.simulateStateChange({ device_id: "light.living_room", state: "off", available: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const recoveredStatus = monitorTools.get_household_device_monitor_status();
    assert.equal(recoveredStatus.last_diagnosis.alerts.some((item) => item.device_id === "light.living_room"), false);
    assert.ok(recoveredStatus.last_diagnosis.recovered_device_ids.includes("light.living_room"));
    const recoveryEvents = homeAssistant.getEvents({ event_type: "diagnostic_recovered", device_id: "light.living_room" });
    assert.equal(recoveryEvents.length, 1);
    assert.deepEqual(recoveryEvents[0].payload, {
      previous_code: "DEVICE_OFFLINE",
      summary: "设备当前健康状态已恢复，活动诊断告警已清除。",
    });
    assert.equal(JSON.stringify(recoveryEvents).includes("unavailable"), false);
    assert.equal(homeAssistant.getAuditLog().length, 0);

    monitorTools.stop_household_device_monitor();
    homeAssistant.simulateStateChange({ device_id: "light.living_room", state: "on", available: true });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(monitorTools.get_household_device_monitor_status().monitoring, false);
    assert.equal(monitorTools.get_household_device_monitor_status().last_refresh.event_count, 1);
  } finally {
    monitorTools?.stop_household_device_monitor();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Mock 设备正常控制会产生可被监测器接收的状态事件", async () => {
  const homeAssistant = new MockHomeAssistant();
  const events = [];
  const monitor = homeAssistant.createStateMonitor({ onStateChange: (event) => events.push(event) });
  assert.equal((await monitor.start()).success, true);

  const result = homeAssistant.controlDevice({ device_id: "light.living_room", action: "turn_on" });
  assert.equal(result.success, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].device_id, "light.living_room");
  assert.equal(events[0].state_changed, true);
  assert.equal(Object.hasOwn(events[0], "old_state"), false);
  monitor.stop();
});

test("周期健康巡检能发现漏掉的状态事件，并对持续故障只记一条新告警", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lt-mock-health-check-test-"));
  let monitorTools;
  try {
    const homeAssistant = new MockHomeAssistant();
    const runtime = createDeviceToolRuntime(homeAssistant);
    const inventory = new DeviceInventory({
      deviceClient: { listDevices: () => runtime.invoke("list_devices") },
      filePath: join(directory, "device-inventory.json"),
    });
    monitorTools = createHouseholdDeviceMonitorTools({
      deviceInventory: inventory,
      createMonitor: (options) => homeAssistant.createStateMonitor(options),
      diagnoseDevice: (params) => runtime.invoke("diagnose_device", params),
      recordDiagnosticAlert: (diagnosis) => homeAssistant.recordDiagnosticAlert(diagnosis),
      recordDiagnosticTransient: (transient) => homeAssistant.recordDiagnosticTransient(transient),
      recordDiagnosticRecovery: (recovery) => homeAssistant.recordDiagnosticRecovery(recovery),
      debounceMs: 5,
      healthCheckIntervalMs: 15,
      offlineGraceMs: 10,
    });
    assert.equal((await monitorTools.start_household_device_monitor()).success, true);

    // Simulate a missed push: current Mock state changes, but no event is emitted.
    const light = homeAssistant.devices.get("light.living_room");
    light.state = "unavailable";
    light.available = false;
    await waitFor(() => {
      const status = monitorTools.get_household_device_monitor_status();
      return status.last_health_check.trigger === "periodic_health_check"
        && status.last_diagnosis.alerts.some((item) => item.device_id === "light.living_room" && item.status === "offline")
        && homeAssistant.getEvents({ event_type: "diagnostic_alert", device_id: "light.living_room" }).length === 1;
    });

    const status = monitorTools.get_household_device_monitor_status();
    assert.equal(status.last_health_check.trigger, "periodic_health_check");
    assert.ok(status.last_diagnosis.alerts.some((item) => item.device_id === "light.living_room" && item.status === "offline"));
    assert.equal(homeAssistant.getEvents({ event_type: "diagnostic_alert", device_id: "light.living_room" }).length, 1);
    assert.equal(homeAssistant.getAuditLog().length, 0);

    const firstCheckAt = status.last_health_check.checked_at;
    await waitFor(() => monitorTools.get_household_device_monitor_status().last_health_check.checked_at !== firstCheckAt);
    assert.equal(homeAssistant.getEvents({ event_type: "diagnostic_alert", device_id: "light.living_room" }).length, 1);

    light.state = "off";
    light.available = true;
    await waitFor(() => {
      const current = monitorTools.get_household_device_monitor_status();
      return current.last_diagnosis.alerts.every((item) => item.device_id !== "light.living_room")
        && current.last_diagnosis.recovered_device_ids.includes("light.living_room")
        && homeAssistant.getEvents({ event_type: "diagnostic_recovered", device_id: "light.living_room" }).length === 1;
    });
    const recovered = monitorTools.get_household_device_monitor_status();
    assert.equal(recovered.last_diagnosis.alerts.some((item) => item.device_id === "light.living_room"), false);
    assert.ok(recovered.last_diagnosis.recovered_device_ids.includes("light.living_room"));
    assert.equal(homeAssistant.getEvents({ event_type: "diagnostic_recovered", device_id: "light.living_room" }).length, 1);
    assert.equal(homeAssistant.getAuditLog().length, 0);
  } finally {
    monitorTools?.stop_household_device_monitor();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("HA 清单移除故障实体时结束跟踪但不伪称设备恢复", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lt-device-monitor-removed-test-"));
  const homeAssistant = new MockHomeAssistant();
  const runtime = createDeviceToolRuntime(homeAssistant);
  const inventory = new DeviceInventory({
    deviceClient: { listDevices: () => runtime.invoke("list_devices") },
    filePath: join(directory, "device-inventory.json"),
  });
  let monitoring = false;
  const monitorTools = createHouseholdDeviceMonitorTools({
    deviceInventory: inventory,
    createMonitor: () => ({
      async start() { monitoring = true; return { success: true, monitoring, connection_state: "connected", backend_mode: "mock" }; },
      stop() { monitoring = false; return { success: true, monitoring, connection_state: "stopped" }; },
      status() { return { monitoring, connection_state: monitoring ? "connected" : "stopped", backend_mode: "mock" }; },
    }),
    diagnoseDevice: (params) => runtime.invoke("diagnose_device", params),
    recordDiagnosticAlert: (diagnosis) => homeAssistant.recordDiagnosticAlert(diagnosis),
    recordDiagnosticTransient: (transient) => homeAssistant.recordDiagnosticTransient(transient),
    recordDiagnosticRecovery: (recovery) => homeAssistant.recordDiagnosticRecovery(recovery),
    recordDiagnosticTrackingEnded: (resolution) => homeAssistant.recordDiagnosticTrackingEnded(resolution),
    debounceMs: 5,
    healthCheckIntervalMs: 10,
    offlineGraceMs: 10,
  });

  try {
    homeAssistant.simulateStateChange({ device_id: "light.living_room", state: "unknown", available: true });
    assert.equal((await monitorTools.start_household_device_monitor()).success, true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(homeAssistant.getEvents({ event_type: "diagnostic_alert", device_id: "light.living_room" }).length, 1);

    homeAssistant.devices.delete("light.living_room");
    await new Promise((resolve) => setTimeout(resolve, 25));

    const status = monitorTools.get_household_device_monitor_status();
    const endedEvents = homeAssistant.getEvents({ event_type: "diagnostic_tracking_ended", device_id: "light.living_room" });
    assert.equal(status.last_diagnosis.alerts.some((item) => item.device_id === "light.living_room"), false);
    assert.equal(endedEvents.length, 1);
    assert.deepEqual(endedEvents[0].payload, {
      previous_code: "DEVICE_OFFLINE",
      reason: "entity_missing_from_ha_inventory",
      summary: "实体未出现在成功的 Home Assistant 清单扫描中，已停止跟踪该活动告警；设备是否修复未知。",
    });
    assert.equal(homeAssistant.getEvents({ event_type: "diagnostic_recovered", device_id: "light.living_room" }).length, 0);
    assert.equal(homeAssistant.getAuditLog().length, 0);
  } finally {
    monitorTools.stop_household_device_monitor();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("普通设备在宽限期内恢复只记录瞬时波动，不生成故障告警", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lt-device-monitor-transient-test-"));
  let monitorTools;
  try {
    const homeAssistant = new MockHomeAssistant();
    const runtime = createDeviceToolRuntime(homeAssistant);
    const inventory = new DeviceInventory({
      deviceClient: { listDevices: () => runtime.invoke("list_devices") },
      filePath: join(directory, "device-inventory.json"),
    });
    monitorTools = createHouseholdDeviceMonitorTools({
      deviceInventory: inventory,
      createMonitor: (options) => homeAssistant.createStateMonitor(options),
      diagnoseDevice: (params) => runtime.invoke("diagnose_device", params),
      recordDiagnosticAlert: (diagnosis) => homeAssistant.recordDiagnosticAlert(diagnosis),
      recordDiagnosticTransient: (transient) => homeAssistant.recordDiagnosticTransient(transient),
      offlineGraceMs: 120,
      debounceMs: 5,
    });
    await monitorTools.start_household_device_monitor();

    homeAssistant.simulateStateChange({ device_id: "light.living_room", state: "unknown", available: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const pending = monitorTools.get_household_device_monitor_status();
    assert.equal(pending.pending_offline.length, 1);
    assert.equal(pending.pending_offline[0].severity_after_grace, "warning");
    assert.equal(homeAssistant.getEvents({ event_type: "diagnostic_alert", device_id: "light.living_room" }).length, 0);

    homeAssistant.simulateStateChange({ device_id: "light.living_room", state: "off", available: true });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const status = monitorTools.get_household_device_monitor_status();
    const transientEvents = homeAssistant.getEvents({ event_type: "diagnostic_transient", device_id: "light.living_room" });
    assert.equal(status.pending_offline.length, 0);
    assert.equal(status.offline_summary.offline_device_count, 0);
    assert.equal(homeAssistant.getEvents({ event_type: "diagnostic_alert", device_id: "light.living_room" }).length, 0);
    assert.equal(homeAssistant.getEvents({ event_type: "diagnostic_recovered", device_id: "light.living_room" }).length, 0);
    assert.equal(transientEvents.length, 1);
    assert.equal(transientEvents[0].severity, "info");
    assert.equal(transientEvents[0].payload.code, "DEVICE_OFFLINE");
    assert.ok(transientEvents[0].payload.duration_ms < 120);
    assert.equal(Object.hasOwn(transientEvents[0].payload, "state"), false);
  } finally {
    monitorTools?.stop_household_device_monitor();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("多设备共同故障候选中部分设备恢复后，剩余持续离线设备恢复单独告警", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lt-device-monitor-deferred-alert-test-"));
  let monitorTools;
  try {
    const homeAssistant = new MockHomeAssistant();
    const runtime = createDeviceToolRuntime(homeAssistant);
    const inventory = new DeviceInventory({
      deviceClient: { listDevices: () => runtime.invoke("list_devices") },
      filePath: join(directory, "device-inventory.json"),
    });
    monitorTools = createHouseholdDeviceMonitorTools({
      deviceInventory: inventory,
      createMonitor: (options) => homeAssistant.createStateMonitor(options),
      diagnoseDevice: (params) => runtime.invoke("diagnose_device", params),
      recordDiagnosticAlert: (diagnosis) => homeAssistant.recordDiagnosticAlert(diagnosis),
      recordDiagnosticSharedInfrastructure: (incident) => homeAssistant.recordDiagnosticSharedInfrastructure(incident),
      recordDiagnosticSharedInfrastructureResolved: (resolution) => homeAssistant.recordDiagnosticSharedInfrastructureResolved(resolution),
      recordDiagnosticTransient: (transient) => homeAssistant.recordDiagnosticTransient(transient),
      offlineGraceMs: 300,
      debounceMs: 2,
      healthCheckIntervalMs: 1_000,
    });

    await monitorTools.start_household_device_monitor();
    const candidates = ["light.living_room", "switch.living_room_plug", "climate.bedroom"];
    for (let index = 0; index < candidates.length; index += 1) {
      homeAssistant.simulateStateChange({ device_id: candidates[index], state: "unavailable", available: false });
      await waitFor(() => monitorTools.get_household_device_monitor_status().pending_offline.length === index + 1);
      if (index < candidates.length - 1) await new Promise((resolve) => setTimeout(resolve, 100));
    }

    await waitFor(() => monitorTools.get_household_device_monitor_status().offline_summary.deferred_offline_device_count === 1);
    assert.equal(homeAssistant.getEvents({ event_type: "diagnostic_alert" }).length, 0, "共同候选尚未明确时先暂缓单台普通告警");
    assert.equal(homeAssistant.getEvents({ event_type: "diagnostic_shared_infrastructure_suspected" }).length, 0);

    for (const device_id of candidates.slice(1)) {
      homeAssistant.simulateStateChange({ device_id, state: "off", available: true });
    }
    await waitFor(() => homeAssistant.getEvents({ event_type: "diagnostic_alert" }).length === 1);

    const status = monitorTools.get_household_device_monitor_status();
    assert.equal(status.offline_summary.shared_infrastructure_incident_active, false);
    assert.equal(status.offline_summary.confirmed_offline_device_count, 1);
    assert.equal(status.offline_summary.deferred_offline_device_count, 0);
    assert.deepEqual(status.last_diagnosis.alerts.map((item) => item.device_id), ["light.living_room"]);
    assert.deepEqual(homeAssistant.getEvents({ event_type: "diagnostic_alert" }).map((event) => event.subject.device_id), ["light.living_room"]);
    assert.equal(homeAssistant.getEvents({ event_type: "diagnostic_shared_infrastructure_suspected" }).length, 0);
    assert.equal(homeAssistant.getEvents({ event_type: "diagnostic_transient" }).length, 2);
  } finally {
    monitorTools?.stop_household_device_monitor();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("显式安全关键实体采用较短宽限期并升级为 critical；多台离线只提示共同问题", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lt-device-monitor-critical-test-"));
  let monitorTools;
  try {
    const homeAssistant = new MockHomeAssistant();
    const runtime = createDeviceToolRuntime(homeAssistant);
    const inventory = new DeviceInventory({
      deviceClient: { listDevices: () => runtime.invoke("list_devices") },
      filePath: join(directory, "device-inventory.json"),
    });
    for (const deviceId of ["light.living_room", "switch.living_room_plug", "lock.front_door"]) {
      const device = homeAssistant.devices.get(deviceId);
      device.state = "unavailable";
      device.available = false;
    }
    monitorTools = createHouseholdDeviceMonitorTools({
      deviceInventory: inventory,
      createMonitor: (options) => homeAssistant.createStateMonitor(options),
      diagnoseDevice: (params) => runtime.invoke("diagnose_device", params),
      recordDiagnosticAlert: (diagnosis) => homeAssistant.recordDiagnosticAlert(diagnosis),
      recordDiagnosticSharedInfrastructure: (incident) => homeAssistant.recordDiagnosticSharedInfrastructure(incident),
      recordDiagnosticSharedInfrastructureResolved: (resolution) => homeAssistant.recordDiagnosticSharedInfrastructureResolved(resolution),
      recordDiagnosticTransient: (transient) => homeAssistant.recordDiagnosticTransient(transient),
      offlineGraceMs: 500,
      criticalOfflineGraceMs: 20,
      criticalOfflineEntityIds: ["lock.front_door"],
      healthCheckIntervalMs: 1_000,
    });

    const started = await monitorTools.start_household_device_monitor();
    assert.equal(started.success, true);
    const initial = monitorTools.get_household_device_monitor_status();
    assert.equal(initial.offline_policy.ordinary_grace_ms, 500);
    assert.equal(initial.offline_policy.critical_grace_ms, 20);
    assert.equal(initial.offline_policy.explicitly_critical_entity_count, 1);
    assert.equal(initial.pending_offline.length, 3);
    assert.equal(initial.offline_summary.offline_device_count, 3);
    assert.equal(initial.offline_summary.pending_offline_device_count, 3);
    assert.equal(initial.offline_summary.confirmed_offline_device_count, 0);
    assert.equal(initial.offline_summary.suspected_shared_infrastructure_issue, false, "待复查设备不能提前触发共同基础设施提示");
    assert.equal(initial.offline_summary.shared_infrastructure_incident_active, false);
    assert.equal(homeAssistant.getEvents({ event_type: "diagnostic_shared_infrastructure_suspected" }).length, 0);

    await waitFor(() => {
      const summary = monitorTools.get_household_device_monitor_status().offline_summary;
      return summary.shared_infrastructure_incident_active && summary.grouped_offline_device_count === 2;
    });
    const status = monitorTools.get_household_device_monitor_status();
    const criticalAlert = homeAssistant.getEvents({ event_type: "diagnostic_alert", device_id: "lock.front_door" })[0];
    assert.equal(criticalAlert.severity, "critical");
    assert.equal(homeAssistant.getEvents({ event_type: "diagnostic_alert", device_id: "light.living_room" }).length, 0);
    assert.ok(status.last_diagnosis.alerts.some((item) => item.device_id === "lock.front_door" && item.severity === "critical"));
    assert.equal(status.offline_summary.grouped_offline_device_count, 2);
    assert.equal(status.offline_summary.shared_infrastructure_incident_active, true);
    assert.equal(homeAssistant.getEvents({ event_type: "diagnostic_shared_infrastructure_suspected" }).length, 1);
    assert.equal(status.offline_summary.offline_device_count, 3);
    assert.equal(status.offline_summary.confirmed_offline_device_count, 3);
    assert.equal(status.offline_summary.suspected_shared_infrastructure_issue, true);
    assert.match(status.offline_summary.summary, /可能.*Home Assistant.*网络或供电/);
  } finally {
    monitorTools?.stop_household_device_monitor();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("多台设备在宽限期后持续离线时合并为一条共同基础设施提示；数量下降后剩余设备恢复单独跟踪", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lt-device-monitor-shared-outage-test-"));
  let monitorTools;
  try {
    const homeAssistant = new MockHomeAssistant();
    const runtime = createDeviceToolRuntime(homeAssistant);
    const inventory = new DeviceInventory({
      deviceClient: { listDevices: () => runtime.invoke("list_devices") },
      filePath: join(directory, "device-inventory.json"),
    });
    monitorTools = createHouseholdDeviceMonitorTools({
      deviceInventory: inventory,
      createMonitor: (options) => homeAssistant.createStateMonitor(options),
      diagnoseDevice: (params) => runtime.invoke("diagnose_device", params),
      recordDiagnosticAlert: (diagnosis) => homeAssistant.recordDiagnosticAlert(diagnosis),
      recordDiagnosticSharedInfrastructure: (incident) => homeAssistant.recordDiagnosticSharedInfrastructure(incident),
      recordDiagnosticSharedInfrastructureResolved: (resolution) => homeAssistant.recordDiagnosticSharedInfrastructureResolved(resolution),
      recordDiagnosticTransient: (transient) => homeAssistant.recordDiagnosticTransient(transient),
      recordDiagnosticRecovery: (recovery) => homeAssistant.recordDiagnosticRecovery(recovery),
      recordDiagnosticTrackingEnded: (resolution) => homeAssistant.recordDiagnosticTrackingEnded(resolution),
      debounceMs: 2,
      healthCheckIntervalMs: 1_000,
      offlineGraceMs: 15,
    });

    await monitorTools.start_household_device_monitor();
    for (const device_id of ["light.living_room", "switch.living_room_plug", "climate.bedroom"]) {
      homeAssistant.simulateStateChange({ device_id, state: "unavailable", available: false });
    }
    await waitFor(() => {
      const summary = monitorTools.get_household_device_monitor_status().offline_summary;
      return summary.shared_infrastructure_incident_active && summary.grouped_offline_device_count === 3;
    });

    const groupedStatus = monitorTools.get_household_device_monitor_status();
    assert.equal(groupedStatus.offline_summary.offline_device_count, 3);
    assert.equal(groupedStatus.offline_summary.shared_infrastructure_incident_active, true);
    assert.equal(groupedStatus.offline_summary.grouped_offline_device_count, 3);
    assert.deepEqual(groupedStatus.offline_summary.grouped_offline_device_ids, [
      "light.living_room",
      "switch.living_room_plug",
      "climate.bedroom",
    ]);
    assert.equal(groupedStatus.last_diagnosis.alerts.length, 0, "普通设备不逐台产生故障告警");
    assert.equal(homeAssistant.getEvents({ event_type: "diagnostic_alert" }).length, 0);
    assert.equal(homeAssistant.getEvents({ event_type: "diagnostic_shared_infrastructure_suspected" }).length, 1);

    homeAssistant.devices.delete("climate.bedroom");
    homeAssistant.simulateStateChange({ device_id: "light.living_room", state: "unknown", available: false });
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.equal(homeAssistant.getEvents({ event_type: "diagnostic_tracking_ended", device_id: "climate.bedroom" }).length, 1);

    homeAssistant.simulateStateChange({ device_id: "switch.living_room_plug", state: "off", available: true });
    await new Promise((resolve) => setTimeout(resolve, 45));

    const reducedStatus = monitorTools.get_household_device_monitor_status();
    assert.equal(reducedStatus.offline_summary.offline_device_count, 1);
    assert.equal(reducedStatus.offline_summary.shared_infrastructure_incident_active, false);
    assert.equal(reducedStatus.offline_summary.grouped_offline_device_count, 0);
    assert.ok(reducedStatus.last_diagnosis.alerts.some((item) => item.device_id === "light.living_room" && item.severity === "warning"));
    assert.equal(homeAssistant.getEvents({ event_type: "diagnostic_shared_infrastructure_cleared" }).length, 1);
    assert.equal(homeAssistant.getEvents({ event_type: "diagnostic_alert", device_id: "light.living_room" }).length, 1);
    assert.equal(homeAssistant.getEvents({ event_type: "diagnostic_alert", device_id: "switch.living_room_plug" }).length, 1);
    assert.equal(homeAssistant.getEvents({ event_type: "diagnostic_recovered", device_id: "switch.living_room_plug" }).length, 1);
  } finally {
    monitorTools?.stop_household_device_monitor();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("宽限期复查遇到 HA 诊断失败时保留待复查，不误报恢复或离线告警", async () => {
  let monitoring = false;
  let diagnosisCount = 0;
  const alerts = [];
  const monitorTools = createHouseholdDeviceMonitorTools({
    deviceInventory: {
      async discover() {
        return { success: true, devices: [{ device_id: "light.test" }], missing: [], discovered_count: 1 };
      },
    },
    createMonitor: () => ({
      async start() { monitoring = true; return { success: true, monitoring, connection_state: "connected" }; },
      stop() { monitoring = false; return { success: true, monitoring, connection_state: "stopped" }; },
      status() { return { monitoring, connection_state: monitoring ? "connected" : "stopped" }; },
    }),
    diagnoseDevice: async () => {
      diagnosisCount += 1;
      if (diagnosisCount === 1) {
        return { success: true, diagnoses: [{ device_id: "light.test", status: "offline", code: "DEVICE_OFFLINE", summary: "设备当前不可用。" }] };
      }
      return { success: false, error: { code: "HA_CONNECTION_FAILED" } };
    },
    recordDiagnosticAlert: (alert) => alerts.push(alert),
    offlineGraceMs: 10,
    offlineRetryIntervalMs: 100,
  });

  try {
    await monitorTools.start_household_device_monitor();
    await new Promise((resolve) => setTimeout(resolve, 35));
    const status = monitorTools.get_household_device_monitor_status();
    assert.equal(diagnosisCount, 2);
    assert.equal(status.pending_offline.length, 1);
    assert.equal(status.pending_offline[0].last_check_error, "HA_CONNECTION_FAILED");
    assert.equal(status.last_diagnosis.success, false);
    assert.equal(alerts.length, 0);
  } finally {
    monitorTools.stop_household_device_monitor();
  }
});
