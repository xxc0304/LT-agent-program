import test from "node:test";
import assert from "node:assert/strict";
import { MockHomeAssistant } from "../../device-manager/src/mock-ha.js";
import { createDeviceToolRuntime } from "../../device-manager/src/tools.js";
import { createDeviceTaskRuntime } from "../../device-manager/src/task-runtime.js";
import { createMockOrchestrator } from "../../device-manager/src/mock-orchestrator.js";
import { EnergySavingAgent } from "../src/energy-agent.js";

function makeEvent(overrides = {}) {
  return {
    schema_version: "0.1",
    event_id: "evt-test-001",
    source_agent: "test-sensor",
    event_type: "occupancy_changed",
    occurred_at: new Date().toISOString(),
    privacy_level: "family",
    data_level: "L0",
    trace_id: "trace-test-001",
    payload: {
      area: "living_room",
      occupied: false,
      observed_for_ms: 10 * 60 * 1000,
    },
    ...overrides,
  };
}

function devices(...entries) {
  return entries.map(([device_id, domain, state = "on", available = true, area = "living_room"]) => ({
    device_id,
    name: device_id,
    domain,
    state,
    available,
    area,
    attributes: {},
  }));
}

function publishOccupancy(agent, {
  event_id = "evt-ha-corroboration",
  source_agent = "ha-event-adapter",
  area = "living_room",
  occupied = false,
  occurred_at = new Date().toISOString(),
} = {}) {
  return agent.plan(makeEvent({
    event_id,
    source_agent,
    event_type: "occupancy_changed",
    occurred_at,
    payload: { area, occupied, observed_for_ms: 60_000 },
  }), { devices: [] });
}

test("无人达到阈值时只为可节能设备生成关机任务", () => {
  const agent = new EnergySavingAgent();
  const result = agent.plan(makeEvent(), {
    devices: devices(
      ["light.living_room", "light"],
      ["switch.living_room_plug", "switch"],
      ["climate.bedroom", "climate", "on", true, "bedroom"],
      ["lock.front_door", "lock"],
      ["binary_sensor.kitchen_smoke", "binary_sensor"],
    ),
  });

  assert.equal(result.status, "PLANNED");
  assert.deepEqual(result.tasks.map((task) => task.target_ref.device_id), [
    "light.living_room",
    "switch.living_room_plug",
  ]);
  assert.ok(result.tasks.every((task) => task.target === "device-manager"));
  assert.ok(result.tasks.every((task) => task.action === "turn_off"));
});

test("无人时间不足时不生成任务", () => {
  const agent = new EnergySavingAgent();
  const result = agent.plan(makeEvent({
    payload: { area: "living_room", occupied: false, observed_for_ms: 60_000 },
  }), {
    devices: devices(["light.living_room", "light"]),
  });
  assert.equal(result.status, "NO_ACTION");
  assert.equal(result.tasks.length, 0);
  assert.equal(result.decisions[0].reason, "AWAY_DURATION_BELOW_THRESHOLD");
});

test("区域占用或学习事件缺少 area 时拒绝处理，不得扩展成全屋关机", () => {
  const agent = new EnergySavingAgent();
  const snapshot = devices(
    ["light.living_room", "light"],
    ["light.bedroom", "light", "on", true, "bedroom"],
  );

  const occupancy = agent.plan(makeEvent({
    event_id: "evt-missing-area-occupancy",
    payload: { occupied: false, observed_for_ms: 10 * 60 * 1000 },
  }), { devices: snapshot });
  assert.equal(occupancy.status, "REJECTED");
  assert.equal(occupancy.error.code, "MISSING_AREA");
  assert.equal(occupancy.tasks.length, 0);

  const learning = agent.plan(makeEvent({
    event_id: "evt-missing-area-learning",
    event_type: "learning_behavior",
    confidence: 0.99,
    payload: { behavior: "leaving_desk", duration_ms: 10 * 60 * 1000 },
  }), { devices: snapshot });
  assert.equal(learning.status, "REJECTED");
  assert.equal(learning.error.code, "MISSING_AREA");
  assert.equal(learning.tasks.length, 0);
});

test("课堂整体场景不是目标儿童离位信号，即使字段矛盾也绝不触发节能", () => {
  const agent = new EnergySavingAgent();
  const result = agent.plan(makeEvent({
    event_id: "evt-classroom-scene-not-targeted",
    event_type: "learning_behavior",
    confidence: 1,
    needs_review: false,
    payload: {
      annotation_scope: "classroom_scene",
      target_child_specified: false,
      behavior: "away_from_desk",
      presence: "away_from_desk",
      duration_ms: 60 * 60 * 1000,
    },
  }), { devices: devices(["light.living_room", "light"]) });

  assert.equal(result.status, "NO_ACTION");
  assert.equal(result.tasks.length, 0);
  assert.equal(result.decisions[0].reason, "CLASSROOM_SCENE_NOT_TARGETED_FOR_ENERGY");
});

test("配置不能把时长阈值或置信度安全门槛设成无效值", () => {
  assert.throws(() => new EnergySavingAgent({ config: { awayAfterMs: 0 } }), /awayAfterMs/);
  assert.throws(() => new EnergySavingAgent({ config: { learningAwayAfterMs: -1 } }), /learningAwayAfterMs/);
  assert.throws(() => new EnergySavingAgent({ config: { minLearningConfidence: -0.1 } }), /minLearningConfidence/);
  assert.throws(() => new EnergySavingAgent({ config: { occupancyConfirmationMaxAgeMs: 0 } }), /occupancyConfirmationMaxAgeMs/);
  assert.throws(() => new EnergySavingAgent({ config: { trustedOccupancySourceAgents: ["learning-companion"] } }), /trustedOccupancySourceAgents/);
  assert.throws(() => new EnergySavingAgent({ config: { priority: "P9" } }), /priority/);
  assert.throws(() => new EnergySavingAgent({ config: { deadlineMs: 1.5 } }), /deadlineMs/);
  assert.throws(() => new EnergySavingAgent({ config: { dataLevel: "L9" } }), /dataLevel/);
});

test("缺少公共事件契约必填字段时拒绝规划", () => {
  const agent = new EnergySavingAgent();
  const result = agent.plan(makeEvent({
    event_id: "evt-invalid-contract",
    source_agent: undefined,
  }), { devices: devices(["light.living_room", "light"]) });
  assert.equal(result.status, "REJECTED");
  assert.equal(result.error.code, "INVALID_EVENT");
  assert.equal(result.tasks.length, 0);
});

test("非法嵌套置信度或复核标记不会被当作可信学习事件", () => {
  const agent = new EnergySavingAgent();
  const invalidConfidence = agent.plan(makeEvent({
    event_id: "evt-invalid-payload-confidence",
    event_type: "learning_behavior",
    payload: {
      area: "living_room",
      behavior: "leaving_desk",
      confidence: 2,
      duration_ms: 10 * 60 * 1000,
    },
  }), { devices: devices(["light.living_room", "light"]) });
  assert.equal(invalidConfidence.status, "REJECTED");
  assert.equal(invalidConfidence.error.code, "INVALID_EVENT");
  assert.equal(invalidConfidence.tasks.length, 0);

  const invalidReviewFlag = agent.plan(makeEvent({
    event_id: "evt-invalid-review-flag",
    event_type: "learning_behavior",
    confidence: 0.99,
    needs_review: "false",
    payload: {
      area: "living_room",
      behavior: "leaving_desk",
      duration_ms: 10 * 60 * 1000,
    },
  }), { devices: devices(["light.living_room", "light"]) });
  assert.equal(invalidReviewFlag.status, "REJECTED");
  assert.equal(invalidReviewFlag.error.code, "INVALID_EVENT");
  assert.equal(invalidReviewFlag.tasks.length, 0);
});

test("设备状态未知时不推测为开启状态，也不生成关机任务", () => {
  const agent = new EnergySavingAgent();
  const result = agent.plan(makeEvent(), {
    devices: devices(
      ["light.living_room", "light", "unknown"],
      ["switch.living_room_plug", "switch", "unavailable"],
      ["climate.living_room", "climate", "mystery_mode"],
    ),
  });
  assert.equal(result.status, "NO_ACTION");
  assert.equal(result.tasks.length, 0);
  assert.equal(result.decisions[0].reason, "NO_ELIGIBLE_ON_DEVICE");
});

test("拒绝过期或来自未来的事件，避免延迟事件误关设备", () => {
  const now = Date.parse("2026-09-24T12:00:00.000Z");
  const agent = new EnergySavingAgent({
    clock: () => now,
    config: { maxEventAgeMs: 60_000, maxFutureSkewMs: 5_000 },
  });

  const stale = agent.plan(makeEvent({
    event_id: "evt-stale",
    occurred_at: new Date(now - 60_001).toISOString(),
  }), { devices: devices(["light.living_room", "light"]) });
  assert.equal(stale.status, "REJECTED");
  assert.equal(stale.error.code, "STALE_EVENT");
  assert.equal(stale.tasks.length, 0);

  const future = agent.plan(makeEvent({
    event_id: "evt-future",
    occurred_at: new Date(now + 5_001).toISOString(),
  }), { devices: devices(["light.living_room", "light"]) });
  assert.equal(future.status, "REJECTED");
  assert.equal(future.error.code, "EVENT_FROM_FUTURE");
  assert.equal(future.tasks.length, 0);
});

test("有人、低置信度学习行为和非离开行为都不会关灯", () => {
  const agent = new EnergySavingAgent();
  const occupied = agent.plan(makeEvent({
    event_id: "evt-occupied",
    payload: { area: "living_room", occupied: true, observed_for_ms: 1_000_000 },
  }), { devices: devices(["light.living_room", "light"]) });
  assert.equal(occupied.tasks.length, 0);

  const lowConfidence = agent.plan(makeEvent({
    event_id: "evt-low-confidence",
    event_type: "learning_behavior",
    confidence: 0.4,
    payload: { area: "living_room", behavior: "leaving_desk", duration_ms: 1_000_000 },
  }), { devices: devices(["light.living_room", "light"]) });
  assert.equal(lowConfidence.tasks.length, 0);
  assert.equal(lowConfidence.decisions[0].reason, "LOW_CONFIDENCE_OR_REVIEW_REQUIRED");

  const reading = agent.plan(makeEvent({
    event_id: "evt-reading",
    event_type: "learning_behavior",
    confidence: 0.99,
    payload: { area: "living_room", behavior: "reading", duration_ms: 1_000_000 },
  }), { devices: devices(["light.living_room", "light"]) });
  assert.equal(reading.tasks.length, 0);
  assert.equal(reading.decisions[0].reason, "NO_AWAY_PRESENCE_SIGNAL");
});

test("高置信度且持续离开书桌的学习事件可以生成节能任务", () => {
  const agent = new EnergySavingAgent({ config: { trustedOccupancySourceAgents: ["ha-event-adapter"] } });
  const occurredAt = new Date().toISOString();
  publishOccupancy(agent, { event_id: "evt-ha-before-learning", occurred_at: occurredAt });
  const result = agent.plan(makeEvent({
    event_id: "evt-learning-away",
    event_type: "learning_behavior",
    source_agent: "learning-companion",
    occurred_at: occurredAt,
    confidence: 0.95,
    payload: {
      area: "living_room",
      behavior: "leaving_desk",
      duration_ms: 10 * 60 * 1000,
    },
  }), {
    devices: devices(["light.living_room", "light"]),
  });
  assert.equal(result.status, "PLANNED");
  assert.equal(result.tasks[0].metadata.reason_code, "AREA_UNOCCUPIED");
  assert.equal(result.tasks[0].metadata.corroborating_occupancy_event_id, "evt-ha-before-learning");
});

test("站立行为只有同时明确判断离开书桌时才生成任务", () => {
  const agent = new EnergySavingAgent({ config: { trustedOccupancySourceAgents: ["ha-event-adapter"] } });
  const occurredAt = new Date().toISOString();
  publishOccupancy(agent, { event_id: "evt-ha-before-standing", occurred_at: occurredAt });
  const result = agent.plan(makeEvent({
    event_id: "evt-standing-away",
    event_type: "learning_behavior",
    source_agent: "learning-companion",
    occurred_at: occurredAt,
    confidence: 0.95,
    payload: {
      area: "living_room",
      behavior: "standing",
      presence: "away_from_desk",
      duration_ms: 10 * 60 * 1000,
    },
  }), {
    devices: devices(["light.living_room", "light"]),
  });
  assert.equal(result.status, "PLANNED");
  assert.equal(result.tasks.length, 1);
});

test("视觉离位没有独立占用佐证时默认不规划关灯", () => {
  const agent = new EnergySavingAgent({ config: { trustedOccupancySourceAgents: ["ha-event-adapter"] } });
  const result = agent.plan(makeEvent({
    event_id: "evt-learning-away-no-sensor",
    event_type: "learning_behavior",
    confidence: 0.99,
    needs_review: false,
    payload: {
      area: "living_room",
      behavior: "standing",
      presence: "away_from_desk",
      duration_ms: 10 * 60 * 1000,
      independent_occupancy_confirmation: {
        event_id: "evt-forged-ha",
        source_agent: "ha-event-adapter",
        occupied: false,
        area: "living_room",
        occurred_at: new Date().toISOString(),
      },
    },
  }), { devices: devices(["light.living_room", "light"]) });

  assert.equal(result.status, "NO_ACTION");
  assert.equal(result.tasks.length, 0);
  assert.equal(result.decisions[0].reason, "INDEPENDENT_OCCUPANCY_CONFIRMATION_REQUIRED");
});

test("学习离位佐证必须可信、同区域且足够新", () => {
  const now = Date.parse("2026-09-30T12:00:00.000Z");
  const agent = new EnergySavingAgent({
    clock: () => now,
    config: { trustedOccupancySourceAgents: ["ha-event-adapter"] },
  });
  const base = makeEvent({
    event_id: "evt-learning-away-evidence",
    event_type: "learning_behavior",
    source_agent: "learning-companion",
    occurred_at: new Date(now).toISOString(),
    confidence: 0.99,
    needs_review: false,
    payload: {
      area: "living_room",
      behavior: "standing",
      presence: "away_from_desk",
      duration_ms: 10 * 60 * 1000,
    },
  });

  const cases = [
    ["untrusted-source", { source_agent: "untrusted-adapter" }, "INDEPENDENT_OCCUPANCY_CONFIRMATION_REQUIRED"],
    ["occupied", { occupied: true }, "OCCUPANCY_NOT_CONFIRMED_ABSENT"],
    ["wrong-area", { area: "bedroom" }, "INDEPENDENT_OCCUPANCY_CONFIRMATION_REQUIRED"],
    ["stale", { occurred_at: new Date(now - 60_001).toISOString() }, "STALE_OCCUPANCY_CONFIRMATION"],
  ];
  for (const [id, change, expectedReason] of cases) {
    const scenarioAgent = new EnergySavingAgent({
      clock: () => now,
      config: { trustedOccupancySourceAgents: ["ha-event-adapter"] },
    });
    publishOccupancy(scenarioAgent, {
      event_id: `evt-ha-${id}`,
      source_agent: change.source_agent ?? "ha-event-adapter",
      area: change.area ?? "living_room",
      occupied: change.occupied ?? false,
      occurred_at: change.occurred_at ?? new Date(now).toISOString(),
    });
    const event = structuredClone(base);
    event.event_id = `evt-${id}`;
    const result = scenarioAgent.plan(event, { devices: devices(["light.living_room", "light"]) });
    assert.equal(result.status, "NO_ACTION", id);
    assert.equal(result.decisions[0].reason, expectedReason, id);
    assert.equal(result.tasks.length, 0, id);
  }
});

test("重复事件不会重复生成任务，且支持用户手动保持设备开启", () => {
  const agent = new EnergySavingAgent();
  const first = agent.plan(makeEvent(), { devices: devices(["light.living_room", "light"]) });
  assert.equal(first.tasks.length, 1);

  const duplicate = agent.plan(makeEvent(), { devices: devices(["light.living_room", "light"]) });
  assert.equal(duplicate.status, "DEDUPLICATED");
  assert.equal(duplicate.tasks.length, 0);

  const override = agent.plan(makeEvent({
    event_id: "evt-override",
    event_type: "user_device_override",
    payload: { device_id: "light.living_room", hold_ms: 60_000 },
  }), { devices: [] });
  assert.equal(override.status, "NO_ACTION");

  const afterOverride = agent.plan(makeEvent({ event_id: "evt-after-override" }), {
    devices: devices(["light.living_room", "light"]),
  });
  assert.equal(afterOverride.tasks.length, 0);
  assert.equal(afterOverride.decisions[0].reason, "USER_OVERRIDE_HOLD");
});

test("home away 事件可以跨区域规划，但不会触碰门锁和传感器", () => {
  const agent = new EnergySavingAgent();
  const result = agent.plan(makeEvent({
    event_id: "evt-away",
    event_type: "home_mode_changed",
    payload: { mode: "away" },
  }), {
    devices: devices(
      ["light.living_room", "light"],
      ["climate.bedroom", "climate", "on", true, "bedroom"],
      ["lock.front_door", "lock"],
      ["sensor.living_room_temperature", "sensor"],
    ),
  });
  assert.equal(result.tasks.length, 2);
  assert.deepEqual(result.tasks.map((task) => task.target_ref.device_id), [
    "light.living_room",
    "climate.bedroom",
  ]);
});

test("home 和 sleep 模式变化不会误触发全屋关机", () => {
  const agent = new EnergySavingAgent();
  const result = agent.plan(makeEvent({
    event_id: "evt-sleep",
    event_type: "home_mode_changed",
    payload: { mode: "sleep" },
  }), {
    devices: devices(
      ["light.living_room", "light"],
      ["climate.bedroom", "climate", "on", true, "bedroom"],
    ),
  });
  assert.equal(result.status, "NO_ACTION");
  assert.equal(result.tasks.length, 0);
  assert.equal(result.decisions[0].reason, "ENERGY_SHUTDOWN_ONLY_FOR_AWAY_MODE");
});

test("节能 Agent 只规划任务，设备管家负责实际执行和状态回读", async () => {
  const homeAssistant = new MockHomeAssistant();
  const deviceRuntime = createDeviceToolRuntime(homeAssistant);
  const taskRuntime = createDeviceTaskRuntime(deviceRuntime);
  deviceRuntime.invoke("control_device", { device_id: "light.living_room", action: "turn_on" });

  const agent = new EnergySavingAgent({
    deviceClient: { listDevices: () => deviceRuntime.invoke("list_devices") },
  });
  const plan = await agent.handleEvent(makeEvent({ event_id: "evt-e2e" }));
  assert.equal(plan.tasks.length, 1);
  assert.equal(homeAssistant.getAuditLog().length, 1);

  const receipt = await taskRuntime.execute(plan.tasks[0]);
  assert.equal(receipt.status, "SUCCEEDED");
  assert.equal(receipt.result.action_result.result.verified, true);
  assert.equal(deviceRuntime.invoke("get_state", { device_id: "light.living_room" }).device.state, "off");
});

test("节能任务可以交给现有 Mock 编排器完成策略和设备执行", async () => {
  const homeAssistant = new MockHomeAssistant();
  const deviceRuntime = createDeviceToolRuntime(homeAssistant);
  deviceRuntime.invoke("control_device", { device_id: "light.living_room", action: "turn_on" });
  const agent = new EnergySavingAgent({
    deviceClient: { listDevices: () => deviceRuntime.invoke("list_devices") },
  });
  const plan = await agent.handleEvent(makeEvent({ event_id: "evt-orchestrator" }));
  const orchestrator = createMockOrchestrator({ deviceRuntime });
  const records = [];
  for (const task of plan.tasks) records.push(await orchestrator.submit(task));

  assert.equal(records.length, 1);
  assert.equal(records[0].receipt.status, "SUCCEEDED");
  assert.deepEqual(records[0].stages.map((stage) => stage.stage), [
    "task_received",
    "resource_selection",
    "policy_decision",
    "device_manager",
    "receipt",
  ]);
  assert.equal(records[0].trace_id, "trace-test-001");
});

test("无设备状态时拒绝生成控制任务", async () => {
  const agent = new EnergySavingAgent();
  const result = await agent.handleEvent(makeEvent());
  assert.equal(result.status, "FAILED");
  assert.equal(result.error.code, "DEVICE_STATE_UNAVAILABLE");
});
