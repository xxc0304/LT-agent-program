import assert from "node:assert/strict";
import test from "node:test";

import { PlatformAgentRegistry } from "../src/platform-agent-registry.js";
import { createOpenClawPlatformAgentInvoker } from "../src/openclaw-platform-adapter.js";
import { createPlatformOrchestrator } from "../src/platform-orchestrator.js";

test("Mock OpenClaw frontdoor routes an analysis then asks before the device-manager action", async () => {
  const histories = new Map();
  const calls = [];
  let runCounter = 0;
  const invoke = createOpenClawPlatformAgentInvoker({
    requesterAgentId: "dev",
    requesterSessionKey: "agent:dev:main",
    config: { session: { mainKey: "home" } },
    agentIds: ["energy-saving", "device-manager"],
    authorizeTarget: async ({ targetAgentId }) => ({ allowed: ["energy-saving", "device-manager"].includes(targetAgentId) }),
    async subagentGetSessionMessages({ sessionKey }) {
      if (!histories.has(sessionKey)) throw new Error(`No session found: ${sessionKey}`);
      return { messages: histories.get(sessionKey) };
    },
    async subagentRun({ sessionKey, message }) {
      const envelope = JSON.parse(message);
      calls.push({ target: envelope.target_agent, step: envelope.step_id });
      runCounter += 1;
      const reply = envelope.target_agent === "energy-saving"
        ? { status: "PROPOSED", source_agent: envelope.target_agent, trace_id: envelope.trace_id, summary: "灯可能还开着，可以节省一点电。", result: { opportunity: true } }
        : { status: "NEEDS_CONFIRMATION", source_agent: envelope.target_agent, trace_id: envelope.trace_id, question: "客厅灯现在还开着，要我帮你关掉吗？", options: ["关掉", "先不关"] };
      histories.set(sessionKey, [
        ...(histories.get(sessionKey) ?? []),
        { role: "assistant", content: JSON.stringify(reply) },
      ]);
      return { runId: `mock-run-${runCounter}` };
    },
    async subagentWaitForRun() { return { status: "ok" }; },
  });

  const registry = new PlatformAgentRegistry();
  registry.registerAgent({
    agent_id: "energy-saving",
    name: "能源管家",
    capabilities: [{ name: "evaluate_energy_opportunity", effect: "planning" }],
    invoke,
  });
  registry.registerAgent({
    agent_id: "device-manager",
    name: "设备管家 Agent",
    capabilities: [{ name: "manage_household_devices", effect: "device_action" }],
    invoke,
  });
  const orchestrator = createPlatformOrchestrator({ registry });

  const result = await orchestrator.run({
    request: "客厅没人了，帮我看看灯要不要关。",
    plan: {
      trace_id: "trace-integrated-openclaw-mock",
      steps: [
        {
          step_id: "evaluate-energy",
          agent_id: "energy-saving",
          capability: "evaluate_energy_opportunity",
          task: "判断客厅目前是否存在节能机会",
          input: { area: "living_room" },
        },
        {
          step_id: "handle-device",
          agent_id: "device-manager",
          capability: "manage_household_devices",
          task: "核对客厅燈狀態；如需關閉，按設備管家既有策略處理",
          depends_on: ["evaluate-energy"],
          action: { name: "turn_off", target_ref: { device_id: "light.living_room" } },
        },
      ],
    },
  });

  assert.equal(result.status, "NEEDS_CONFIRMATION");
  assert.equal(result.question, "客厅灯现在还开着，要我帮你关掉吗？");
  assert.deepEqual(calls, [
    { target: "energy-saving", step: "evaluate-energy" },
    { target: "device-manager", step: "handle-device" },
  ]);
  assert.equal(result.remaining_step_ids.length, 0);
  assert.equal(result.agent_calls_performed, true);
  assert.equal(result.device_action_agent_invoked, true);
  assert.equal(Object.hasOwn(result, "execution_performed"), false);
});

test("unmatched plans and explicit clarify/unsupported decisions never reach OpenClaw Agent transport", async () => {
  let gatewayRuns = 0;
  let authorizationChecks = 0;
  const invoke = createOpenClawPlatformAgentInvoker({
    requesterAgentId: "dev",
    requesterSessionKey: "agent:dev:main",
    config: { session: { mainKey: "home" } },
    agentIds: ["energy-saving"],
    authorizeTarget: async () => { authorizationChecks += 1; return { allowed: true }; },
    async subagentGetSessionMessages() { return { messages: [] }; },
    async subagentRun() { gatewayRuns += 1; return { runId: "unexpected-run" }; },
    async subagentWaitForRun() { return { status: "ok" }; },
  });
  const registry = new PlatformAgentRegistry();
  registry.registerAgent({
    agent_id: "energy-saving",
    name: "能源管家",
    capabilities: [{ name: "evaluate_energy_opportunity", effect: "planning" }],
    invoke,
  });
  const orchestrator = createPlatformOrchestrator({ registry });

  const outcomes = await Promise.all([
    orchestrator.run({
      request: "帮我维修冰箱",
      plan: {
        trace_id: "trace-unknown-capability",
        steps: [{ step_id: "repair", agent_id: "energy-saving", capability: "repair_appliance", task: "维修冰箱" }],
      },
    }),
    orchestrator.run({
      request: "把空调调舒服一点",
      plan: { trace_id: "trace-clarify", decision: "clarify", question: "你希望调到多少度？" },
    }),
    orchestrator.run({
      request: "帮我换冰箱压缩机",
      plan: { trace_id: "trace-unsupported", decision: "unsupported", message: "我现在还不能维修家电。" },
    }),
  ]);

  assert.deepEqual(outcomes.map(({ status, agent_calls_performed }) => ({ status, agent_calls_performed })), [
    { status: "UNSUPPORTED", agent_calls_performed: false },
    { status: "NEEDS_CLARIFICATION", agent_calls_performed: false },
    { status: "UNSUPPORTED", agent_calls_performed: false },
  ]);
  assert.equal(outcomes[0].reason_code, "CAPABILITY_NOT_REGISTERED");
  assert.equal(outcomes[1].question, "你希望调到多少度？");
  assert.equal(outcomes[2].message, "我现在还不能维修家电。");
  assert.equal(gatewayRuns, 0);
  assert.equal(authorizationChecks, 0);
});
