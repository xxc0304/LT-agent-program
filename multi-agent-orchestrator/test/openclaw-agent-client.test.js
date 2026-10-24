import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenClawAgentCallError,
  OpenClawAgentClient,
} from "../src/openclaw-agent-client.js";

const TRACE_ID = "trace-openclaw-001";

function learningEvent(overrides = {}) {
  return {
    schema_version: "0.1",
    event_id: "evt-learning-001",
    source_agent: "learning-companion",
    event_type: "learning_behavior",
    occurred_at: "2026-10-11T08:00:00.000Z",
    confidence: 0.92,
    needs_review: true,
    privacy_level: "restricted",
    data_level: "L3",
    trace_id: TRACE_ID,
    source: { type: "synthetic_observation", id: "learning-companion" },
    payload: { behavior: "writing", presence: "present", area: "study_room", duration_ms: 0 },
    ...overrides,
  };
}

function energyTask(overrides = {}) {
  return {
    schema_version: "0.1",
    task_id: "task-energy-001",
    source: "energy-saving",
    source_agent: "energy-saving",
    target: "device-manager",
    target_agent: "device-manager",
    task_type: "device_action",
    target_ref: { device_id: "light.study_room" },
    action: "turn_off",
    parameters: {},
    priority: "P3",
    deadline_ms: 30_000,
    data_level: "L0",
    privacy_level: "family",
    resource_requirement: { execution_mode: "local", capabilities: ["device_control"] },
    idempotency_key: "energy:evt-learning-001:light.study_room:turn_off",
    trace_id: TRACE_ID,
    ...overrides,
  };
}

function clientFor(output, options = {}) {
  const calls = [];
  const client = new OpenClawAgentClient({
    sendMessage: async (request) => {
      calls.push(request);
      const envelope = JSON.parse(request.message);
      const agentOutput = typeof output === "function" ? output(envelope) : output;
      return { status: "ok", reply: JSON.stringify(agentOutput) };
    },
    ...options,
  });
  return { client, calls };
}

test("用 sessions_send 请求学习伴学 Agent，并校验 Event 契约与 trace", async () => {
  const { client, calls } = clientFor(learningEvent());
  const result = await client.invoke({
    agentId: "learning-companion",
    traceId: TRACE_ID,
    idempotencyKey: "req-learning-001",
    input: { observation: "synthetic", evidence: { frame_count: 1 } },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, "learning-companion");
  assert.equal(calls[0].timeoutSeconds, 30);
  const envelope = JSON.parse(calls[0].message);
  assert.equal(envelope.protocol, "lt-agent-request/0.1");
  assert.equal(envelope.operation, "produce_learning_event");
  assert.equal(envelope.trace_id, TRACE_ID);
  assert.match(envelope.response_rule, /裸的标准 Event JSON 对象/);
  assert.match(envelope.response_rule, /source_agent:"learning-companion"/);
  assert.match(envelope.response_rule, /不得把 protocol、target_agent、operation、contract、idempotency_key/);
  assert.equal(result.output.event_id, "evt-learning-001");
  assert.equal(result.trace_id, TRACE_ID);
});

test("校验节能 Agent 的 canonical Task，且不把策略批准权交给模型", async () => {
  const { client } = clientFor(energyTask());
  const result = await client.invoke({
    agentId: "energy-saving",
    traceId: TRACE_ID,
    idempotencyKey: "req-energy-001",
    input: { event: learningEvent() },
  });

  assert.equal(result.output.source_agent, "energy-saving");
  assert.equal(result.output.target_agent, "device-manager");
  assert.equal("source" in result.output, false);
  assert.equal("target" in result.output, false);
});

test("节能 Agent 可以用严格契约返回正常 NO_ACTION", async () => {
  const noAction = {
    schema_version: "0.1",
    outcome: "NO_ACTION",
    source_agent: "energy-saving",
    trace_id: TRACE_ID,
    reason_code: "NO_ELIGIBLE_DEVICE",
  };
  const { client } = clientFor(noAction);
  const result = await client.invoke({
    agentId: "energy-saving",
    traceId: TRACE_ID,
    idempotencyKey: "req-energy-no-action-001",
    input: { event: { event_id: "evt-no-action" } },
  });
  assert.deepEqual(result.output, noAction);
});

test("NO_ACTION 不得缺字段、冒充来源或携带额外审批/执行字段", async (t) => {
  for (const [name, output] of [
    ["wrong source", { schema_version: "0.1", outcome: "NO_ACTION", source_agent: "learning-companion", trace_id: TRACE_ID, reason_code: "NOT_APPLICABLE" }],
    ["wrong trace", { schema_version: "0.1", outcome: "NO_ACTION", source_agent: "energy-saving", trace_id: "trace-other", reason_code: "NOT_APPLICABLE" }],
    ["empty reason", { schema_version: "0.1", outcome: "NO_ACTION", source_agent: "energy-saving", trace_id: TRACE_ID, reason_code: " " }],
    ["extra policy", { schema_version: "0.1", outcome: "NO_ACTION", source_agent: "energy-saving", trace_id: TRACE_ID, reason_code: "NOT_APPLICABLE", policy_decision: { decision: "ALLOW" } }],
  ]) {
    await t.test(name, async () => {
      const { client } = clientFor(output);
      await assert.rejects(client.invoke({
        agentId: "energy-saving",
        traceId: TRACE_ID,
        idempotencyKey: `req-energy-no-action-${name.replaceAll(" ", "-")}`,
        input: { event: { event_id: "evt-no-action" } },
      }), { code: "INVALID_AGENT_NO_ACTION" });
    });
  }
});

test("拒绝未列入业务白名单的 Agent", () => {
  const { client, calls } = clientFor(learningEvent());
  assert.throws(() => client.invoke({
    agentId: "device-manager",
    traceId: TRACE_ID,
    idempotencyKey: "req-device-manager-001",
    input: {},
  }), { code: "AGENT_NOT_ALLOWED" });
  assert.equal(calls.length, 0);
});

test("拒绝 Markdown 包裹和额外说明，不宽松提取 JSON", async () => {
  const client = new OpenClawAgentClient({
    sendMessage: async () => ({ status: "ok", reply: `结果如下：\n\`\`\`json\n${JSON.stringify(learningEvent())}\n\`\`\`` }),
  });
  await assert.rejects(client.invoke({
    agentId: "learning-companion",
    traceId: TRACE_ID,
    idempotencyKey: "req-bad-json-001",
    input: {},
  }), { code: "AGENT_REPLY_NOT_JSON" });
});

test("拒绝 trace 或实际来源 Agent 不匹配的 Event", async (t) => {
  for (const [name, event] of [
    ["wrong trace", learningEvent({ trace_id: "trace-other" })],
    ["wrong source", learningEvent({ source_agent: "energy-saving" })],
  ]) {
    await t.test(name, async () => {
      const { client } = clientFor(event);
      await assert.rejects(client.invoke({
        agentId: "learning-companion",
        traceId: TRACE_ID,
        idempotencyKey: `req-${name.replaceAll(" ", "-")}`,
        input: {},
      }), { code: "INVALID_AGENT_EVENT" });
    });
  }
});

test("拒绝节能 Agent 输出不合规目标、trace 或 policy_decision 的 Task", async (t) => {
  for (const [name, task] of [
    ["wrong target", energyTask({ target_agent: "security-agent", target: "security-agent" })],
    ["wrong trace", energyTask({ trace_id: "trace-other" })],
    ["policy decision", energyTask({ policy_decision: { decision: "ALLOW" } })],
  ]) {
    await t.test(name, async () => {
      const { client } = clientFor(task);
      await assert.rejects(client.invoke({
        agentId: "energy-saving",
        traceId: TRACE_ID,
        idempotencyKey: `req-${name.replaceAll(" ", "-")}`,
        input: { event: learningEvent() },
      }), { code: name === "policy decision" ? "AGENT_POLICY_DECISION_FORBIDDEN" : "INVALID_AGENT_TASK" });
    });
  }
});

test("同幂等键相同请求只调用一次；不同请求拒绝重用", async () => {
  const { client, calls } = clientFor(learningEvent());
  const request = {
    agentId: "learning-companion",
    traceId: TRACE_ID,
    idempotencyKey: "req-idempotent-001",
    input: { observation: "synthetic" },
  };
  const [first, second] = await Promise.all([client.invoke(request), client.invoke(request)]);
  assert.deepEqual(first, second);
  assert.equal(calls.length, 1);
  assert.throws(() => client.invoke({ ...request, input: { observation: "different" } }), {
    code: "IDEMPOTENCY_KEY_CONFLICT",
  });
  assert.equal(calls.length, 1);
});

test("超时后不自动重发；重复同一请求返回相同终态", async () => {
  let calls = 0;
  const client = new OpenClawAgentClient({
    timeoutMs: 10,
    sendMessage: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { status: "ok", reply: JSON.stringify(learningEvent()) };
    },
  });
  const request = {
    agentId: "learning-companion",
    traceId: TRACE_ID,
    idempotencyKey: "req-timeout-001",
    input: {},
  };
  await assert.rejects(client.invoke(request), { code: "AGENT_REPLY_TIMEOUT" });
  await assert.rejects(client.invoke(request), { code: "AGENT_REPLY_TIMEOUT" });
  assert.equal(calls, 1);
});

test("幂等缓存满且请求仍在处理中时失败关闭", async () => {
  const client = new OpenClawAgentClient({
    timeoutMs: 20,
    maxRememberedRequests: 1,
    sendMessage: async () => new Promise(() => {}),
  });
  const first = client.invoke({
    agentId: "learning-companion",
    traceId: TRACE_ID,
    idempotencyKey: "req-pending-001",
    input: {},
  });
  assert.throws(() => client.invoke({
    agentId: "learning-companion",
    traceId: TRACE_ID,
    idempotencyKey: "req-pending-002",
    input: {},
  }), { code: "IDEMPOTENCY_CACHE_FULL" });
  await assert.rejects(first, { code: "AGENT_REPLY_TIMEOUT" });
});

test("非 ok 的 sessions_send 状态不进入业务链", async (t) => {
  for (const [status, code] of [["forbidden", "AGENT_CALL_FORBIDDEN"], ["accepted", "AGENT_REPLY_PENDING"], ["timeout", "AGENT_REPLY_TIMEOUT"]]) {
    await t.test(status, async () => {
      const client = new OpenClawAgentClient({ sendMessage: async () => ({ status, sentBeforeError: true }) });
      await assert.rejects(client.invoke({
        agentId: "learning-companion",
        traceId: TRACE_ID,
        idempotencyKey: `req-${status}`,
        input: {},
      }), { code });
    });
  }
});

test("拒绝非对象输入与超大消息", async () => {
  const { client } = clientFor(learningEvent(), { maxMessageBytes: 256 });
  assert.throws(() => client.invoke({
    agentId: "learning-companion",
    traceId: TRACE_ID,
    idempotencyKey: "req-array-input",
    input: [],
  }), { code: "INVALID_AGENT_REQUEST" });
  assert.throws(() => client.invoke({
    agentId: "learning-companion",
    traceId: TRACE_ID,
    idempotencyKey: "req-large-input",
    input: { payload: "x".repeat(1024) },
  }), { code: "AGENT_REQUEST_TOO_LARGE" });
});

test("跨 Agent 输入拒绝认证字段和原始图像/视频内容", () => {
  const { client, calls } = clientFor(learningEvent());
  for (const input of [
    { observation: { api_key: "must-not-leave-process" } },
    { event: { payload: { image_data: "base64" } } },
    { event: { payload: { "access-token": "must-not-leave-process" } } },
  ]) {
    assert.throws(() => client.invoke({
      agentId: "learning-companion",
      traceId: TRACE_ID,
      idempotencyKey: `unsafe-${calls.length}-${JSON.stringify(input).length}`,
      input,
    }), { code: "UNSAFE_AGENT_INPUT" });
  }
  assert.equal(calls.length, 0);
});
