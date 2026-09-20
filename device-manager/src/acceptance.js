import { createDeviceToolRuntime } from "./tools.js";

const runtime = createDeviceToolRuntime();
const checks = [];

function check(name, passed, details = {}) {
  checks.push({ name, passed, ...details });
}

function isVerified(result) {
  return result?.success === true && result.verification?.every((entry) => entry.verified);
}

const devices = runtime.invoke("list_devices");
check("设备发现", devices.success === true && devices.count === 10, {
  expected: 10,
  actual: devices.count,
});

const plugControl = runtime.invoke("control_device", {
  device_id: "switch.living_room_plug",
  action: "turn_on",
});
const plugState = runtime.invoke("get_state", { device_id: "switch.living_room_plug" });
check("智能插座控制与回读", plugControl.success === true && plugState.device?.state === "on", {
  device_id: "switch.living_room_plug",
  state: plugState.device?.state,
});

const temperature = runtime.invoke("get_state", { device_id: "sensor.living_room_temperature" });
const motion = runtime.invoke("get_state", { device_id: "binary_sensor.living_room_motion" });
check("传感器状态读取", temperature.success === true && motion.success === true, {
  temperature: temperature.device?.state,
  motion: motion.device?.state,
});

const control = runtime.invoke("control_device", {
  device_id: "light.living_room",
  action: "turn_on",
});
const lightState = runtime.invoke("get_state", { device_id: "light.living_room" });
check("设备控制与状态验证", control.success === true && lightState.device?.state === "on", {
  device_id: "light.living_room",
  state: lightState.device?.state,
});

const scene = runtime.invoke("run_scene", { scene_id: "home" });
check("回家场景逐项验证", isVerified(scene), {
  scene_id: "home",
  verified_steps: scene.verification?.filter((entry) => entry.verified).length ?? 0,
  total_steps: scene.verification?.length ?? 0,
});

const lockBefore = runtime.invoke("get_state", { device_id: "lock.front_door" });
const blockedUnlock = runtime.invoke("control_device", {
  device_id: "lock.front_door",
  action: "unlock",
});
const lockAfter = runtime.invoke("get_state", { device_id: "lock.front_door" });
check(
  "高风险开锁拦截",
  blockedUnlock.success === false
    && blockedUnlock.error?.code === "CONFIRMATION_REQUIRED"
    && lockBefore.device?.state === lockAfter.device?.state,
  {
    error_code: blockedUnlock.error?.code,
    state_unchanged: lockBefore.device?.state === lockAfter.device?.state,
  },
);

const diagnosis = runtime.invoke("diagnose_device");
check("全量设备诊断", diagnosis.success === true && diagnosis.summary?.healthy === 10, {
  healthy: diagnosis.summary?.healthy,
  offline: diagnosis.summary?.offline,
  abnormal: diagnosis.summary?.abnormal,
});

const events = runtime.invoke("get_device_events", { limit: 100 });
check("动作审计事件可查询", events.success === true
  && events.events.some((event) => event.event_type === "action_executed")
  && events.events.some((event) => event.event_type === "action_failed"), {
  event_count: events.events?.length ?? 0,
  event_types: [...new Set(events.events?.map((event) => event.event_type) ?? [])],
});

const unknown = runtime.invoke("get_state", { device_id: "light.unknown" });
check("未知设备错误返回", unknown.success === false && unknown.error?.code === "DEVICE_NOT_FOUND", {
  error_code: unknown.error?.code,
});

const passed = checks.filter((item) => item.passed).length;
const failed = checks.length - passed;
const report = {
  suite: "device-manager-mvp",
  backend: "Mock Home Assistant",
  status: failed === 0 ? "PASS" : "FAIL",
  passed,
  failed,
  checks,
  metrics: {
    device_count: devices.count,
    verified_scene_steps: scene.verification?.filter((entry) => entry.verified).length ?? 0,
    audit_entries: runtime.homeAssistant.getAuditLog().length,
    event_entries: events.events?.length ?? 0,
  },
};

console.log(JSON.stringify(report, null, 2));
if (failed > 0) process.exitCode = 1;
