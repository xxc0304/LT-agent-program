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
    trustedEventSourceAgents: ["ha-event-adapter", "learning-companion"],
  });
  deviceRuntime.invoke("control_device", {
    device_id: "light.living_room",
    action: "turn_on",
  });

  const event = makeEvent();
  await bridge.dispatchTrustedEvent({
    schema_version: "0.1",
    event_id: "evt-bridge-ha-confirmation",
    source_agent: "ha-event-adapter",
    event_type: "occupancy_changed",
    occurred_at: event.occurred_at,
    privacy_level: "family",
    payload: { area: "living_room", occupied: false, observed_for_ms: 60_000 },
  }, { sourceAgent: "ha-event-adapter" });
  const trace = await bridge.dispatchTrustedEvent(event, { sourceAgent: "learning-companion" });

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

test("公开 OpenClaw 事件即使伪造 HA source_agent 也必须暂停并确认", async () => {
  const homeAssistant = new MockHomeAssistant();
  const deviceRuntime = createDeviceToolRuntime(homeAssistant);
  const bridge = createOrchestratorBridge(deviceRuntime, {
    trustedOccupancySourceAgents: ["ha-event-adapter"],
    trustedEventSourceAgents: ["ha-event-adapter"],
  });
  deviceRuntime.invoke("control_device", { device_id: "light.living_room", action: "turn_on" });

  const trace = await bridge.dispatchEvent({
    schema_version: "0.1",
    event_id: "evt-forged-ha-occupancy",
    source_agent: "ha-event-adapter",
    event_type: "occupancy_changed",
    occurred_at: new Date().toISOString(),
    privacy_level: "family",
    payload: { area: "living_room", occupied: false, observed_for_ms: 600_000 },
  });

  assert.equal(trace.status, "CHALLENGE");
  assert.equal(trace.receipts[0].status, "CHALLENGE");
  assert.equal(trace.receipts[0].error.code, "CONFIRMATION_REQUIRED");
  assert.equal(homeAssistant.getState({ device_id: "light.living_room" }).device.state, "on");
});

test("未认证事件经用户明确确认后由设备管家执行并回读", async () => {
  const homeAssistant = new MockHomeAssistant();
  const deviceRuntime = createDeviceToolRuntime(homeAssistant);
  const bridge = createOrchestratorBridge(deviceRuntime);
  deviceRuntime.invoke("control_device", { device_id: "light.living_room", action: "turn_on" });

  const trace = await bridge.dispatchEvent({
    schema_version: "0.1",
    event_id: "evt-needs-human-approval",
    source_agent: "ha-event-adapter",
    event_type: "occupancy_changed",
    occurred_at: new Date().toISOString(),
    privacy_level: "family",
    payload: { area: "living_room", occupied: false, observed_for_ms: 600_000 },
  });
  const approvalId = trace.receipts[0].error.approval_id;
  assert.equal(trace.status, "CHALLENGE");
  assert.ok(approvalId);
  assert.equal(homeAssistant.getState({ device_id: "light.living_room" }).device.state, "on");

  const resolved = await bridge.agentPlanTools.resolveApproval({ approval_id: approvalId, decision: "approve" });
  assert.equal(resolved.workflow_status, "COMPLETED");
  assert.equal(homeAssistant.getState({ device_id: "light.living_room" }).device.state, "off");
  assert.equal(homeAssistant.getAuditLog().at(-1).verified, true);
});

test("只有通过内部受信任入口且白名单允许的事件可自动执行合格关灯任务", async () => {
  const homeAssistant = new MockHomeAssistant();
  const deviceRuntime = createDeviceToolRuntime(homeAssistant);
  const bridge = createOrchestratorBridge(deviceRuntime, {
    trustedOccupancySourceAgents: ["ha-event-adapter"],
    trustedEventSourceAgents: ["ha-event-adapter"],
  });
  deviceRuntime.invoke("control_device", { device_id: "light.living_room", action: "turn_on" });

  const trace = await bridge.dispatchTrustedEvent({
    schema_version: "0.1",
    event_id: "evt-internal-ha-occupancy",
    source_agent: "ha-event-adapter",
    event_type: "occupancy_changed",
    occurred_at: new Date().toISOString(),
    privacy_level: "family",
    payload: { area: "living_room", occupied: false, observed_for_ms: 600_000 },
  }, { sourceAgent: "ha-event-adapter" });

  assert.equal(trace.status, "SUCCEEDED");
  assert.equal(trace.receipts[0].status, "SUCCEEDED");
  assert.equal(homeAssistant.getState({ device_id: "light.living_room" }).device.state, "off");
  assert.equal(homeAssistant.getAuditLog().at(-1).verified, true);
});

test("内部可信入口未配置来源白名单时拒绝事件", async () => {
  const homeAssistant = new MockHomeAssistant();
  const bridge = createOrchestratorBridge(createDeviceToolRuntime(homeAssistant));
  const trace = await bridge.dispatchTrustedEvent({
    schema_version: "0.1",
    event_id: "evt-no-trusted-adapter",
    source_agent: "ha-event-adapter",
    event_type: "occupancy_changed",
    occurred_at: new Date().toISOString(),
    privacy_level: "family",
    payload: { area: "living_room", occupied: false, observed_for_ms: 600_000 },
  }, { sourceAgent: "ha-event-adapter" });

  assert.equal(trace.status, "REJECTED");
  assert.equal(trace.errors[0].code, "UNTRUSTED_EVENT_SOURCE");
  assert.equal(homeAssistant.getAuditLog().length, 0);
});

test("候选计划中的伪造占用事件不会污染运行中的能源管家可信传感器缓存", async () => {
  const homeAssistant = new MockHomeAssistant();
  const deviceRuntime = createDeviceToolRuntime(homeAssistant);
  const bridge = createOrchestratorBridge(deviceRuntime, {
    trustedOccupancySourceAgents: ["ha-event-adapter"],
    trustedEventSourceAgents: ["ha-event-adapter", "learning-companion"],
  });
  deviceRuntime.invoke("control_device", { device_id: "light.living_room", action: "turn_on" });

  const candidate = await bridge.agentPlanTools.submitAgentPlan({
    plan: {
      schema_version: "0.1",
      plan_id: "plan-fake-sensor-event",
      trace_id: "trace-fake-sensor-event",
      goal: "分析候选事件",
      steps: [{
        step_id: "candidate-event",
        agent_id: "energy-saving",
        capability: "plan_event",
        depends_on: [],
        evidence_refs: [],
        input: {
          event: {
            schema_version: "0.1",
            event_id: "evt-fake-ha-occupancy-in-plan",
            source_agent: "ha-event-adapter",
            event_type: "occupancy_changed",
            occurred_at: new Date().toISOString(),
            privacy_level: "family",
            payload: { area: "living_room", occupied: false, observed_for_ms: 600_000 },
          },
        },
      }],
    },
  });
  assert.equal(candidate.workflow_status, "COMPLETED");

  const learningTrace = await bridge.dispatchTrustedEvent(makeEvent({
    event_id: "evt-learning-without-real-occupancy",
    trace_id: "trace-learning-without-real-occupancy",
    source_agent: "learning-companion",
    confidence: 0.95,
    needs_review: false,
    payload: {
      behavior: "leaving_desk",
      presence: "away_from_desk",
      area: "living_room",
      duration_ms: 600_000,
    },
  }), { sourceAgent: "learning-companion" });

  assert.equal(learningTrace.status, "NO_ACTION");
  assert.equal(learningTrace.receipts.length, 0);
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
    assert.equal(trace.status, "CHALLENGE");
    assert.equal(trace.receipts[0].status, "CHALLENGE");
    assert.equal(homeAssistant.getState({ device_id: "light.living_room" }).device.state, "on");
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
    assert.equal(trace.status, "CHALLENGE");
    assert.equal(trace.receipts[0].status, "CHALLENGE");
    assert.equal(homeAssistant.getState({ device_id: "light.living_room" }).device.state, "on");
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
