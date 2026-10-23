import test from "node:test";
import assert from "node:assert/strict";

import { PlatformAgentRegistry } from "../src/platform-agent-registry.js";
import { createPlatformOrchestrator } from "../src/platform-orchestrator.js";

const request = "家里现在有没有值得节能处理的事情？";
const TRACE_ID = "trace-platform-test";

function agentReply(agentId, status, fields = {}) {
  return { status, source_agent: agentId, trace_id: TRACE_ID, ...fields };
}

function plan(steps, traceId = "trace-platform-test") {
  return { trace_id: traceId, steps };
}

function step(step_id, agent_id, capability, extra = {}) {
  return { step_id, agent_id, capability, task: `完成${step_id}`, ...extra };
}

function makeRegistry(overrides = {}) {
  const registry = new PlatformAgentRegistry();
  registry.registerAgent({
    agent_id: "energy-saving",
    name: "节能 Agent",
    capabilities: [{ name: "evaluate_energy", effect: "planning" }],
    invoke: overrides.energy ?? (async () => agentReply("energy-saving", "NO_ACTION", { result: { reason: "无节能机会" } })),
  });
  registry.registerAgent({
    agent_id: "learning-companion",
    name: "学习伴学 Agent",
    capabilities: [{ name: "analyze_activity", effect: "planning" }],
    invoke: overrides.learning ?? (async () => agentReply("learning-companion", "COMPLETED", { result: { activity: "reading" } })),
  });
  registry.registerAgent({
    agent_id: "device-manager",
    name: "设备管家 Agent",
    capabilities: [
      { name: "inspect_household", effect: "read_only" },
      { name: "manage_devices", effect: "device_action" },
    ],
    invoke: overrides.deviceManager ?? (async () => agentReply("device-manager", "COMPLETED", { result: { execution_performed: false } })),
  });
  return registry;
}

test("F0: a frontdoor-proposed single-step plan reaches a registered Agent and returns a trace", async () => {
  const calls = [];
  const registry = makeRegistry({
    energy: async (call) => {
      calls.push(call);
      return agentReply("energy-saving", "NO_ACTION", { result: { reason_code: "NO_OPPORTUNITY" } });
    },
  });
  const orchestrator = createPlatformOrchestrator({ registry });
  const inputPlan = plan([step("step-1", "energy-saving", "evaluate_energy")]);

  const result = await orchestrator.run({ request, plan: inputPlan, context: { conversation_id: "conversation-1" } });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, "energy-saving");
  assert.equal(calls[0].originalRequest, request);
  assert.equal(calls[0].traceId, inputPlan.trace_id);
  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(result.results.map(({ step_id, status }) => ({ step_id, status })), [
    { step_id: "step-1", status: "NO_ACTION" },
  ]);
});

test("independent analysis Agents run concurrently; dependencies run in a later wave", async () => {
  const events = [];
  const registry = makeRegistry({
    energy: async () => {
      events.push("energy:start");
      await new Promise((resolve) => setTimeout(resolve, 15));
      events.push("energy:end");
      return agentReply("energy-saving", "COMPLETED", { result: { opportunity: "none" } });
    },
    learning: async () => {
      events.push("learning:start");
      await new Promise((resolve) => setTimeout(resolve, 15));
      events.push("learning:end");
      return agentReply("learning-companion", "COMPLETED", { result: { activity: "reading" } });
    },
    deviceManager: async (call) => {
      events.push("device-manager:start");
      assert.deepEqual(Object.keys(call.dependencyResults).sort(), ["energy", "learning"]);
      return agentReply("device-manager", "COMPLETED", { result: { reviewed: true } });
    },
  });
  const orchestrator = createPlatformOrchestrator({ registry });
  const inputPlan = plan([
    step("energy", "energy-saving", "evaluate_energy"),
    step("learning", "learning-companion", "analyze_activity"),
    step("review", "device-manager", "inspect_household", { depends_on: ["energy", "learning"] }),
  ]);

  const result = await orchestrator.run({ request, plan: inputPlan });

  assert.equal(result.status, "COMPLETED");
  assert.ok(events.indexOf("energy:start") < events.indexOf("learning:end"));
  assert.ok(events.indexOf("learning:start") < events.indexOf("energy:end"));
  assert.ok(events.indexOf("device-manager:start") > events.indexOf("energy:end"));
  assert.ok(events.indexOf("device-manager:start") > events.indexOf("learning:end"));
});

test("an observed clarification stops queued work in other parallel Agent batches", async () => {
  const calls = [];
  const registry = makeRegistry({
    energy: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return agentReply("energy-saving", "NEEDS_CLARIFICATION", { question: "占用信息有些旧，要继续检查吗？" });
    },
    learning: async ({ stepId }) => {
      calls.push(stepId);
      if (stepId === "learning-first") await new Promise((resolve) => setTimeout(resolve, 20));
      return agentReply("learning-companion", "COMPLETED", { result: {} });
    },
  });
  const orchestrator = createPlatformOrchestrator({ registry });
  const inputPlan = plan([
    step("energy-check", "energy-saving", "evaluate_energy"),
    step("learning-first", "learning-companion", "analyze_activity"),
    step("learning-later", "learning-companion", "analyze_activity"),
  ]);

  const result = await orchestrator.run({ request, plan: inputPlan });

  assert.equal(result.status, "NEEDS_CLARIFICATION");
  assert.deepEqual(calls, ["learning-first"]);
  assert.equal(result.remaining_step_ids.includes("learning-later"), true);
});

test("a concurrent failure takes precedence over clarification regardless of plan order", async () => {
  const run = async (steps) => {
    const registry = makeRegistry({
      energy: async () => agentReply("energy-saving", "NEEDS_CLARIFICATION", { question: "要继续检查吗？" }),
      learning: async () => agentReply("learning-companion", "FAILED", {
        error: { code: "ANALYSIS_UNAVAILABLE", message: "分析暂时不可用" },
      }),
    });
    return createPlatformOrchestrator({ registry }).run({ request, plan: plan(steps) });
  };
  const energyStep = step("energy-check", "energy-saving", "evaluate_energy");
  const learningStep = step("learning-check", "learning-companion", "analyze_activity");

  const firstOrder = await run([energyStep, learningStep]);
  const reversedOrder = await run([learningStep, energyStep]);

  assert.equal(firstOrder.status, "FAILED");
  assert.equal(reversedOrder.status, "FAILED");
  assert.equal(firstOrder.blocked_step_id, "learning-check");
  assert.equal(reversedOrder.blocked_step_id, "learning-check");
  assert.equal(firstOrder.results.filter((item) => ["FAILED", "NEEDS_CLARIFICATION"].includes(item.status)).length, 2);
});

test("an uncertainty response stops the plan before any device-action Agent is called", async () => {
  let deviceCalls = 0;
  const registry = makeRegistry({
    energy: async () => ({
      ...agentReply("energy-saving", "NEEDS_CLARIFICATION", {
      question: "房间里没有人在家，但传感器最近一次报告有些旧；要继续检查，还是先不动？",
      options: ["继续检查", "先不处理"],
      reason_code: "STALE_OCCUPANCY_EVIDENCE",
      }),
    }),
    deviceManager: async () => {
      deviceCalls += 1;
      return agentReply("device-manager", "COMPLETED", { result: {} });
    },
  });
  const orchestrator = createPlatformOrchestrator({ registry });
  const inputPlan = plan([
    step("energy", "energy-saving", "evaluate_energy"),
    step("turn-off", "device-manager", "manage_devices", {
      action: { name: "turn_off", target_ref: { device_id: "light.living_room" } },
    }),
  ]);

  const result = await orchestrator.run({ request, plan: inputPlan });

  assert.equal(result.status, "NEEDS_CLARIFICATION");
  assert.match(result.question, /传感器/);
  assert.equal(result.blocked_step_id, "energy");
  assert.equal(deviceCalls, 0);
  assert.equal(result.remaining_step_ids.includes("turn-off"), true);
});

test("same-device conflicting actions are returned for clarification before any Agent call", async () => {
  let calls = 0;
  const registry = makeRegistry({ energy: async () => { calls += 1; return agentReply("energy-saving", "COMPLETED", { result: {} }); } });
  const orchestrator = createPlatformOrchestrator({ registry });
  const inputPlan = plan([
    step("on", "device-manager", "manage_devices", {
      action: { name: "turn_on", target_ref: { device_id: "light.living_room" } },
    }),
    step("off", "device-manager", "manage_devices", {
      action: { name: "turn_off", target_ref: { device_id: "light.living_room" } },
    }),
  ]);

  const result = await orchestrator.run({ request, plan: inputPlan });

  assert.equal(result.status, "NEEDS_CLARIFICATION");
  assert.equal(result.reason_code, "DEVICE_ACTION_CONFLICT");
  assert.equal(calls, 0);
  assert.equal(result.device_action_agent_invoked, false);
});

test("multiple device-action steps without complete target/action metadata stop before any Agent call", async () => {
  let calls = 0;
  const registry = makeRegistry({
    energy: async () => { calls += 1; return agentReply("energy-saving", "COMPLETED", { result: {} }); },
    deviceManager: async () => { calls += 1; return agentReply("device-manager", "COMPLETED", { result: {} }); },
  });
  const orchestrator = createPlatformOrchestrator({ registry });
  const inputPlan = plan([
    step("energy", "energy-saving", "evaluate_energy"),
    step("turn-off-light", "device-manager", "manage_devices", {
      action: { name: "turn_off", target_ref: { device_id: "light.living_room" } },
    }),
    step("set-ac", "device-manager", "manage_devices"),
  ]);

  const result = await orchestrator.run({ request, plan: inputPlan });

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason_code, "DEVICE_ACTION_DETAILS_REQUIRED");
  assert.equal(result.error.code, "DEVICE_ACTION_DETAILS_REQUIRED");
  assert.deepEqual(result.incomplete_step_ids, ["set-ac"]);
  assert.equal(result.agent_calls_performed, false);
  assert.equal(result.device_action_agent_invoked, false);
  assert.equal(result.results.length, 0);
  assert.equal(calls, 0);
});

test("multiple complete non-conflicting device-action steps must be consolidated before dispatch", async () => {
  let calls = 0;
  const registry = makeRegistry({
    deviceManager: async () => { calls += 1; return agentReply("device-manager", "COMPLETED", { result: {} }); },
  });
  const orchestrator = createPlatformOrchestrator({ registry });
  const inputPlan = plan([
    step("turn-off-light", "device-manager", "manage_devices", {
      action: { name: "turn_off", target_ref: { device_id: "light.living_room" } },
    }),
    step("set-ac", "device-manager", "manage_devices", {
      action: { name: "set_temperature", target_ref: { device_id: "climate.living_room" }, parameters: { temperature: 25 } },
    }),
  ]);

  const result = await orchestrator.run({ request, plan: inputPlan });

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason_code, "MULTIPLE_DEVICE_ACTION_STEPS_REQUIRE_AGGREGATION");
  assert.equal(result.error.code, "MULTIPLE_DEVICE_ACTION_STEPS_REQUIRE_AGGREGATION");
  assert.equal(result.agent_calls_performed, false);
  assert.equal(result.device_action_agent_invoked, false);
  assert.equal(calls, 0);
});

test("a single natural-language device task can reach device-manager for its own device resolution and safety flow", async () => {
  const calls = [];
  const registry = makeRegistry({
    deviceManager: async (call) => {
      calls.push(call);
      return agentReply("device-manager", "NEEDS_CLARIFICATION", {
        question: "客厅有两盏灯，你想关哪一盏？",
      });
    },
  });
  const orchestrator = createPlatformOrchestrator({ registry });
  const inputPlan = plan([
    step("manage-lights", "device-manager", "manage_devices", {
      task: "把客厅那盏灯关掉",
    }),
  ]);

  const result = await orchestrator.run({ request: "把客厅那盏灯关掉", plan: inputPlan });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].task, "把客厅那盏灯关掉");
  assert.equal(result.status, "NEEDS_CLARIFICATION");
  assert.equal(result.question, "客厅有两盏灯，你想关哪一盏？");
  assert.equal(result.device_action_agent_invoked, true);
});

test("an Agent can explicitly request confirmation and later steps are not dispatched", async () => {
  let laterCalls = 0;
  const registry = makeRegistry({
    energy: async () => agentReply("energy-saving", "NEEDS_CONFIRMATION", { question: "要现在关闭这台空调吗？" }),
    learning: async () => { laterCalls += 1; return agentReply("learning-companion", "COMPLETED", { result: {} }); },
  });
  const orchestrator = createPlatformOrchestrator({ registry });
  const inputPlan = plan([
    step("energy", "energy-saving", "evaluate_energy"),
    step("learning", "learning-companion", "analyze_activity", { depends_on: ["energy"] }),
  ]);

  const result = await orchestrator.run({ request, plan: inputPlan });

  assert.equal(result.status, "NEEDS_CONFIRMATION");
  assert.equal(result.question, "要现在关闭这台空调吗？");
  assert.equal(laterCalls, 0);
});

test("a sent device-action call with an unknown Gateway reply is not retried and is marked uncertain", async () => {
  let calls = 0;
  const registry = makeRegistry({
    deviceManager: async () => {
      calls += 1;
      const error = new Error("Gateway reply timed out");
      error.code = "AGENT_REPLY_TIMEOUT";
      error.sentBeforeError = true;
      throw error;
    },
  });
  const orchestrator = createPlatformOrchestrator({ registry });
  const inputPlan = plan([
    step("turn-off", "device-manager", "manage_devices", {
      action: { name: "turn_off", target_ref: { device_id: "light.living_room" } },
    }),
  ]);

  const result = await orchestrator.run({ request, plan: inputPlan });

  assert.equal(result.status, "FAILED");
  assert.equal(result.device_action_agent_invoked, true);
  assert.equal(result.side_effects_unknown, true);
  assert.equal(calls, 1);
});

test("an Agent reply with the wrong source or trace is rejected", async () => {
  const registry = makeRegistry({
    energy: async () => ({
      status: "COMPLETED",
      source_agent: "device-manager",
      trace_id: "trace-from-another-request",
      result: { opportunity: false },
    }),
  });
  const orchestrator = createPlatformOrchestrator({ registry });
  const result = await orchestrator.run({
    request,
    plan: plan([step("energy", "energy-saving", "evaluate_energy")]),
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.results[0].error.code, "AGENT_REPLY_IDENTITY_MISMATCH");
});

test("OpenClaw can ask a natural-language clarification without dispatching any Agent", async () => {
  let calls = 0;
  const registry = makeRegistry({
    energy: async () => { calls += 1; return agentReply("energy-saving", "COMPLETED", { result: {} }); },
    deviceManager: async () => { calls += 1; return agentReply("device-manager", "COMPLETED", { result: {} }); },
  });
  const result = await createPlatformOrchestrator({ registry }).run({
    request: "帮我把空调调舒服一点",
    plan: {
      ...plan([]),
      decision: "clarify",
      question: "你希望把空调调到多少度？",
    },
  });

  assert.equal(result.status, "NEEDS_CLARIFICATION");
  assert.equal(result.reason_code, "OPENCLAW_REQUESTED_CLARIFICATION");
  assert.equal(result.question, "你希望把空调调到多少度？");
  assert.equal(result.agent_calls_performed, false);
  assert.equal(result.device_action_agent_invoked, false);
  assert.deepEqual(result.results, []);
  assert.equal(calls, 0);
});

test("OpenClaw can report an unsupported request without dispatching any Agent", async () => {
  let calls = 0;
  const registry = makeRegistry({
    energy: async () => { calls += 1; return agentReply("energy-saving", "COMPLETED", { result: {} }); },
  });
  const result = await createPlatformOrchestrator({ registry }).run({
    request: "帮我给冰箱更换压缩机",
    plan: {
      ...plan([]),
      decision: "unsupported",
      message: "我目前还不能维修或更换家电零件。",
    },
  });

  assert.equal(result.status, "UNSUPPORTED");
  assert.equal(result.reason_code, "NO_REGISTERED_CAPABILITY_MATCH");
  assert.equal(result.message, "我目前还不能维修或更换家电零件。");
  assert.equal(result.agent_calls_performed, false);
  assert.equal(result.device_action_agent_invoked, false);
  assert.deepEqual(result.results, []);
  assert.equal(calls, 0);
});

test("unknown Agent/capability references return a clear no-dispatch fallback", async (t) => {
  for (const [name, inputPlan, reasonCode] of [
    ["unknown Agent", plan([step("x", "invented-agent", "do_thing")]), "AGENT_NOT_REGISTERED"],
    ["unknown capability", plan([step("x", "energy-saving", "control_devices")]), "CAPABILITY_NOT_REGISTERED"],
  ]) {
    await t.test(name, async () => {
      let calls = 0;
      const registry = makeRegistry({
        energy: async () => { calls += 1; return agentReply("energy-saving", "COMPLETED", { result: {} }); },
        deviceManager: async () => { calls += 1; return agentReply("device-manager", "COMPLETED", { result: {} }); },
      });
      const result = await createPlatformOrchestrator({ registry }).run({ request, plan: inputPlan });

      assert.equal(result.status, "UNSUPPORTED");
      assert.equal(result.reason_code, reasonCode);
      assert.match(result.message, /暂时找不到已接入的功能/);
      assert.equal(result.agent_calls_performed, false);
      assert.equal(result.device_action_agent_invoked, false);
      assert.deepEqual(result.results, []);
      assert.equal(calls, 0);
    });
  }
});

test("invalid dependencies and cycles are rejected before dispatch", async (t) => {
  for (const [name, inputPlan, code] of [
    ["missing dependency", plan([step("x", "energy-saving", "evaluate_energy", { depends_on: ["absent"] })]), "INVALID_ORCHESTRATION_PLAN"],
    ["dependency cycle", plan([
      step("x", "energy-saving", "evaluate_energy", { depends_on: ["y"] }),
      step("y", "learning-companion", "analyze_activity", { depends_on: ["x"] }),
    ]), "PLAN_DEPENDENCY_CYCLE"],
  ]) {
    await t.test(name, async () => {
      let calls = 0;
      const registry = makeRegistry({ energy: async () => { calls += 1; return agentReply("energy-saving", "COMPLETED", { result: {} }); } });
      const orchestrator = createPlatformOrchestrator({ registry });
      await assert.rejects(orchestrator.run({ request, plan: inputPlan }), { code });
      assert.equal(calls, 0);
    });
  }
});

test("only device-manager may register a physical device-action capability", () => {
  const registry = new PlatformAgentRegistry();
  assert.throws(() => registry.registerAgent({
    agent_id: "energy-saving",
    capabilities: [{ name: "turn_off_device", effect: "device_action" }],
    invoke: async () => agentReply("energy-saving", "COMPLETED", { result: {} }),
  }), { code: "DEVICE_ACTION_AGENT_FORBIDDEN" });
});
