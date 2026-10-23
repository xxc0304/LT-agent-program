import assert from "node:assert/strict";
import test from "node:test";

import { createOpenClawGatewaySendMessage } from "../src/openclaw-gateway-transport.js";

const REPLY = JSON.stringify({ status: "ok", event_id: "evt-1" });

function createSubagentRuntime({ failAt = null, missingInitialSession = false } = {}) {
  const calls = [];
  let historyRead = 0;
  const getSessionMessages = async (params) => {
    calls.push({ method: "getSessionMessages", params });
    if (failAt === "getSessionMessages") throw new Error("synthetic failure");
    historyRead += 1;
    if (missingInitialSession && historyRead === 1) {
      const error = new Error(`No session found: ${params.sessionKey}`);
      if (missingInitialSession !== "message-only") error.code = "INVALID_REQUEST";
      throw error;
    }
    const isFinal = missingInitialSession ? historyRead === 2 : historyRead > 1;
    return {
      messages: [{ role: "assistant", content: [{ type: "text", text: isFinal ? REPLY : "previous reply" }] }],
    };
  };
  const run = async (params) => {
    calls.push({ method: "run", params });
    if (failAt === "run") throw new Error("synthetic failure");
    return { runId: "run-synthetic-1" };
  };
  const waitForRun = async (params) => {
    calls.push({ method: "waitForRun", params });
    if (failAt === "waitForRun") throw new Error("synthetic failure");
    return { status: "ok" };
  };
  return { getSessionMessages, run, waitForRun, calls };
}

function transportFor({ getSessionMessages, run, waitForRun, authorizeTarget = async () => ({ allowed: true }), requesterAgentId = "device-manager", requesterSessionKey = "agent:device-manager:main" } = {}) {
  return createOpenClawGatewaySendMessage({
    subagentRun: run,
    subagentWaitForRun: waitForRun,
    subagentGetSessionMessages: getSessionMessages,
    requesterAgentId,
    requesterSessionKey,
    config: { session: { mainKey: "main" } },
    authorizeTarget,
  });
}

test("通过 OpenClaw runtime.subagent 调用目标 Agent，等待并获取新回复", async () => {
  const runtime = createSubagentRuntime();
  const authorizeCalls = [];
  const sendMessage = transportFor({
    ...runtime,
    authorizeTarget: async (request) => {
      authorizeCalls.push(request);
      return { allowed: true };
    },
  });
  const result = await sendMessage({
    agentId: "learning-companion",
    message: "strict-json-request",
    timeoutSeconds: 5,
    idempotencyKey: "idem-001",
  });

  assert.deepEqual(result, { status: "ok", reply: REPLY });
  assert.deepEqual(authorizeCalls, [{
    requesterAgentId: "device-manager",
    requesterSessionKey: "agent:device-manager:main",
    targetAgentId: "learning-companion",
    targetSessionKey: "agent:learning-companion:main",
    action: "send",
  }]);
  const runCall = runtime.calls.find((call) => call.method === "run");
  assert.equal(runCall.params.sessionKey, "agent:learning-companion:main");
  assert.equal(runCall.params.message, "strict-json-request");
  assert.equal(runCall.params.deliver, false);
  assert.equal(runCall.params.idempotencyKey, "idem-001");
  assert.deepEqual(runtime.calls.map((call) => call.method), [
    "getSessionMessages", "run", "waitForRun", "getSessionMessages",
  ]);
});

test("目标会话尚不存在时，忽略精确缺会话错误并由 runtime.subagent.run 首次创建", async () => {
  const runtime = createSubagentRuntime({ missingInitialSession: true });
  const sendMessage = transportFor(runtime);
  const result = await sendMessage({
    agentId: "energy-saving",
    message: "strict-json-request",
    timeoutSeconds: 5,
    idempotencyKey: "idem-create-target-session",
  });

  assert.deepEqual(result, { status: "ok", reply: REPLY });
  assert.deepEqual(runtime.calls.map((call) => call.method), [
    "getSessionMessages", "run", "waitForRun", "getSessionMessages",
  ]);
  assert.equal(runtime.calls.filter((call) => call.method === "run").length, 1);
  assert.equal(runtime.calls.find((call) => call.method === "run").params.sessionKey, "agent:energy-saving:main");
});

test("runtime 只透出缺会话错误消息时仍可安全首次运行", async () => {
  const runtime = createSubagentRuntime({ missingInitialSession: "message-only" });
  const sendMessage = transportFor(runtime);
  const result = await sendMessage({
    agentId: "energy-saving",
    message: "strict-json-request",
    timeoutSeconds: 5,
    idempotencyKey: "idem-create-target-session-message-only",
  });

  assert.deepEqual(result, { status: "ok", reply: REPLY });
  assert.deepEqual(runtime.calls.map((call) => call.method), [
    "getSessionMessages", "run", "waitForRun", "getSessionMessages",
  ]);
});

test("读取目标会话的其他 INVALID_REQUEST 不得误判为未创建会话", async () => {
  const runtime = createSubagentRuntime();
  runtime.getSessionMessages = async (params) => {
    runtime.calls.push({ method: "getSessionMessages", params });
    const error = new Error("Agent is not configured");
    error.code = "INVALID_REQUEST";
    throw error;
  };
  const sendMessage = transportFor(runtime);
  const result = await sendMessage({
    agentId: "energy-saving",
    message: "strict-json-request",
    idempotencyKey: "idem-resolve-other-error",
  });

  assert.equal(result.status, "error");
  assert.equal(result.sentBeforeError, undefined);
  assert.deepEqual(runtime.calls.map((call) => call.method), ["getSessionMessages"]);
});

test("目标不在白名单或会话策略拒绝时，不启动 subagent run", async (t) => {
  const unknownRuntime = createSubagentRuntime();
  const unknownSend = transportFor(unknownRuntime);
  assert.equal((await unknownSend({
    agentId: "security-agent",
    message: "x",
    idempotencyKey: "idem-unknown",
  })).status, "forbidden");
  assert.equal(unknownRuntime.calls.length, 0);

  await t.test("A2A deny", async () => {
    const deniedRuntime = createSubagentRuntime();
    const deniedSend = transportFor({
      ...deniedRuntime,
      authorizeTarget: async () => ({ allowed: false, error: "denied by policy" }),
    });
    assert.deepEqual(await deniedSend({
      agentId: "energy-saving",
      message: "x",
      idempotencyKey: "idem-denied",
    }), { status: "forbidden", error: "denied by policy" });
    assert.equal(deniedRuntime.calls.length, 0);
  });
});

test("非设备管家会话不能假扮协调者调用子 Agent", async () => {
  const runtime = createSubagentRuntime();
  const sendMessage = transportFor({
    ...runtime,
    requesterAgentId: "energy-saving",
    requesterSessionKey: "agent:energy-saving:main",
  });
  const result = await sendMessage({
    agentId: "learning-companion",
    message: "x",
    idempotencyKey: "idem-forged",
  });
  assert.equal(result.status, "forbidden");
  assert.equal(runtime.calls.length, 0);
});

test("run 已启动后等待失败时标记请求已发出，绝不自动重试", async () => {
  const runtime = createSubagentRuntime({ failAt: "waitForRun" });
  const sendMessage = transportFor(runtime);
  const result = await sendMessage({
    agentId: "energy-saving",
    message: "x",
    idempotencyKey: "idem-after-send-failure",
  });
  assert.deepEqual(result, {
    status: "error",
    sentBeforeError: true,
    error: "OpenClaw subagent 请求失败；请检查 Gateway 状态与 Agent 配置后再决定是否重试",
  });
  assert.equal(runtime.calls.filter((call) => call.method === "run").length, 1);
});
