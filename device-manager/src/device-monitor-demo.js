import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeviceInventory } from "./device-inventory.js";
import { createHouseholdDeviceMonitorTools } from "./device-monitor-tools.js";
import { MockHomeAssistant } from "./mock-ha.js";
import { createDeviceToolRuntime } from "./tools.js";

const directory = mkdtempSync(join(tmpdir(), "lt-device-monitor-demo-"));
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function show(title, value) {
  console.log(`\n${title}`);
  console.log(JSON.stringify(value, null, 2));
}

try {
  const homeAssistant = new MockHomeAssistant();
  const runtime = createDeviceToolRuntime(homeAssistant);
  const inventory = new DeviceInventory({
    deviceClient: { listDevices: () => runtime.invoke("list_devices") },
    filePath: join(directory, "device-inventory.json"),
  });
  const monitor = createHouseholdDeviceMonitorTools({
    deviceInventory: inventory,
    createMonitor: (options) => homeAssistant.createStateMonitor(options),
    diagnoseDevice: (params) => runtime.invoke("diagnose_device", params),
    recordDiagnosticAlert: (diagnosis) => homeAssistant.recordDiagnosticAlert(diagnosis),
    recordDiagnosticSharedInfrastructure: (incident) => homeAssistant.recordDiagnosticSharedInfrastructure(incident),
    recordDiagnosticSharedInfrastructureResolved: (resolution) => homeAssistant.recordDiagnosticSharedInfrastructureResolved(resolution),
    recordDiagnosticTransient: (transient) => homeAssistant.recordDiagnosticTransient(transient),
    recordDiagnosticRecovery: (recovery) => homeAssistant.recordDiagnosticRecovery(recovery),
    debounceMs: 20,
    healthCheckIntervalMs: 25,
    offlineGraceMs: 20,
  });

  const started = await monitor.start_household_device_monitor();
  show("1. 启动 Mock 状态监测（演示将普通离线宽限缩短为 20ms；默认值为 2 分钟）", started);

  const light = homeAssistant.devices.get("light.living_room");
  light.state = "unavailable";
  light.available = false;
  show("2. 模拟监测事件漏报：设备状态变化，但没有推送事件（仅虚拟数据）", {
    event_published: false,
    note: "故意只改动 Mock 当前状态，验证周期巡检能否补发现。",
  });

  await wait(65);
  show("3. 周期巡检发现离线设备并刷新清单/诊断", monitor.get_household_device_monitor_status());
  show("4. Mock HA 诊断事件账本", runtime.invoke("get_device_events", {
    device_id: "light.living_room",
    event_type: "diagnostic_alert",
  }));

  homeAssistant.simulateStateChange({ device_id: "light.living_room", state: "off", available: true });
  await wait(50);
  show("5. 模拟设备外部恢复：清除活动告警并记录脱敏恢复事件", {
    monitor_status: monitor.get_household_device_monitor_status(),
    recovery_events: runtime.invoke("get_device_events", {
      device_id: "light.living_room",
      event_type: "diagnostic_recovered",
    }),
    note: "这是 Mock 设备状态被外部改回健康后的恢复记录，不是系统自动修复。",
  });
  show("6. 确认监测未自动控制设备", {
    audit_action_count: homeAssistant.getAuditLog().length,
    device_state: homeAssistant.getState({ device_id: "light.living_room" }).device.state,
    note: "此演示使用临时 Mock HA 和临时设备清单，不连接真实 HA；监测只诊断并记录恢复，不执行设备控制或自动修复。",
  });

  for (const device_id of ["light.living_room", "switch.living_room_plug", "climate.bedroom"]) {
    homeAssistant.simulateStateChange({ device_id, state: "unavailable", available: false });
  }
  await wait(100);
  show("7. 模拟三台设备同时持续离线：普通设备合并为一条共同基础设施提示", {
    monitor_status: monitor.get_household_device_monitor_status(),
    shared_incident: runtime.invoke("get_device_events", {
      event_type: "diagnostic_shared_infrastructure_suspected",
    }),
    note: "这可能是断电、网络或 HA 共因，不推断具体根因，也不把每台设备分别判为故障。",
  });

  for (const device_id of ["switch.living_room_plug", "climate.bedroom"]) {
    homeAssistant.simulateStateChange({ device_id, state: "off", available: true });
  }
  await wait(80);
  show("8. 共同离线数量低于阈值后：清除组级提示并单独跟踪仍离线设备", {
    offline_summary: monitor.get_household_device_monitor_status().offline_summary,
    group_events: runtime.invoke("get_device_events", {
      event_type: "diagnostic_shared_infrastructure_cleared",
    }),
    remaining_device_alert: runtime.invoke("get_device_events", {
      device_id: "light.living_room",
      event_type: "diagnostic_alert",
    }),
  });

  homeAssistant.simulateStateChange({ device_id: "light.living_room", state: "off", available: true });
  await wait(50);
  monitor.stop_household_device_monitor();
} finally {
  rmSync(directory, { recursive: true, force: true });
}
