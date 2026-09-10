import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MockHomeAssistant } from "../src/mock-ha.js";
import { createDeviceToolRuntime, DEVICE_TOOL_DEFINITIONS } from "../src/tools.js";

test("暴露五个基础设备工具", () => {
  assert.deepEqual(
    DEVICE_TOOL_DEFINITIONS.map((tool) => tool.name),
    ["list_devices", "get_state", "control_device", "run_scene", "diagnose_device"],
  );
});

test("OpenClaw manifest 声明相同的五个工具", () => {
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
  assert.equal(result.count, 4);
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
  assert.equal(result.count, 4);
  assert.equal(result.summary.healthy, 4);
  assert.equal(result.summary.offline, 0);
  assert.equal(runtime.homeAssistant.getAuditLog().length, 0);
});

test("未知工具返回 TOOL_NOT_FOUND", () => {
  const runtime = createDeviceToolRuntime();
  const result = runtime.invoke("delete_home", {});

  assert.equal(result.success, false);
  assert.equal(result.error.code, "TOOL_NOT_FOUND");
});
