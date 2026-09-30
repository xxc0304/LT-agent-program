import assert from "node:assert/strict";
import test from "node:test";

import { createOrchestratorBridge } from "../src/orchestrator-bridge.js";
import { MockHomeAssistant } from "../src/mock-ha.js";
import { createDeviceToolRuntime } from "../src/tools.js";

function makeEvent(overrides = {}) {
  const occurredAt = new Date().toISOString();
  return {
    schema_version: "0.1",
    event_id: "evt-openclaw-bridge-001",
    source_agent: "learning-companion",
    event_type: "learning_behavior",
    occurred_at: occurredAt,
    received_at: new Date().toISOString(),
    confidence: 0.95,
    needs_review: false,
    privacy_level: "restricted",
    data_level: "L3",
    trace_id: "trace-openclaw-bridge-001",
    payload: {
      behavior: "standing",
      presence: "away_from_desk",
      area: "living_room",
      duration_ms: 600_000,
      evidence: "连续多帧未检测到孩子在书桌区域",
    },
    ...overrides,
  };
}

test("OpenClaw bridge 将学习事件路由到节能和设备管家", async () => {
  const homeAssistant = new MockHomeAssistant();
  const deviceRuntime = createDeviceToolRuntime(homeAssistant);
  const bridge = createOrchestratorBridge(deviceRuntime, {
    trustedOccupancySourceAgents: ["ha-event-adapter"],
  });
  deviceRuntime.invoke("control_device", {
    device_id: "light.living_room",
    action: "turn_on",
  });

  const event = makeEvent();
  await bridge.dispatchEvent({
    schema_version: "0.1",
    event_id: "evt-bridge-ha-confirmation",
    source_agent: "ha-event-adapter",
    event_type: "occupancy_changed",
    occurred_at: event.occurred_at,
    privacy_level: "family",
    payload: { area: "living_room", occupied: false, observed_for_ms: 60_000 },
  });
  const trace = await bridge.dispatchEvent(event);

  assert.equal(trace.status, "SUCCEEDED");
  assert.deepEqual(trace.agents_involved, [
    "learning-companion",
    "energy-saving",
    "device-manager",
  ]);
  assert.equal(trace.receipts[0].result.verified, true);
  assert.equal(homeAssistant.getState({ device_id: "light.living_room" }).device.state, "off");
});

test("OpenClaw bridge 默认不信任未配置来源，视觉事件无独立佐证时不控制设备", async () => {
  const homeAssistant = new MockHomeAssistant();
  const deviceRuntime = createDeviceToolRuntime(homeAssistant);
  const bridge = createOrchestratorBridge(deviceRuntime);
  deviceRuntime.invoke("control_device", {
    device_id: "light.living_room",
    action: "turn_on",
  });

  const event = makeEvent();
  await bridge.dispatchEvent({
    schema_version: "0.1",
    event_id: "evt-bridge-untrusted-ha",
    source_agent: "ha-event-adapter",
    event_type: "occupancy_changed",
    occurred_at: event.occurred_at,
    privacy_level: "family",
    payload: { area: "living_room", occupied: false, observed_for_ms: 60_000 },
  });
  const trace = await bridge.dispatchEvent(event);

  assert.equal(trace.status, "NO_ACTION");
  assert.equal(trace.receipts.length, 0);
  assert.equal(homeAssistant.getState({ device_id: "light.living_room" }).device.state, "on");
});

test("OpenClaw bridge 对低置信度事件不执行设备控制", async () => {
  const homeAssistant = new MockHomeAssistant();
  const deviceRuntime = createDeviceToolRuntime(homeAssistant);
  const bridge = createOrchestratorBridge(deviceRuntime);
  deviceRuntime.invoke("control_device", {
    device_id: "light.living_room",
    action: "turn_on",
  });

  const trace = await bridge.dispatchEvent(makeEvent({
    event_id: "evt-openclaw-bridge-low-confidence",
    trace_id: "trace-openclaw-bridge-low-confidence",
    confidence: 0.4,
    needs_review: true,
  }));

  assert.equal(trace.status, "NO_ACTION");
  assert.equal(trace.receipts.length, 0);
  assert.equal(homeAssistant.getState({ device_id: "light.living_room" }).device.state, "on");
});

test("OpenClaw bridge 按订阅关系路由占用、离家和手动覆盖事件", async () => {
  {
    const homeAssistant = new MockHomeAssistant();
    const deviceRuntime = createDeviceToolRuntime(homeAssistant);
    const bridge = createOrchestratorBridge(deviceRuntime);
    deviceRuntime.invoke("control_device", {
      device_id: "light.living_room",
      action: "turn_on",
    });

    const trace = await bridge.dispatchEvent(makeEvent({
      event_id: "evt-occupancy-route",
      source_agent: "ha-event-adapter",
      event_type: "occupancy_changed",
      confidence: undefined,
      needs_review: undefined,
      payload: {
        area: "living_room",
        occupied: false,
        observed_for_ms: 600_000,
      },
    }));

    assert.ok(trace.agents_involved.includes("energy-saving"));
    assert.ok(trace.agents_involved.includes("device-manager"));
    assert.equal(homeAssistant.getState({ device_id: "light.living_room" }).device.state, "off");
  }

  {
    const homeAssistant = new MockHomeAssistant();
    const deviceRuntime = createDeviceToolRuntime(homeAssistant);
    const bridge = createOrchestratorBridge(deviceRuntime);
    deviceRuntime.invoke("control_device", {
      device_id: "light.living_room",
      action: "turn_on",
    });

    const trace = await bridge.dispatchEvent(makeEvent({
      event_id: "evt-away-route",
      source_agent: "home-mode-adapter",
      event_type: "home_mode_changed",
      confidence: undefined,
      needs_review: undefined,
      payload: { mode: "away" },
    }));

    assert.ok(trace.agents_involved.includes("energy-saving"));
    assert.ok(trace.agents_involved.includes("device-manager"));
    assert.equal(homeAssistant.getState({ device_id: "light.living_room" }).device.state, "off");
  }

  {
    const homeAssistant = new MockHomeAssistant();
    const deviceRuntime = createDeviceToolRuntime(homeAssistant);
    const bridge = createOrchestratorBridge(deviceRuntime);
    deviceRuntime.invoke("control_device", {
      device_id: "light.living_room",
      action: "turn_on",
    });

    const overrideTrace = await bridge.dispatchEvent(makeEvent({
      event_id: "evt-user-override-route",
      source_agent: "user",
      event_type: "user_device_override",
      confidence: undefined,
      needs_review: undefined,
      payload: { device_id: "light.living_room", hold_ms: 60_000 },
    }));
    const occupancyTrace = await bridge.dispatchEvent(makeEvent({
      event_id: "evt-occupancy-during-hold",
      source_agent: "ha-event-adapter",
      event_type: "occupancy_changed",
      confidence: undefined,
      needs_review: undefined,
      payload: {
        area: "living_room",
        occupied: false,
        observed_for_ms: 600_000,
      },
    }));

    assert.ok(overrideTrace.agents_involved.includes("energy-saving"));
    assert.equal(occupancyTrace.receipts.length, 0);
    assert.equal(homeAssistant.getState({ device_id: "light.living_room" }).device.state, "on");
  }
});

test("OpenClaw bridge 拒绝把图片或密钥放入跨 Agent Event", async () => {
  const homeAssistant = new MockHomeAssistant();
  const deviceRuntime = createDeviceToolRuntime(homeAssistant);
  const bridge = createOrchestratorBridge(deviceRuntime);
  const trace = await bridge.dispatchEvent(makeEvent({
    event_id: "evt-openclaw-bridge-unsafe",
    payload: {
      ...makeEvent().payload,
      image_url: "data:image/jpeg;base64,not-an-event-field",
    },
  }));

  assert.equal(trace.status, "REJECTED");
  assert.equal(trace.errors[0].code, "UNSAFE_EVENT_INPUT");
  assert.equal(homeAssistant.getAuditLog().length, 0);
});
