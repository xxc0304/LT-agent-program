import assert from "node:assert/strict";
import test from "node:test";
import { createIndependentLearningEnergyWorkflow } from "../src/independent-learning-energy-workflow.js";

const NOW = Date.parse("2026-10-15T10:00:00.000Z");
const TRACE_ID = "trace-independent-learning-energy-001";

function observation(overrides = {}) {
  return {
    observation_id: "obs-study-room-001",
    area: "study_room",
    observed_at: "2026-10-15T09:59:00.000Z",
    behavior: "away_from_desk",
    presence: "away_from_desk",
    confidence: 0.94,
    duration_ms: 600_000,
    needs_review: false,
    annotation_scope: "individual",
    target_child_specified: true,
    evidence: "由本地识别适配器汇总的结构化观测。",
    ...overrides,
  };
}

function learningEvent(inputObservation, traceId = TRACE_ID, overrides = {}) {
  return {
    schema_version: "0.1",
    event_id: "evt-independent-learning-001",
    source_agent: "learning-companion",
    event_type: "learning_behavior",
    occurred_at: inputObservation.observed_at,
    received_at: "2026-10-15T09:59:05.000Z",
    confidence: inputObservation.confidence,
    needs_review: inputObservation.needs_review,
    privacy_level: "restricted",
    data_level: "L3",
    trace_id: traceId,
    source: { type: "learning_behavior_model", id: "learning-companion" },
    payload: {
      behavior: inputObservation.behavior,
      presence: inputObservation.presence,
      area: inputObservation.area,
      duration_ms: inputObservation.duration_ms,
      annotation_scope: inputObservation.annotation_scope,
      target_child_specified: inputObservation.target_child_specified,
      evidence: inputObservation.evidence,
    },
    ...overrides,
  };
}

function task(traceId = TRACE_ID) {
  return {
    schema_version: "0.1",
    task_id: "task-independent-learning-energy-001",
    source_agent: "energy-saving",
    target_agent: "device-manager",
    task_type: "device_action",
    target_ref: { device_id: "light.study_room" },
    action: "turn_off",
    parameters: {},
    priority: "P3",
    deadline_ms: 30_000,
    resource_requirement: { execution_mode: "local", capabilities: ["device_control"] },
    privacy_level: "family",
    data_level: "L0",
    idempotency_key: "energy:evt-independent-learning-energy-001",
    trace_id: traceId,
  };
}

function workflowWith(outputs, options = {}) {
  const calls = [];
  const executeCalls = [];
  const agentClient = {
    async invoke(request) {
      calls.push(request);
      const output = outputs[request.agentId];
      return { status: "ok", output: typeof output === "function" ? output(request) : output };
    },
  };
  const workflow = createIndependentLearningEnergyWorkflow({
    agentClient,
    isTrustedObservation: options.isTrustedObservation ?? (() => true),
    clock: options.clock ?? (() => NOW),
    executeEnergyTask: async (candidate, context) => {
      executeCalls.push({ candidate, context });
      return options.receipt ?? { status: "CHALLENGE", error: { code: "CONFIRMATION_REQUIRED" } };
    },
  });
  return { workflow, calls, executeCalls };
}

test("未由可信本地适配器认证的观测在调用任何模型前被拒绝", async () => {
  const { workflow, calls, executeCalls } = workflowWith({}, { isTrustedObservation: () => false });
  const result = await workflow.evaluate({ observation: observation(), traceId: TRACE_ID });
  assert.equal(result.status, "REJECTED");
  assert.equal(result.reason_code, "OBSERVATION_SOURCE_UNTRUSTED");
  assert.deepEqual(result.agents_involved, []);
  assert.equal(calls.length, 0);
  assert.equal(executeCalls.length, 0);
});

test("学习事件经校验后依次交给能源管家；NO_ACTION 正常结束", async () => {
  const input = observation();
  const { workflow, calls, executeCalls } = workflowWith({
    "learning-companion": (request) => {
      assert.equal(request.traceId, TRACE_ID);
      assert.equal(request.input.observation.observation_id, input.observation_id);
      return learningEvent(input, request.traceId);
    },
    "energy-saving": (request) => {
      assert.equal(request.traceId, TRACE_ID);
      assert.equal(request.input.event.source_agent, "learning-companion");
      return {
        schema_version: "0.1",
        outcome: "NO_ACTION",
        source_agent: "energy-saving",
        trace_id: request.traceId,
        reason_code: "OCCUPANCY_NOT_CONFIRMED",
      };
    },
  });

  const result = await workflow.evaluate({ observation: input, traceId: TRACE_ID });
  assert.equal(result.status, "NO_ACTION");
  assert.equal(result.execution_performed, false);
  assert.deepEqual(calls.map((call) => call.agentId), ["learning-companion", "energy-saving"]);
  assert.ok(calls.every((call) => call.traceId === TRACE_ID));
  assert.deepEqual(result.agents_involved, ["learning-companion", "energy-saving"]);
  assert.equal(executeCalls.length, 0);
});

test("课堂场景、未指定目标孩子或待复核事件不会调用能源管家", async () => {
  for (const patch of [
    { annotation_scope: "classroom_scene", target_child_specified: false },
    { target_child_specified: false },
    { needs_review: true },
  ]) {
    const input = observation(patch);
    const { workflow, calls, executeCalls } = workflowWith({
      "learning-companion": (request) => learningEvent(input, request.traceId),
    });
    const result = await workflow.evaluate({ observation: input, traceId: TRACE_ID });
    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].agentId, "learning-companion");
    assert.equal(executeCalls.length, 0);
  }
});

test("低置信度、非离位、持续时间不足及过期事件被本地门禁拦截", async () => {
  for (const patch of [
    { confidence: 0.79 },
    { presence: "at_desk" },
    { duration_ms: 599_999 },
  ]) {
    const input = observation(patch);
    const { workflow, calls } = workflowWith({
      "learning-companion": (request) => learningEvent(input, request.traceId),
    });
    const result = await workflow.evaluate({ observation: input, traceId: TRACE_ID });
    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.equal(calls.length, 1);
  }

  const staleInput = observation({ observed_at: "2026-10-15T09:50:00.000Z" });
  const stale = workflowWith({});
  const staleResult = await stale.workflow.evaluate({ observation: staleInput, traceId: TRACE_ID });
  assert.equal(staleResult.status, "REJECTED");
  assert.equal(staleResult.reason_code, "OBSERVATION_STALE_OR_FUTURE");
  assert.equal(stale.calls.length, 0);
});

test("候选 Task 只能交给设备管家既有门禁；本工作流不赋予可信来源", async () => {
  const input = observation();
  const { workflow, calls, executeCalls } = workflowWith({
    "learning-companion": (request) => learningEvent(input, request.traceId),
    "energy-saving": (request) => task(request.traceId),
  });
  const result = await workflow.evaluate({ observation: input, traceId: TRACE_ID });
  assert.equal(result.status, "CHALLENGE");
  assert.equal(result.execution_performed, false);
  assert.equal(result.confirmation_required, true);
  assert.deepEqual(result.agents_involved, ["learning-companion", "energy-saving", "device-manager"]);
  assert.deepEqual(executeCalls[0].context, { trustedEventSource: false });
  assert.deepEqual(calls.map((call) => call.agentId), ["learning-companion", "energy-saving"]);
});

test("学习 Agent 不得篡改观测时间、地点、范围或提升置信度", async () => {
  const input = observation();
  const { workflow, calls } = workflowWith({
    "learning-companion": (request) => learningEvent(input, request.traceId, {
      confidence: 0.99,
      payload: { ...learningEvent(input, request.traceId).payload, area: "whole_home" },
    }),
  });
  await assert.rejects(
    workflow.evaluate({ observation: input, traceId: TRACE_ID }),
    { code: "INVALID_LEARNING_EVENT" },
  );
  assert.equal(calls.length, 1);
});

test("输入不得携带原始图片、媒体路径或额外伪造来源字段", async () => {
  const { workflow, calls } = workflowWith({});
  await assert.rejects(
    workflow.evaluate({ observation: observation({ image_path: "C:\\private\\child.jpg" }), traceId: TRACE_ID }),
    { code: "INVALID_LEARNING_OBSERVATION" },
  );
  await assert.rejects(
    workflow.evaluate({ observation: observation({ observed_at: "tomorrow morning" }), traceId: TRACE_ID }),
    { code: "INVALID_LEARNING_OBSERVATION" },
  );
  assert.equal(calls.length, 0);
});

test("相同幂等键的并发请求只调用一次各自 Agent", async () => {
  const input = observation();
  const { workflow, calls } = workflowWith({
    "learning-companion": (request) => learningEvent(input, request.traceId),
    "energy-saving": (request) => ({
      schema_version: "0.1",
      outcome: "NO_ACTION",
      source_agent: "energy-saving",
      trace_id: request.traceId,
      reason_code: "OCCUPANCY_NOT_CONFIRMED",
    }),
  });
  const request = { observation: input, traceId: TRACE_ID, idempotencyKey: "idem-learning-energy-001" };
  const [first, second] = await Promise.all([workflow.evaluate(request), workflow.evaluate(request)]);
  assert.deepEqual(first, second);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.agentId), ["learning-companion", "energy-saving"]);
  await assert.rejects(workflow.evaluate({
    ...request,
    observation: observation({ area: "bedroom" }),
  }), { code: "IDEMPOTENCY_KEY_CONFLICT" });
});
