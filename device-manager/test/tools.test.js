import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MockHomeAssistant } from "../src/mock-ha.js";
import { createDeviceToolRuntime, DEVICE_TOOL_DEFINITIONS } from "../src/tools.js";

test("暴露六个设备工具（含事件查询）", () => {
  assert.deepEqual(
    DEVICE_TOOL_DEFINITIONS.map((tool) => tool.name),
    ["list_devices", "get_state", "control_device", "run_scene", "diagnose_device", "get_device_events"],
  );
});

test("OpenClaw manifest 声明相同的六个工具", () => {
  const manifestUrl = new URL("../openclaw.plugin.json", import.meta.url);
  const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));

  assert.deepEqual(
    manifest.contracts.tools,
    DEVICE_TOOL_DEFINITIONS.map((tool) => tool.name),
  );
});

test("列出全部模拟设备", () => {
  const runtime = createDeviceToolRuntime();
  const result = runtime.invoke("list_devices");

  assert.equal(result.success, true);
  assert.equal(result.count, 10);
});

test("可以控制智能插座并回读功率状态", () => {
  const runtime = createDeviceToolRuntime();
  const before = runtime.invoke("get_state", { device_id: "switch.living_room_plug" });
  const control = runtime.invoke("control_device", {
    device_id: "switch.living_room_plug",
    action: "turn_on",
  });
  const after = runtime.invoke("get_state", { device_id: "switch.living_room_plug" });

  assert.equal(before.success, true);
  assert.equal(before.device.canonical_id, "plug_livingroom_001");
  assert.equal(control.success, true);
  assert.equal(control.old_state, "off");
  assert.equal(control.new_state, "on");
  assert.equal(after.device.state, "on");
  assert.equal(after.device.attributes.power_w, 1);
});

test("统一设备视图分离稳定 ID、状态和能力", () => {
  const runtime = createDeviceToolRuntime();
  const result = runtime.invoke("get_state", {
    device_id: "switch.living_room_plug",
    canonical: true,
  });

  assert.equal(result.success, true);
  assert.equal(result.device.schema_version, "1.0");
  assert.equal(result.device.device_id, "plug_livingroom_001");
  assert.equal(result.device.source.external_id, "switch.living_room_plug");
  assert.equal(result.device.availability.status, "online");
  assert.equal(result.device.state_snapshot.properties.power, false);
  assert.ok(result.device.capabilities.actions.turn_on);
  assert.ok(result.device.capabilities.actions.turn_off);
});

test("可以读取温湿度和二值传感器", () => {
  const runtime = createDeviceToolRuntime();
  const temperature = runtime.invoke("get_state", { device_id: "sensor.living_room_temperature" });
  const motion = runtime.invoke("get_state", { device_id: "binary_sensor.living_room_motion" });

  assert.equal(temperature.success, true);
  assert.equal(temperature.device.state, "22.5");
  assert.equal(temperature.device.attributes.device_class, "temperature");
  assert.equal(motion.success, true);
  assert.equal(motion.device.state, "off");
  assert.equal(motion.device.attributes.device_class, "motion");
});

test("可以按 domain 过滤设备", () => {
  const runtime = createDeviceToolRuntime();
  const result = runtime.invoke("list_devices", { domain: "light" });

  assert.equal(result.count, 1);
  assert.equal(result.devices[0].device_id, "light.living_room");
});

test("查询不存在的设备时返回明确错误", () => {
  const runtime = createDeviceToolRuntime();
  const result = runtime.invoke("get_state", { device_id: "light.unknown" });

  assert.equal(result.success, false);
  assert.equal(result.error.code, "DEVICE_NOT_FOUND");
});

test("控制设备后可以通过 get_state 验证", () => {
  const runtime = createDeviceToolRuntime();
  const control = runtime.invoke("control_device", {
    device_id: "light.living_room",
    action: "turn_on",
  });
  const state = runtime.invoke("get_state", { device_id: "light.living_room" });

  assert.equal(control.success, true);
  assert.equal(control.old_state, "off");
  assert.equal(control.new_state, "on");
  assert.equal(state.device.state, "on");
  assert.equal(state.device.attributes.brightness, 100);
});

test("空调温度必须在设备允许范围内", () => {
  const runtime = createDeviceToolRuntime();
  const result = runtime.invoke("control_device", {
    device_id: "climate.bedroom",
    action: "set_temperature",
    parameters: { temperature: 35 },
  });

  assert.equal(result.success, false);
  assert.equal(result.error.code, "INVALID_PARAMETER");
});

test("未确认时禁止开锁且状态不变", () => {
  const runtime = createDeviceToolRuntime();
  const result = runtime.invoke("control_device", {
    device_id: "lock.front_door",
    action: "unlock",
  });
  const state = runtime.invoke("get_state", { device_id: "lock.front_door" });

  assert.equal(result.success, false);
  assert.equal(result.error.code, "CONFIRMATION_REQUIRED");
  assert.equal(state.device.state, "locked");
});

test("明确确认后允许开锁", () => {
  const runtime = createDeviceToolRuntime();
  const result = runtime.invoke("control_device", {
    device_id: "lock.front_door",
    action: "unlock",
    confirmed: true,
  });

  assert.equal(result.success, true);
  assert.equal(result.new_state, "unlocked");
});

test("不可用设备不能被控制", () => {
  const homeAssistant = new MockHomeAssistant({
    devices: [
      {
        device_id: "light.offline",
        name: "离线灯",
        domain: "light",
        state: "off",
        available: false,
        attributes: { brightness: 0 },
      },
    ],
  });
  const runtime = createDeviceToolRuntime(homeAssistant);
  const result = runtime.invoke("control_device", {
    device_id: "light.offline",
    action: "turn_on",
  });

  assert.equal(result.success, false);
  assert.equal(result.error.code, "DEVICE_UNAVAILABLE");
});

test("成功控制会写入可审计记录，失败控制不会", () => {
  const runtime = createDeviceToolRuntime();
  runtime.invoke("control_device", {
    device_id: "light.living_room",
    action: "turn_on",
  });
  runtime.invoke("control_device", {
    device_id: "lock.front_door",
    action: "unlock",
  });

  const auditLog = runtime.homeAssistant.getAuditLog();
  assert.equal(auditLog.length, 1);
  assert.equal(auditLog[0].device_id, "light.living_room");
});

test("控制和失败动作会写入可查询的标准事件", () => {
  const runtime = createDeviceToolRuntime();
  const control = runtime.invoke("control_device", {
    device_id: "light.living_room",
    action: "turn_on",
    task_id: "task-events-001",
    trace_id: "trace-events-001",
    idempotency_key: "idem-events-001",
  });
  const blocked = runtime.invoke("control_device", {
    device_id: "lock.front_door",
    action: "unlock",
    trace_id: "trace-events-002",
  });
  const events = runtime.invoke("get_device_events", { limit: 10 });
  const tracedEvents = runtime.invoke("get_device_events", { trace_id: "trace-events-001" });

  assert.equal(control.success, true);
  assert.equal(blocked.error.code, "CONFIRMATION_REQUIRED");
  assert.equal(events.success, true);
  assert.equal(events.events.length, 2);
  assert.deepEqual(events.events.map((event) => event.event_type), ["action_failed", "action_executed"]);
  assert.equal(events.events[0].trace_id, "trace-events-002");
  assert.equal(events.events[1].payload.verified, true);
  assert.equal(events.events[1].payload.task_id, "task-events-001");
  assert.equal(events.events[1].data_level, "L0");
  assert.equal(events.events[1].schema_version, "0.1");
  assert.equal(events.events[1].source_agent, "device-manager");
  assert.equal(events.events[1].privacy_level, "family");
  assert.equal(tracedEvents.events.length, 1);
  assert.equal(tracedEvents.events[0].event_id, events.events[1].event_id);
});

test("诊断异常会产生 diagnostic_alert 事件", () => {
  const homeAssistant = new MockHomeAssistant({
    devices: [{
      device_id: "light.inconsistent",
      name: "状态异常灯",
      domain: "light",
      state: "on",
      available: true,
      attributes: { brightness: 0 },
    }],
  });
  const runtime = createDeviceToolRuntime(homeAssistant);
  const diagnosis = runtime.invoke("diagnose_device", {
    device_id: "light.inconsistent",
    trace_id: "trace-diagnosis-001",
  });
  const events = runtime.invoke("get_device_events", {
    event_type: "diagnostic_alert",
    device_id: "light.inconsistent",
  });

  assert.equal(diagnosis.diagnoses[0].status, "abnormal");
  assert.equal(events.events.length, 1);
  assert.equal(events.events[0].trace_id, "trace-diagnosis-001");
  assert.equal(events.events[0].payload.code, "STATE_INCONSISTENT");
});

test("回家场景执行后逐项验证目标状态并写入审计记录", () => {
  const runtime = createDeviceToolRuntime();
  const result = runtime.invoke("run_scene", { scene_id: "home" });

  assert.equal(result.success, true);
  assert.equal(result.scene_name, "回家模式");
  assert.equal(result.executions.length, 4);
  assert.ok(result.verification.every((entry) => entry.verified));
  assert.equal(runtime.invoke("get_state", { device_id: "light.living_room" }).device.attributes.brightness, 70);
  assert.equal(runtime.invoke("get_state", { device_id: "cover.living_room_curtain" }).device.state, "open");
  assert.equal(runtime.invoke("get_state", { device_id: "climate.bedroom" }).device.state, "on");
  assert.equal(runtime.homeAssistant.getAuditLog().length, 4);
});

test("离家场景会关闭智能插座并逐项验证", () => {
  const runtime = createDeviceToolRuntime();
  const result = runtime.invoke("run_scene", { scene_id: "away" });

  assert.equal(result.success, true);
  assert.equal(result.scene_name, "离家模式");
  assert.ok(result.verification.every((entry) => entry.verified));
  assert.equal(runtime.invoke("get_state", { device_id: "switch.living_room_plug" }).device.state, "off");
});

test("场景预检发现离线设备时不执行任何部分动作", () => {
  const runtime = createDeviceToolRuntime();
  runtime.invoke("control_device", { device_id: "light.living_room", action: "turn_on" });
  runtime.invoke("control_device", { device_id: "cover.living_room_curtain", action: "open" });
  runtime.homeAssistant.devices.get("climate.bedroom").available = false;

  const result = runtime.invoke("run_scene", { scene_id: "sleep" });

  assert.equal(result.success, false);
  assert.equal(result.error.code, "SCENE_PREFLIGHT_FAILED");
  assert.equal(runtime.invoke("get_state", { device_id: "light.living_room" }).device.state, "on");
  assert.equal(runtime.invoke("get_state", { device_id: "cover.living_room_curtain" }).device.state, "open");
  assert.equal(runtime.homeAssistant.getAuditLog().length, 2);
});

test("未知场景返回明确错误，场景不包含开锁", () => {
  const runtime = createDeviceToolRuntime();
  const result = runtime.invoke("run_scene", { scene_id: "weekend" });

  assert.equal(result.success, false);
  assert.equal(result.error.code, "SCENE_NOT_FOUND");
  assert.equal(runtime.homeAssistant.getAuditLog().length, 0);
});

test("诊断在线设备返回 healthy 和证据", () => {
  const runtime = createDeviceToolRuntime();
  const result = runtime.invoke("diagnose_device", { device_id: "light.living_room" });

  assert.equal(result.success, true);
  assert.equal(result.count, 1);
  assert.equal(result.diagnoses[0].status, "healthy");
  assert.equal(result.diagnoses[0].code, "OK");
  assert.equal(result.diagnoses[0].evidence[0].field, "available");
});

test("诊断离线设备返回 offline 和处理建议", () => {
  const homeAssistant = new MockHomeAssistant({
    devices: [
      {
        device_id: "light.offline",
        name: "离线灯",
        domain: "light",
        state: "off",
        available: false,
        attributes: { brightness: 0 },
      },
    ],
  });
  const runtime = createDeviceToolRuntime(homeAssistant);
  const result = runtime.invoke("diagnose_device", { device_id: "light.offline" });

  assert.equal(result.success, true);
  assert.equal(result.diagnoses[0].status, "offline");
  assert.equal(result.diagnoses[0].code, "DEVICE_OFFLINE");
  assert.ok(result.diagnoses[0].recommendations.length > 0);
});

test("诊断在线但状态属性不一致的设备返回 abnormal", () => {
  const homeAssistant = new MockHomeAssistant({
    devices: [
      {
        device_id: "light.inconsistent",
        name: "状态异常灯",
        domain: "light",
        state: "on",
        available: true,
        attributes: { brightness: 0 },
      },
    ],
  });
  const runtime = createDeviceToolRuntime(homeAssistant);
  const result = runtime.invoke("diagnose_device", { device_id: "light.inconsistent" });

  assert.equal(result.success, true);
  assert.equal(result.diagnoses[0].status, "abnormal");
  assert.equal(result.diagnoses[0].code, "STATE_INCONSISTENT");
  assert.ok(result.diagnoses[0].evidence.length > 1);
});

test("诊断全部设备返回汇总且不改变设备或审计记录", () => {
  const runtime = createDeviceToolRuntime();
  const result = runtime.invoke("diagnose_device");

  assert.equal(result.success, true);
  assert.equal(result.count, 10);
  assert.equal(result.summary.healthy, 10);
  assert.equal(result.summary.offline, 0);
  assert.equal(runtime.homeAssistant.getAuditLog().length, 0);
});

test("未知工具返回 TOOL_NOT_FOUND", () => {
  const runtime = createDeviceToolRuntime();
  const result = runtime.invoke("delete_home", {});

  assert.equal(result.success, false);
  assert.equal(result.error.code, "TOOL_NOT_FOUND");
});
