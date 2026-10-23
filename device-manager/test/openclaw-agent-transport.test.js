import assert from "node:assert/strict";
import test from "node:test";

function unpackToolResult(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const textBlock = result?.content?.find((block) => block.type === "text" && typeof block.text === "string");
  if (textBlock) return JSON.parse(textBlock.text);
  return result;
}

function makeConfig(overrides = {}) {
  return {
    session: { mainKey: "main" },
    tools: {
      sessions: { visibility: "all" },
      agentToAgent: {
        enabled: true,
        allow: ["dev", "device-manager", "learning-companion", "energy-saving"],
      },
    },
    ...overrides,
  };
}

function makeSubagentRuntime(reply, { failAt } = {}) {
  const calls = [];
  let historyCount = 0;
  return {
    calls,
    async getSessionMessages(params) {
      calls.push({ method: "getSessionMessages", params });
      if (failAt === "getSessionMessages") throw new Error("synthetic subagent error");
      historyCount += 1;
      return { messages: historyCount === 1 ? [] : [{ role: "assistant", content: [{ type: "text", text: reply }] }] };
    },
    async run(params) {
      calls.push({ method: "run", params });
      if (failAt === "run") throw new Error("synthetic subagent error");
      return { runId: "run-plugin-test" };
    },
    async waitForRun(params) {
      calls.push({ method: "waitForRun", params });
      if (failAt === "waitForRun") throw new Error("synthetic subagent error");
      return { status: "ok" };
    },
  };
}

async function registerAgentTool(config, subagent, name = "call_independent_agent", pluginConfig = {}) {
  const { default: plugin } = await import(`../src/openclaw-plugin.js?agent-transport=${Date.now()}-${Math.random()}`);
  const registered = new Map();
  plugin.register({
    pluginConfig,
    config,
    runtime: { subagent },
    registerTool(tool, options) {
      if (typeof tool === "function") registered.set(options?.name, tool);
      else registered.set(tool.name, tool);
    },
  });
  return registered.get(name);
}

test("设备管家插件从可信运行时上下文调用独立 Agent，输出通过契约校验", async () => {
  const traceId = "trace-plugin-transport-1";
  const event = {
    schema_version: "0.1",
    event_id: "evt-plugin-transport-1",
    source_agent: "learning-companion",
    event_type: "learning_behavior",
    occurred_at: "2026-10-15T08:00:00.000Z",
    confidence: 0.9,
    needs_review: true,
    privacy_level: "restricted",
    data_level: "L3",
    trace_id: traceId,
    source: { type: "synthetic_observation", id: "learning-companion" },
    payload: { behavior: "writing", presence: "present", area: "study_room", duration_ms: 0 },
  };
  const subagent = makeSubagentRuntime(JSON.stringify(event));
  const toolFactory = await registerAgentTool(makeConfig(), subagent);
  assert.equal(typeof toolFactory, "function");
  const tool = toolFactory({
    agentId: "device-manager",
    sessionKey: "agent:device-manager:main",
    sandboxed: false,
    getRuntimeConfig: () => makeConfig(),
  });
  assert.equal(tool.name, "call_independent_agent");

  const output = unpackToolResult(await tool.execute("tool-call-1", {
    agent_id: "learning-companion",
    trace_id: traceId,
    idempotency_key: "idem-plugin-1",
    input: { observation: "synthetic observation" },
  }));
  assert.equal(output.status, "ok");
  assert.equal(output.output.event_id, event.event_id);
  assert.equal(subagent.calls.filter((call) => call.method === "run").length, 1);
  assert.equal(subagent.calls.find((call) => call.method === "run").params.idempotencyKey, "idem-plugin-1");
  assert.equal(subagent.calls.find((call) => call.method === "run").params.sessionKey, "agent:learning-companion:main");
});

test("独立 Agent 工具对其他 Agent 不注册，且 A2A 被拒绝时不访问 Gateway", async () => {
  const deniedSubagent = makeSubagentRuntime("unused");
  const toolFactory = await registerAgentTool(makeConfig({
    tools: {
      sessions: { visibility: "tree" },
      agentToAgent: { enabled: false, allow: [] },
    },
  }), deniedSubagent);

  assert.equal(toolFactory({
    agentId: "energy-saving",
    sessionKey: "agent:energy-saving:main",
    sandboxed: false,
  }), null);

  const tool = toolFactory({
    agentId: "device-manager",
    sessionKey: "agent:device-manager:main",
    sandboxed: false,
    getRuntimeConfig: () => makeConfig({
      tools: {
        sessions: { visibility: "tree" },
        agentToAgent: { enabled: false, allow: [] },
      },
    }),
  });
  const output = unpackToolResult(await tool.execute("tool-call-denied", {
    agent_id: "energy-saving",
    trace_id: "trace-denied",
    idempotency_key: "idem-denied",
    input: { event: { event_id: "evt-1" } },
  }));
  assert.equal(output.status, "error");
  assert.equal(output.error.code, "AGENT_CALL_FORBIDDEN");
  assert.equal(deniedSubagent.calls.length, 0);
});

test("OpenClaw 用户主 Agent dev 可在原聊天中转接家庭请求给设备管家并取回自然语言答复", async () => {
  const reply = "客厅灯现在是关闭状态。";
  const subagent = makeSubagentRuntime(reply);
  const toolFactory = await registerAgentTool(makeConfig(), subagent, "talk_to_device_manager");

  assert.equal(toolFactory({
    agentId: "device-manager",
    sessionKey: "agent:device-manager:main",
    sandboxed: false,
  }), null);
  assert.equal(toolFactory({
    agentId: "energy-saving",
    sessionKey: "agent:energy-saving:main",
    sandboxed: false,
  }), null);

  const tool = toolFactory({
    agentId: "dev",
    sessionKey: "agent:dev:main",
    sandboxed: false,
    getRuntimeConfig: () => makeConfig(),
  });
  assert.equal(tool.name, "talk_to_device_manager");

  const output = unpackToolResult(await tool.execute("frontdoor-call-1", {
    request: "客厅灯现在开着吗？",
  }));
  assert.equal(output.status, "ok");
  assert.equal(output.reply, reply);

  const runCall = subagent.calls.find((call) => call.method === "run");
  assert.equal(runCall.params.sessionKey, "agent:device-manager:main");
  assert.equal(runCall.params.deliver, false);
  assert.equal(runCall.params.idempotencyKey, "openclaw-household:frontdoor-call-1");
  assert.match(runCall.params.message, /客厅灯现在开着吗？/);
  assert.match(runCall.params.message, /不要要求用户切换到设备管家 Agent/);
});

test("主对话无法通过转接工具绕过 OpenClaw A2A 策略，策略拒绝时不发起 Agent run", async () => {
  const subagent = makeSubagentRuntime("unused");
  const deniedConfig = makeConfig({
    tools: {
      sessions: { visibility: "all" },
      agentToAgent: { enabled: true, allow: ["dev"] },
    },
  });
  const toolFactory = await registerAgentTool(deniedConfig, subagent, "talk_to_device_manager");
  const tool = toolFactory({
    agentId: "dev",
    sessionKey: "agent:dev:main",
    sandboxed: false,
    getRuntimeConfig: () => deniedConfig,
  });

  const output = unpackToolResult(await tool.execute("frontdoor-call-denied", {
    request: "关掉客厅灯",
  }));
  assert.equal(output.status, "forbidden");
  assert.equal(subagent.calls.length, 0);
});

test("家庭请求中疑似含凭据时不转交给设备管家或 Gateway", async () => {
  const subagent = makeSubagentRuntime("unused");
  const toolFactory = await registerAgentTool(makeConfig(), subagent, "talk_to_device_manager");
  const tool = toolFactory({
    agentId: "dev",
    sessionKey: "agent:dev:main",
    sandboxed: false,
    getRuntimeConfig: () => makeConfig(),
  });

  const output = unpackToolResult(await tool.execute("frontdoor-credential-rejected", {
    request: "我的 api_key=TEST_FIXTURE，请帮我处理设备。",
  }));
  assert.equal(output.status, "error");
  assert.match(output.error, /疑似包含凭据/);
  assert.equal(subagent.calls.length, 0);
});

test("主聊天 Agent ID 可配置为 main，转接工具仍只允许配置的 Agent 会话调用", async () => {
  const reply = "目前客厅灯是关闭的。";
  const subagent = makeSubagentRuntime(reply);
  const config = makeConfig({
    tools: {
      sessions: { visibility: "all" },
      agentToAgent: { enabled: true, allow: ["main", "device-manager"] },
    },
  });
  const toolFactory = await registerAgentTool(config, subagent, "talk_to_device_manager", { frontdoorAgentId: "main" });

  assert.equal(toolFactory({
    agentId: "dev",
    sessionKey: "agent:dev:main",
    sandboxed: false,
  }), null);

  const tool = toolFactory({
    agentId: "main",
    sessionKey: "agent:main:main",
    sandboxed: false,
    getRuntimeConfig: () => config,
  });
  assert.equal(tool.name, "talk_to_device_manager");

  const output = unpackToolResult(await tool.execute("frontdoor-main-call", {
    request: "帮我看看客厅灯关着没有",
  }));
  assert.equal(output.status, "ok");
  assert.equal(output.reply, reply);
  assert.equal(subagent.calls.find((call) => call.method === "run").params.sessionKey, "agent:device-manager:main");
});

test("集成编排工具把 NO_ACTION 当作正常结果，并仅注册在设备管家 Agent", async () => {
  const traceId = "trace-independent-energy-no-action";
  const noAction = {
    schema_version: "0.1",
    outcome: "NO_ACTION",
    source_agent: "energy-saving",
    trace_id: traceId,
    reason_code: "OCCUPANCY_NOT_CONFIRMED",
  };
  const subagent = makeSubagentRuntime(JSON.stringify(noAction));
  const toolFactory = await registerAgentTool(makeConfig(), subagent, "evaluate_energy_event_with_independent_agent");
  const unauthorized = toolFactory({
    agentId: "energy-saving",
    sessionKey: "agent:energy-saving:main",
    sandboxed: false,
  });
  assert.equal(unauthorized, null);

  const tool = toolFactory({
    agentId: "device-manager",
    sessionKey: "agent:device-manager:main",
    sandboxed: false,
    getRuntimeConfig: () => makeConfig(),
  });
  const output = unpackToolResult(await tool.execute("tool-energy-no-action", {
    event: {
      schema_version: "0.1",
      event_id: "evt-independent-energy-no-action",
      source_agent: "openclaw-unverified-input",
      event_type: "occupancy_changed",
      occurred_at: "2026-10-15T08:00:00.000Z",
      privacy_level: "family",
      payload: { area: "living_room", occupied: true },
    },
    trace_id: traceId,
    idempotency_key: "idem-independent-energy-no-action",
  }));

  assert.equal(output.status, "NO_ACTION");
  assert.equal(output.execution_performed, false);
  assert.equal(output.reason_code, "OCCUPANCY_NOT_CONFIRMED");
  assert.equal(subagent.calls.filter((call) => call.method === "run").length, 1);
});
