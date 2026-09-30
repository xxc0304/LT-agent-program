import test from "node:test";
import assert from "node:assert/strict";
import { MockHomeAssistant } from "../../device-manager/src/mock-ha.js";
import { createDeviceToolRuntime } from "../../device-manager/src/tools.js";
import { createDeviceTaskRuntime } from "../../device-manager/src/task-runtime.js";
import { EnergySavingAgent } from "../../energy-saving/src/energy-agent.js";
import { LearningCompanionAgent } from "../src/learning-agent.js";
import { MultiAgentScheduler } from "../src/scheduler.js";

function deviceActionTask(overrides = {}) {
  return {
    schema_version: "0.1",
    task_id: "task-fixture",
    source_agent: "test-agent",
    target_agent: "device-manager",
    task_type: "device_action",
    target_ref: { device_id: "light.living_room" },
    action: "turn_off",
    priority: "P2",
    deadline_ms: 100,
    resource_requirement: { execution_mode: "local", capabilities: ["device_control"] },
    privacy_level: "family",
    data_level: "L0",
    idempotency_key: "fixture-key",
    trace_id: "trace-fixture",
    ...overrides,
  };
}

function setup() {
  const homeAssistant = new MockHomeAssistant();
  const deviceRuntime = createDeviceToolRuntime(homeAssistant);
  const taskRuntime = createDeviceTaskRuntime(deviceRuntime);
  deviceRuntime.invoke("control_device", { device_id: "light.living_room", action: "turn_on" });

  const energyAgent = new EnergySavingAgent({
    config: { trustedOccupancySourceAgents: ["ha-event-adapter"] },
    deviceClient: { listDevices: () => deviceRuntime.invoke("list_devices") },
  });
  const scheduler = new MultiAgentScheduler();
  scheduler.registerAgent({
    agent_id: energyAgent.id,
    manifest: energyAgent.manifest,
    consumes: energyAgent.manifest.consumes,
    handleEvent: (event) => energyAgent.handleEvent(event),
  });
  scheduler.registerAgent({
    agent_id: "device-manager",
    manifest: { agent_id: "device-manager" },
    executeTask: (task) => taskRuntime.execute(task),
  });
  return { homeAssistant, deviceRuntime, scheduler, energyAgent };
}

test("学习伴学事件可以经过节能 Agent 调度到设备管家", async () => {
  const { deviceRuntime, scheduler } = setup();
  const learningAgent = new LearningCompanionAgent({
    analyzer: async () => ({
      behavior: "leaving_desk",
      confidence: 0.95,
      area: "living_room",
      duration_ms: 10 * 60 * 1000,
    }),
  });
  const visualEvent = await learningAgent.analyze({}, {
    event_id: "evt-e2e-learning",
    trace_id: "trace-e2e-learning",
  });
  await scheduler.handleEvent({
    schema_version: "0.1",
    event_id: "evt-e2e-ha-occupancy",
    source_agent: "ha-event-adapter",
    event_type: "occupancy_changed",
    occurred_at: visualEvent.occurred_at,
    privacy_level: "family",
    payload: { area: "living_room", occupied: false, observed_for_ms: 60_000 },
  });
  const event = visualEvent;
  const trace = await scheduler.handleEvent(event);

  assert.equal(trace.status, "SUCCEEDED");
  assert.deepEqual(trace.agents_involved, ["learning-companion", "energy-saving", "device-manager"]);
  assert.deepEqual(trace.stages.map((stage) => stage.stage), [
    "event_received",
    "agent_invoked",
    "task_enqueued",
    "task_dispatched",
    "task_completed",
  ]);
  assert.equal(trace.receipts[0].status, "SUCCEEDED");
  assert.equal(trace.receipts[0].result.action_result.result.verified, true);
  assert.equal(deviceRuntime.invoke("get_state", { device_id: "light.living_room" }).device.state, "off");
});

test("低置信度学习事件在节能 Agent 被拦截，不调用设备管家", async () => {
  const { scheduler } = setup();
  const event = {
    schema_version: "0.1",
    event_id: "evt-low-confidence",
    source_agent: "learning-companion",
    event_type: "learning_behavior",
    occurred_at: new Date().toISOString(),
    confidence: 0.4,
    needs_review: true,
    privacy_level: "restricted",
    data_level: "L3",
    trace_id: "trace-low-confidence",
    payload: { behavior: "leaving_desk", area: "living_room", duration_ms: 600000 },
  };
  const trace = await scheduler.handleEvent(event);
  assert.equal(trace.status, "NO_ACTION");
  assert.equal(trace.receipts.length, 0);
  assert.ok(!trace.stages.some((stage) => stage.stage === "task_dispatched"));
});

test("学习伴学 Agent 可以把真实视觉客户端结果转换成标准事件", async () => {
  let requestedPath = null;
  const learningAgent = new LearningCompanionAgent({
    visionClient: {
      analyzeImage: async (filePath) => {
        requestedPath = filePath;
        return {
          model: "test-vision-model",
          predictedLabel: "reading",
          parsed: {
            behavior: "reading",
            presence: "at_desk",
            confidence: 0.91,
            evidence: "孩子面向书本并保持坐姿",
          },
        };
      },
    },
  });
  const event = await learningAgent.analyzeImage("C:/private/child.jpg", {
    event_id: "evt-vision-adapter",
    trace_id: "trace-vision-adapter",
    area: "living_room",
    duration_ms: 30_000,
  });
  assert.equal(requestedPath, "C:/private/child.jpg");
  assert.equal(event.source_agent, "learning-companion");
  assert.equal(event.event_type, "learning_behavior");
  assert.equal(event.payload.behavior, "reading");
  assert.equal(event.payload.presence, "at_desk");
  assert.equal(event.payload.evidence, "孩子面向书本并保持坐姿");
  assert.equal(event.payload.model, "test-vision-model");
  assert.equal(event.needs_review, true);
  assert.equal(event.payload.duration_ms, 0);
  assert.equal(Object.hasOwn(event.payload, "image"), false);
});

test("课堂场景视觉结果进入复核事件并且不会触发节能设备动作", async () => {
  const { deviceRuntime, scheduler, energyAgent } = setup();
  let analyzedPath = null;
  let prompt = null;
  const learningAgent = new LearningCompanionAgent({
    visionClient: {
      analyzeImage: async (filePath, options) => {
        analyzedPath = filePath;
        prompt = options.prompt;
        return {
          model: "test-scene-model",
          parsed: {
            activity: ["presenting", "raising_hand"],
            posture: "mixed",
            orientation: "mixed",
            confidence: 0.93,
            evidence: "学生在前方操作教学屏幕，部分学生举手。",
          },
        };
      },
    },
  });
  const event = await learningAgent.analyzeSceneImage("C:/private/classroom.jpg", {
    event_id: "evt-classroom-scene",
    trace_id: "trace-classroom-scene",
  });

  assert.equal(analyzedPath, "C:/private/classroom.jpg");
  assert.match(prompt, /课堂场景观察器/);
  assert.equal(event.event_type, "learning_behavior");
  assert.equal(event.needs_review, true);
  assert.equal(event.payload.annotation_scope, "classroom_scene");
  assert.equal(event.payload.target_child_specified, false);
  assert.deepEqual(event.payload.activity, ["presenting", "raising_hand"]);
  assert.equal(event.payload.posture, "mixed");
  assert.equal(event.payload.orientation, "mixed");
  assert.equal(event.payload.presence, "unknown");
  assert.equal(event.payload.duration_ms, 0);
  assert.equal(event.payload.model, "test-scene-model");
  assert.equal(Object.hasOwn(event.payload, "imagePath"), false);
  assert.equal(Object.hasOwn(event.payload, "behavior"), false);

  // Even contradictory upstream absence fields must not turn a classroom
  // aggregate into a target-child absence signal for energy automation.
  const contradictoryEvent = {
    ...event,
    event_id: "evt-classroom-scene-contradictory",
    trace_id: "trace-classroom-scene-contradictory",
    confidence: 1,
    needs_review: false,
    payload: {
      ...event.payload,
      presence: "away_from_desk",
      duration_ms: 10 * 60 * 1000,
    },
  };
  const trace = await scheduler.handleEvent(contradictoryEvent);
  assert.equal(trace.status, "NO_ACTION");
  assert.equal(trace.receipts.length, 0);
  assert.equal(trace.agents_involved.includes("device-manager"), false);
  assert.equal(deviceRuntime.invoke("get_state", { device_id: "light.living_room" }).device.state, "on");
  const decision = energyAgent.plan({
    ...contradictoryEvent,
    event_id: "evt-classroom-scene-guard-direct",
  });
  assert.equal(decision.status, "NO_ACTION");
  assert.equal(decision.decisions[0].reason, "CLASSROOM_SCENE_NOT_TARGETED_FOR_ENERGY");
});

test("场景模型缺字段或标签无效时保守归一化并标记复核", () => {
  const learningAgent = new LearningCompanionAgent();
  const event = learningAgent.toSceneEvent({
    activity: ["hallucinated_label"],
    posture: "upright",
    orientation: null,
    confidence: null,
  }, { event_id: "evt-invalid-scene-output" });

  assert.deepEqual(event.payload.activity, ["unknown"]);
  assert.equal(event.payload.posture, "unknown");
  assert.equal(event.payload.orientation, "unknown");
  assert.equal(event.confidence, 0);
  assert.equal(event.needs_review, true);
  assert.ok(event.payload.schema_warnings.length >= 3);
});

test("单张高置信度离位图片不能伪造持续时间触发节能控制", async () => {
  const { scheduler } = setup();
  const learningAgent = new LearningCompanionAgent({
    visionClient: {
      analyzeImage: async () => ({
        model: "test-vision-model",
        predictedLabel: "standing",
        presence: "away_from_desk",
        parsed: { confidence: 0.99, evidence: "单帧画面中未见孩子在书桌旁" },
      }),
    },
  });
  const event = await learningAgent.analyzeImage("single-frame.jpg", {
    event_id: "evt-single-frame-away",
    area: "living_room",
    duration_ms: 10 * 60 * 1000,
  });

  assert.equal(event.needs_review, true);
  assert.equal(event.payload.duration_ms, 0);
  const trace = await scheduler.handleEvent(event);
  assert.equal(trace.status, "NO_ACTION");
  assert.equal(trace.receipts.length, 0);
  assert.ok(!trace.stages.some((stage) => stage.stage === "task_dispatched"));
});

test("多帧离位判断达到最少样本和真实时间跨度后才能进入节能调度", async () => {
  const { deviceRuntime, scheduler } = setup();
  const learningAgent = new LearningCompanionAgent({
    visionClient: {
      analyzeImage: async () => ({
        model: "test-vision-model",
        predictedLabel: "standing",
        presence: "away_from_desk",
        parsed: { confidence: 0.95, evidence: "书桌区域未见孩子" },
      }),
    },
  });
  const end = Date.now();
  const visualEvent = await learningAgent.analyzeSequence([
    { imagePath: "frame-1.jpg", capturedAt: new Date(end - 10 * 60 * 1000).toISOString() },
    { imagePath: "frame-2.jpg", capturedAt: new Date(end - 8 * 60 * 1000).toISOString() },
    { imagePath: "frame-3.jpg", capturedAt: new Date(end - 6 * 60 * 1000).toISOString() },
    { imagePath: "frame-4.jpg", capturedAt: new Date(end - 4 * 60 * 1000).toISOString() },
    { imagePath: "frame-5.jpg", capturedAt: new Date(end - 2 * 60 * 1000).toISOString() },
    { imagePath: "frame-6.jpg", capturedAt: new Date(end).toISOString() },
  ], { event_id: "evt-sequence-away", area: "living_room" });

  assert.equal(visualEvent.needs_review, false);
  assert.equal(visualEvent.payload.presence, "away_from_desk");
  assert.equal(visualEvent.payload.duration_ms, 10 * 60 * 1000);
  assert.equal(Object.hasOwn(visualEvent.payload, "imagePath"), false);
  await scheduler.handleEvent({
    schema_version: "0.1",
    event_id: "evt-sequence-ha-occupancy",
    source_agent: "ha-event-adapter",
    event_type: "occupancy_changed",
    occurred_at: visualEvent.occurred_at,
    privacy_level: "family",
    payload: { area: "living_room", occupied: false, observed_for_ms: 60_000 },
  });
  const trace = await scheduler.handleEvent(visualEvent);
  assert.equal(trace.status, "SUCCEEDED");
  assert.equal(trace.receipts[0].result.action_result.result.verified, true);
  assert.equal(deviceRuntime.invoke("get_state", { device_id: "light.living_room" }).device.state, "off");
});

test("稳定多帧视觉离位仍需独立占用事件佐证才可控制设备", async () => {
  const { deviceRuntime, scheduler } = setup();
  const learningAgent = new LearningCompanionAgent({
    visionClient: {
      analyzeImage: async () => ({
        predictedLabel: "standing",
        presence: "away_from_desk",
        parsed: { confidence: 0.95, evidence: "书桌区域未见孩子" },
      }),
    },
  });
  const end = Date.now();
  const event = await learningAgent.analyzeSequence([
    { imagePath: "frame-1.jpg", capturedAt: new Date(end - 10 * 60 * 1000).toISOString() },
    { imagePath: "frame-2.jpg", capturedAt: new Date(end - 8 * 60 * 1000).toISOString() },
    { imagePath: "frame-3.jpg", capturedAt: new Date(end - 6 * 60 * 1000).toISOString() },
    { imagePath: "frame-4.jpg", capturedAt: new Date(end - 4 * 60 * 1000).toISOString() },
    { imagePath: "frame-5.jpg", capturedAt: new Date(end - 2 * 60 * 1000).toISOString() },
    { imagePath: "frame-6.jpg", capturedAt: new Date(end).toISOString() },
  ], { event_id: "evt-sequence-no-ha-evidence", area: "living_room" });

  const trace = await scheduler.handleEvent(event);
  assert.equal(trace.status, "NO_ACTION");
  assert.equal(trace.receipts.length, 0);
  assert.ok(!trace.stages.some((stage) => stage.stage === "task_dispatched"));
  assert.equal(deviceRuntime.invoke("get_state", { device_id: "light.living_room" }).device.state, "on");
});

test("图像序列时间戳不递增时拒绝分析", async () => {
  const learningAgent = new LearningCompanionAgent({
    visionClient: { analyzeImage: async () => ({ parsed: { behavior: "reading", confidence: 0.9 } }) },
  });
  await assert.rejects(() => learningAgent.analyzeSequence([
    { imagePath: "later.jpg", capturedAt: "2026-09-24T12:01:00.000Z" },
    { imagePath: "earlier.jpg", capturedAt: "2026-09-24T12:00:00.000Z" },
  ]), /严格按时间递增/);
});

test("观测不足十分钟的高置信度离位序列仍需人工复核", async () => {
  const learningAgent = new LearningCompanionAgent({
    visionClient: {
      analyzeImage: async () => ({
        predictedLabel: "standing",
        presence: "away_from_desk",
        parsed: { confidence: 0.99 },
      }),
    },
  });
  const end = Date.now();
  const event = await learningAgent.analyzeSequence([
    { imagePath: "frame-1.jpg", capturedAt: new Date(end - 2 * 60 * 1000).toISOString() },
    { imagePath: "frame-2.jpg", capturedAt: new Date(end - 60_000).toISOString() },
    { imagePath: "frame-3.jpg", capturedAt: new Date(end).toISOString() },
  ]);

  assert.equal(event.needs_review, true);
  assert.equal(event.payload.presence, "unknown");
  assert.equal(event.payload.duration_ms, 2 * 60 * 1000);
});

test("帧间隔超过两分钟时不把稀疏样本认定为稳定离位", async () => {
  const learningAgent = new LearningCompanionAgent({
    visionClient: {
      analyzeImage: async () => ({
        predictedLabel: "standing",
        presence: "away_from_desk",
        parsed: { confidence: 0.99 },
      }),
    },
  });
  const end = Date.now();
  const offsets = [10, 9, 6, 4, 2, 0].map((minutes) => minutes * 60 * 1000);
  const event = await learningAgent.analyzeSequence(offsets.map((offset, index) => ({
    imagePath: `frame-${index + 1}.jpg`,
    capturedAt: new Date(end - offset).toISOString(),
  })));

  assert.equal(event.needs_review, true);
  assert.equal(event.payload.presence, "unknown");
});

test("视觉客户端的低置信度结果会进入人工复核状态", async () => {
  const learningAgent = new LearningCompanionAgent({
    visionClient: {
      analyzeImage: async () => ({
        model: "test-vision-model",
        predictedLabel: "standing",
        parsed: { confidence: 0.42, evidence: "无法确认是否离开书桌" },
      }),
    },
  });
  const event = await learningAgent.analyzeImage("fixture.jpg", {
    event_id: "evt-vision-low-confidence",
  });
  assert.equal(event.payload.behavior, "standing");
  assert.equal(event.confidence, 0.42);
  assert.equal(event.needs_review, true);
});

test("任务按优先级和截止时间排序", async () => {
  const scheduler = new MultiAgentScheduler();
  const order = [];
  scheduler.registerAgent({
    agent_id: "device-manager",
    executeTask: async (task) => {
      order.push(task.task_id);
      return {
        task_id: task.task_id,
        target_agent: "device-manager",
        status: "SUCCEEDED",
        completed_at: new Date().toISOString(),
        trace_id: task.trace_id,
      };
    },
  });
  const makeTask = (task_id, priority, deadline_ms) => deviceActionTask({
    task_id,
    target_ref: { device_id: `light.${task_id}` },
    priority,
    deadline_ms,
    idempotency_key: `key-${task_id}`,
    trace_id: "trace-priority",
  });
  scheduler.enqueueTask(makeTask("normal-late", "P3", 100));
  scheduler.enqueueTask(makeTask("critical-late", "P0", 999));
  scheduler.enqueueTask(makeTask("high-early", "P1", 10));
  await scheduler.drain();
  assert.deepEqual(order, ["critical-late", "high-early", "normal-late"]);
});

test("同一个幂等键只允许进入一次队列", async () => {
  const scheduler = new MultiAgentScheduler();
  let calls = 0;
  scheduler.registerAgent({
    agent_id: "device-manager",
    executeTask: async (task) => {
      calls += 1;
      return { task_id: task.task_id, target_agent: "device-manager", status: "SUCCEEDED", completed_at: new Date().toISOString() };
    },
  });
  const task = deviceActionTask({
    task_id: "task-duplicate",
    idempotency_key: "same-key",
    trace_id: "trace-duplicate",
  });
  assert.equal(scheduler.enqueueTask(task).deduplicated, false);
  assert.equal(scheduler.enqueueTask(task).deduplicated, true);
  assert.equal(scheduler.enqueueTask({ ...task, task_id: "task-duplicate-replayed", trace_id: "trace-duplicate-replayed" }).deduplicated, true);
  await scheduler.drain();
  assert.equal(calls, 1);
});

test("Task 边界兼容 source/target 旧别名、规范化后只传 canonical 字段，并拒绝冲突", async () => {
  const scheduler = new MultiAgentScheduler();
  const receivedTasks = [];
  scheduler.registerAgent({
    agent_id: "device-manager",
    executeTask: async (task) => {
      receivedTasks.push(task);
      return { task_id: task.task_id, target_agent: "device-manager", status: "SUCCEEDED", completed_at: new Date().toISOString() };
    },
  });
  const base = deviceActionTask({
    task_id: "task-alias-compat",
    source_agent: "energy-saving",
    target_ref: { device_id: "light.study_desk" },
    priority: "P3",
    deadline_ms: 1000,
    idempotency_key: "alias-compat-key",
    trace_id: "trace-alias-compat",
  });
  base.source = base.source_agent;
  base.target = base.target_agent;
  delete base.source_agent;
  delete base.target_agent;

  assert.equal(scheduler.enqueueTask(base).success, true);
  await scheduler.drain();
  assert.equal(receivedTasks[0].source_agent, "energy-saving");
  assert.equal(receivedTasks[0].target_agent, "device-manager");
  assert.equal(Object.hasOwn(receivedTasks[0], "source"), false);
  assert.equal(Object.hasOwn(receivedTasks[0], "target"), false);

  const canonicalOnly = { ...base, task_id: "task-canonical-only", idempotency_key: "canonical-only-key" };
  delete canonicalOnly.source;
  delete canonicalOnly.target;
  canonicalOnly.source_agent = "energy-saving";
  canonicalOnly.target_agent = "device-manager";
  assert.equal(scheduler.enqueueTask(canonicalOnly).success, true);
  await scheduler.drain();
  assert.equal(receivedTasks[1].source_agent, "energy-saving");
  assert.equal(receivedTasks[1].target_agent, "device-manager");

  const targetConflict = scheduler.enqueueTask({
    ...base,
    task_id: "task-target-conflict",
    idempotency_key: "target-conflict-key",
    target_agent: "security-agent",
  });
  const sourceConflict = scheduler.enqueueTask({
    ...base,
    task_id: "task-source-conflict",
    idempotency_key: "source-conflict-key",
    source_agent: "learning-companion",
  });
  assert.equal(targetConflict.success, false);
  assert.match(targetConflict.error.message, /target_agent.*target/);
  assert.equal(sourceConflict.success, false);
  assert.match(sourceConflict.error.message, /source_agent.*source/);
});

test("调度器入队前拒绝不符合 canonical Task 枚举和设备标识的任务", async () => {
  const scheduler = new MultiAgentScheduler();
  let executed = 0;
  scheduler.registerAgent({
    agent_id: "device-manager",
    executeTask: async () => {
      executed += 1;
      return { status: "SUCCEEDED" };
    },
  });

  const invalidCases = [
    ["priority", { priority: "urgent" }],
    ["legacy priority on canonical task", { priority: "critical" }],
    ["data level", { data_level: "L4" }],
    ["empty device id", { target_ref: { device_id: " " } }],
    ["fractional deadline", { deadline_ms: 1.5 }],
    ["execution mode", { resource_requirement: { execution_mode: "anywhere" } }],
    ["privacy level", { privacy_level: "public" }],
  ];

  for (const [name, overrides] of invalidCases) {
    const receipt = scheduler.enqueueTask(deviceActionTask({
      task_id: `invalid-${name.replaceAll(" ", "-")}`,
      idempotency_key: `invalid-key-${name.replaceAll(" ", "-")}`,
      ...overrides,
    }));
    assert.equal(receipt.success, false, name);
    assert.equal(receipt.error.code, "INVALID_TASK", name);
  }

  await scheduler.drain();
  assert.equal(executed, 0);
});

test("复用幂等键但改变任务内容时拒绝而不是静默去重", () => {
  const scheduler = new MultiAgentScheduler();
  const base = deviceActionTask({
    task_id: "task-same-key-a",
    target: "device-manager",
    priority: "P2",
    idempotency_key: "conflicting-key",
    trace_id: "trace-key-conflict",
  });
  delete base.target_agent;
  scheduler.enqueueTask(base);
  const conflict = scheduler.enqueueTask({ ...base, task_id: "task-same-key-b", action: "turn_on" });
  assert.equal(conflict.success, false);
  assert.equal(conflict.error.code, "IDEMPOTENCY_KEY_CONFLICT");
});

test("重复事件只路由一次；相同 event_id 的不同内容会被拒绝", async () => {
  const scheduler = new MultiAgentScheduler();
  let calls = 0;
  scheduler.registerAgent({
    agent_id: "event-consumer",
    consumes: ["sensor_update"],
    handleEvent: async () => {
      calls += 1;
      return { status: "NO_ACTION", tasks: [] };
    },
  });
  const event = { event_id: "evt-dedup", event_type: "sensor_update", payload: { state: "on" }, trace_id: "trace-dedup" };
  const first = await scheduler.handleEvent(event);
  const duplicate = await scheduler.handleEvent({ ...event });
  const conflict = await scheduler.handleEvent({ ...event, payload: { state: "off" } });
  assert.equal(calls, 1);
  assert.ok(duplicate.stages.some((stage) => stage.stage === "event_deduplicated"));
  assert.equal(conflict.status, "REJECTED");
  assert.equal(conflict.errors[0].code, "EVENT_ID_CONFLICT");
  assert.equal(scheduler.getTrace(first.trace_id).status, "NO_ACTION");
});

test("任务超过相对 deadline_ms 后不调用目标 Agent", async () => {
  let now = 1000;
  const scheduler = new MultiAgentScheduler({ clock: () => now });
  let calls = 0;
  scheduler.registerAgent({ agent_id: "device-manager", executeTask: async () => { calls += 1; } });
  scheduler.enqueueTask(deviceActionTask({
    task_id: "task-deadline",
    target: "device-manager",
    priority: "P2",
    deadline_ms: 10,
    idempotency_key: "deadline-key",
    trace_id: "trace-deadline",
  }));
  now += 11;
  await scheduler.drain();
  const trace = scheduler.getTrace("trace-deadline");
  assert.equal(calls, 0);
  assert.equal(trace.status, "TIMEOUT");
  assert.equal(trace.receipts[0].error.code, "DEADLINE_EXCEEDED");
});

test("Agent 调用超时默认不重试，并标记副作用结果未知", async () => {
  const scheduler = new MultiAgentScheduler({ taskTimeoutMs: 5, maxAttempts: 3 });
  let calls = 0;
  scheduler.registerAgent({ agent_id: "device-manager", executeTask: async () => {
    calls += 1;
    return new Promise(() => {});
  } });
  scheduler.enqueueTask(deviceActionTask({
    task_id: "task-timeout",
    target: "device-manager",
    priority: "P2",
    deadline_ms: 1000,
    idempotency_key: "timeout-key",
    trace_id: "trace-timeout",
  }));
  await scheduler.drain();
  const trace = scheduler.getTrace("trace-timeout");
  assert.equal(calls, 1);
  assert.equal(trace.status, "TIMEOUT");
  assert.equal(trace.receipts[0].retryable, false);
  assert.equal(trace.receipts[0].error.side_effects_unknown, true);
});

test("只有 Agent 显式声明超时可安全重试时才重试 TIMEOUT", async () => {
  const scheduler = new MultiAgentScheduler({ taskTimeoutMs: 5, maxAttempts: 2 });
  let calls = 0;
  scheduler.registerAgent({
    agent_id: "device-manager",
    manifest: { timeout_retry_safe: true },
    executeTask: async (task) => {
      calls += 1;
      if (calls === 1) return new Promise(() => {});
      return { task_id: task.task_id, target_agent: "device-manager", status: "SUCCEEDED", trace_id: task.trace_id };
    },
  });
  scheduler.enqueueTask(deviceActionTask({
    task_id: "task-timeout-safe-retry",
    target: "device-manager",
    priority: "P2",
    deadline_ms: 1000,
    idempotency_key: "timeout-safe-key",
    trace_id: "trace-timeout-safe",
  }));
  await scheduler.drain();
  assert.equal(calls, 2);
  assert.equal(scheduler.getTrace("trace-timeout-safe").status, "SUCCEEDED");
});

test("事件处理器超时会记录不确定副作用且不生成任务", async () => {
  const scheduler = new MultiAgentScheduler({ handlerTimeoutMs: 5 });
  scheduler.registerAgent({
    agent_id: "slow-agent",
    consumes: ["slow_event"],
    handleEvent: () => new Promise(() => {}),
  });
  const trace = await scheduler.handleEvent({ event_id: "evt-handler-timeout", event_type: "slow_event", payload: {} });
  assert.equal(trace.status, "FAILED");
  assert.equal(trace.errors[0].code, "AGENT_HANDLER_TIMEOUT");
  assert.equal(trace.errors[0].side_effects_unknown, true);
  assert.equal(trace.planned_tasks.length, 0);
});

test("可重试回执会重新调度，最终成功后 trace 为 SUCCEEDED", async () => {
  const scheduler = new MultiAgentScheduler({ maxAttempts: 2 });
  let calls = 0;
  scheduler.registerAgent({
    agent_id: "device-manager",
    executeTask: async (task) => {
      calls += 1;
      return {
        task_id: task.task_id,
        target_agent: "device-manager",
        status: calls === 1 ? "RETRYABLE" : "SUCCEEDED",
        completed_at: new Date().toISOString(),
        trace_id: task.trace_id,
      };
    },
  });
  const task = deviceActionTask({
    task_id: "task-retry",
    target: "device-manager",
    priority: "P2",
    deadline_ms: 100,
    idempotency_key: "retry-key",
    trace_id: "trace-retry",
  });
  scheduler.enqueueTask(task);
  await scheduler.drain();
  const trace = scheduler.getTrace("trace-retry");
  assert.equal(calls, 2);
  assert.equal(trace.status, "SUCCEEDED");
  assert.ok(trace.stages.some((stage) => stage.stage === "task_retry_scheduled"));
});

test("目标 Agent 不可用时返回失败回执", async () => {
  const scheduler = new MultiAgentScheduler();
  const task = deviceActionTask({
    task_id: "task-missing-agent",
    target: "missing-agent",
    priority: "P2",
    deadline_ms: 100,
    idempotency_key: "missing-agent-key",
    trace_id: "trace-missing-agent",
  });
  delete task.target_agent;
  scheduler.enqueueTask(task);
  await scheduler.drain();
  const trace = scheduler.getTrace("trace-missing-agent");
  assert.equal(trace.status, "FAILED");
  assert.equal(trace.receipts[0].error.code, "TARGET_AGENT_UNAVAILABLE");
});

test("Agent 生成非法任务时，调度器拒绝任务并留下失败 trace", async () => {
  const scheduler = new MultiAgentScheduler();
  scheduler.registerAgent({
    agent_id: "energy-saving",
    consumes: ["test_event"],
    handleEvent: async () => ({
      status: "PLANNED",
      tasks: [{ task_id: "invalid-task", target: "device-manager" }],
    }),
  });
  const trace = await scheduler.handleEvent({
    event_id: "evt-invalid-task",
    event_type: "test_event",
    source_agent: "test-source",
    payload: {},
  });
  assert.equal(trace.status, "FAILED");
  assert.equal(trace.stages.at(-1).stage, "task_rejected");
  assert.equal(trace.errors[0].code, "INVALID_TASK");
});
