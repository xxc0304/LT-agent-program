import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MockHomeAssistant } from "../src/mock-ha.js";
import { createDeviceToolRuntime, DEVICE_TOOL_DEFINITIONS } from "../src/tools.js";

test("暴露三个基础设备工具", () => {
  assert.deepEqual(
    DEVICE_TOOL_DEFINITIONS.map((tool) => tool.name),
    ["list_devices", "get_state", "control_device"],
  );
});

test("OpenClaw manifest 声明相同的三个工具", () => {
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

test("未知工具返回 TOOL_NOT_FOUND", () => {
  const runtime = createDeviceToolRuntime();
  const result = runtime.invoke("delete_home", {});

  assert.equal(result.success, false);
  assert.equal(result.error.code, "TOOL_NOT_FOUND");
});
