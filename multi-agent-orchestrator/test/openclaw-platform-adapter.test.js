import assert from "node:assert/strict";
import test from "node:test";

import {
  createOpenClawPlatformAgentInvoker,
  openClawAgentSessionKey,
} from "../src/openclaw-platform-adapter.js";

function makeAdapter({ output, allow = true, runStatus = "ok" } = {}) {
  const calls = [];
  const histories = new Map();
  let runCounter = 0;
  const invoke = createOpenClawPlatformAgentInvoker({
    requesterAgentId: "dev",
    requesterSessionKey: "agent:dev:main",
    config: { session: { mainKey: "main" } },
    agentIds: ["learning-companion", "energy-saving", "device-manager"],
    authorizeTarget: async (call) => {
      calls.push({ type: "authorize", ...call });
      return allow ? { allowed: true } : { allowed: false, error: "access denied by mock" };
    },
    async subagentGetSessionMessages({ sessionKey }) {
      if (!histories.has(sessionKey)) {
        const error = new Error(`No session found: ${sessionKey}`);
        throw error;
      }
      return { messages: histories.get(sessionKey) };
    },
    async subagentRun({ sessionKey, message, idempotencyKey, deliver }) {
      calls.push({ type: "run", sessionKey, envelope: JSON.parse(message), idempotencyKey, deliver });
      runCounter += 1;
      const envelope = JSON.parse(message);
      let result = typeof output === "function" ? output(envelope, runCounter) : output;
      if (result && typeof result === "object" && !Array.isArray(result)) {
        result = {
          source_agent: envelope.target_agent,
          trace_id: envelope.trace_id,
          ...result,
        };
      }
      histories.set(sessionKey, [
        ...(histories.get(sessionKey) ?? []),
        { role: "assistant", content: typeof result === "string" ? result : JSON.stringify(result) },
      ]);
      return { runId: `run-${runCounter}` };
    },
    async subagentWaitForRun() {
      return { status: runStatus };
    },
  });
  return { invoke, calls, histories };
}

const taskCall = {
  agentId: "energy-saving",
  capability: "evaluate_energy_opportunity",
  task: "检查是否有可以节能的设备",
  input: { area: "living_room" },
  dependencyResults: {},
  originalRequest: "客厅没人了，帮我看看要不要关灯。",
  context: {},
  traceId: "trace-openclaw-platform-1",
  stepId: "energy-check",
};

test("OpenClaw adapter routes the structured plan step to a registered Agent session", async () => {
  const expected = {
    status: "COMPLETED",
    source_agent: "energy-saving",
    trace_id: taskCall.traceId,
    summary: "当前没有节能机会。",
    result: { opportunity: false },
  };
  const { invoke, calls } = makeAdapter({ output: expected });
  const result = await invoke(taskCall);

  assert.deepEqual(result, expected);
  const authorization = calls.find((call) => call.type === "authorize");
  assert.equal(authorization.requesterAgentId, "dev");
  assert.equal(authorization.targetAgentId, "energy-saving");
  assert.equal(authorization.targetSessionKey, "agent:energy-saving:main");
  const run = calls.find((call) => call.type === "run");
  assert.equal(run.sessionKey, "agent:energy-saving:main");
  assert.equal(run.deliver, false);
  assert.equal(run.idempotencyKey, "platform:trace-openclaw-platform-1:energy-check");
  assert.equal(run.envelope.protocol, "lt-platform-agent-task/0.1");
  assert.equal(run.envelope.capability, "evaluate_energy_opportunity");
  assert.equal(run.envelope.task, taskCall.task);
});

test("OpenClaw target session respects the configured main key", () => {
  assert.equal(openClawAgentSessionKey("energy-saving", { session: { mainKey: "home" } }), "agent:energy-saving:home");
});

test("refuses unregistered targets, self-calls, sensitive fields, and denied A2A policy before run", async (t) => {
  for (const [name, makeCall, allow] of [
    ["unregistered", (call) => ({ ...call, agentId: "unregistered-agent" }), true],
    ["self-call", (call) => ({ ...call, agentId: "dev" }), true],
    ["sensitive payload", (call) => ({ ...call, input: { access_token: "private" } }), true],
    ["denied A2A", (call) => call, false],
  ]) {
    await t.test(name, async () => {
      const { invoke, calls } = makeAdapter({ output: { status: "COMPLETED", result: {} }, allow });
      await assert.rejects(invoke(makeCall(taskCall)), name === "denied A2A"
        ? { code: "AGENT_CALL_FORBIDDEN" }
        : undefined);
      assert.equal(calls.some((call) => call.type === "run"), false);
    });
  }
});

test("does not automatically resend after a Gateway timeout", async () => {
  const { invoke, calls } = makeAdapter({ output: { status: "COMPLETED", result: {} }, runStatus: "timeout" });
  await assert.rejects(invoke(taskCall), { code: "AGENT_REPLY_TIMEOUT", sentBeforeError: true });
  assert.equal(calls.filter((call) => call.type === "run").length, 1);
});

test("serializes two calls into the same OpenClaw Agent session", async () => {
  const events = [];
  const invoke = createOpenClawPlatformAgentInvoker({
    requesterAgentId: "dev",
    requesterSessionKey: "agent:dev:main",
    agentIds: ["energy-saving"],
    authorizeTarget: async () => ({ allowed: true }),
    async subagentGetSessionMessages({ sessionKey }) {
      if (!histories.has(sessionKey)) throw new Error(`No session found: ${sessionKey}`);
      return { messages: histories.get(sessionKey) };
    },
    async subagentRun({ sessionKey, message }) {
      const envelope = JSON.parse(message);
      events.push(`${envelope.step_id}:start`);
      await new Promise((resolve) => setTimeout(resolve, 15));
      histories.set(sessionKey, [
        ...(histories.get(sessionKey) ?? []),
        { role: "assistant", content: JSON.stringify({ status: "COMPLETED", source_agent: "energy-saving", trace_id: envelope.trace_id, result: {} }) },
      ]);
      events.push(`${envelope.step_id}:end`);
      return { runId: envelope.step_id };
    },
    async subagentWaitForRun() { return { status: "ok" }; },
  });
  const histories = new Map();
  await Promise.all([
    invoke({ ...taskCall, stepId: "first" }),
    invoke({ ...taskCall, stepId: "second" }),
  ]);

  assert.equal(events[0], "first:start");
  assert.equal(events[1], "first:end");
  assert.equal(events[2], "second:start");
  assert.equal(events[3], "second:end");
});

test("requires plain JSON and a typed status from every Agent", async (t) => {
  for (const [reply, code] of [
    ["结果如下：{\"status\":\"COMPLETED\"}", "AGENT_REPLY_NOT_JSON"],
    [JSON.stringify({ summary: "missing status", result: {} }), "INVALID_AGENT_REPLY"],
    [JSON.stringify({
      status: "NEEDS_CLARIFICATION",
      source_agent: taskCall.agentId,
      trace_id: taskCall.traceId,
      result: {},
    }), "INVALID_AGENT_REPLY"],
  ]) {
    await t.test(code, async () => {
      const { invoke } = makeAdapter({ output: reply });
      await assert.rejects(invoke(taskCall), { code });
    });
  }
});

test("rejects a reply whose Agent identity or trace does not match the dispatched step", async () => {
  const { invoke } = makeAdapter({ output: {
    status: "COMPLETED",
    source_agent: "device-manager",
    trace_id: "trace-from-another-request",
    result: {},
  } });
  await assert.rejects(invoke(taskCall), { code: "INVALID_AGENT_REPLY_IDENTITY" });
});
