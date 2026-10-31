import test from "node:test";
import assert from "node:assert/strict";
import { AgentPlanValidator, fingerprintAgentPlan } from "../src/plan-validator.js";
import { AgentPlanExecutor } from "../src/plan-executor.js";

const NOW = Date.parse("2026-10-09T10:00:00.000Z");

function makePlan(overrides = {}) {
  return {
    schema_version: "0.1",
    plan_id: "plan-study-lamp",
    trace_id: "trace-study-lamp",
    goal: "在满足家庭策略时关闭学习灯",
    steps: [
      {
        step_id: "check-occupancy",
        agent_id: "device-manager",
        capability: "read_occupancy",
        depends_on: [],
        evidence_refs: ["occupancy-study"],
        input: { area: "study" },
      },
      {
        step_id: "plan-energy-action",
        agent_id: "energy-saving",
        capability: "plan_energy_action",
        depends_on: ["check-occupancy"],
        evidence_refs: ["occupancy-study"],
        input: { area: "study" },
      },
      {
        step_id: "turn-off-study-light",
        agent_id: "device-manager",
        capability: "execute_device_action",
        depends_on: ["plan-energy-action"],
        evidence_refs: ["occupancy-study"],
        action: {
          name: "turn_off",
          target_ref: { device_id: "light.study" },
          parameters: {},
        },
      },
    ],
    ...overrides,
  };
}

function makeValidator({
  autoAllowedDeviceActions = [{ device_id: "light.study", action: "turn_off" }],
  blockedActions = [],
} = {}) {
  return new AgentPlanValidator({
    clock: () => NOW,
    agents: [
      {
        agent_id: "device-manager",
        capabilities: {
          read_occupancy: {
            effect: "read_only",
            required_evidence: [{
              evidence_type: "occupancy",
              trusted: true,
              allowed_sources: ["home_assistant"],
              max_age_ms: 60_000,
            }],
          },
          execute_device_action: { effect: "device_action" },
        },
      },
      {
        agent_id: "energy-saving",
        capabilities: {
          plan_energy_action: { effect: "planning" },
        },
      },
    ],
    householdPolicy: {
      allowedDeviceIds: ["light.study", "lock.front_door"],
      allowedActions: ["turn_on", "turn_off", "unlock"],
      autoAllowedDeviceActions,
      blockedActions,
    },
  });
}

function trustedOccupancyEvidence(overrides = {}) {
  return {
    evidence_id: "occupancy-study",
    evidence_type: "occupancy",
    trust_level: "trusted",
    source_type: "home_assistant",
    observed_at: new Date(NOW - 15_000).toISOString(),
    source_id: "ha-study-presence",
    ...overrides,
  };
}

test("按依赖关系校验通过的计划并返回稳定的执行顺序，但不实际执行", () => {
  const result = makeValidator().evaluate(makePlan(), { evidence: [trustedOccupancyEvidence()] });
  assert.equal(result.decision, "ALLOW");
  assert.deepEqual(result.ordered_step_ids, ["check-occupancy", "plan-energy-action", "turn-off-study-light"]);
  assert.equal(result.execution_performed, false);
  assert.equal(result.findings.length, 0);
});

test("未知 Agent 或未登记能力会拒绝模型计划", () => {
  const plan = makePlan({ steps: [{
    step_id: "invented-step",
    agent_id: "imaginary-agent",
    capability: "unlock_everything",
    depends_on: [],
    evidence_refs: [],
  }] });
  const result = makeValidator().evaluate(plan);
  assert.equal(result.decision, "DENY");
  assert.ok(result.findings.some((finding) => finding.code === "AGENT_NOT_REGISTERED"));
});

test("缺少可信证据、证据过期或来自未来时拒绝计划", () => {
  const validator = makeValidator();
  const plan = makePlan({ steps: [makePlan().steps[0]] });

  assert.equal(validator.evaluate(plan).decision, "DENY");
  assert.ok(validator.evaluate(plan).findings.some((finding) => finding.code === "EVIDENCE_NOT_FOUND"));

  const stale = trustedOccupancyEvidence({ observed_at: new Date(NOW - 120_000).toISOString() });
  assert.ok(validator.evaluate(plan, { evidence: [stale] }).findings.some((finding) => finding.code === "EVIDENCE_STALE"));

  const future = trustedOccupancyEvidence({ observed_at: new Date(NOW + 120_000).toISOString() });
  assert.ok(validator.evaluate(plan, { evidence: [future] }).findings.some((finding) => finding.code === "EVIDENCE_FROM_FUTURE"));

  const untrusted = trustedOccupancyEvidence({ trust_level: "model_claimed" });
  assert.ok(validator.evaluate(plan, { evidence: [untrusted] }).findings.some((finding) => finding.code === "EVIDENCE_NOT_TRUSTED"));
});

test("未预先授权的设备动作需要确认，且确认必须绑定同一份计划", () => {
  const validator = makeValidator({ autoAllowedDeviceActions: [] });
  const plan = makePlan();
  const pending = validator.evaluate(plan, { evidence: [trustedOccupancyEvidence()] });
  assert.equal(pending.decision, "NEED_CONFIRMATION");
  assert.ok(pending.findings.some((finding) => finding.code === "USER_CONFIRMATION_REQUIRED"));

  const approved = validator.evaluate(plan, {
    evidence: [trustedOccupancyEvidence()],
    approval: { plan_id: plan.plan_id, plan_fingerprint: fingerprintAgentPlan(plan), approved: true },
  });
  assert.equal(approved.decision, "ALLOW");

  const changedPlan = { ...plan, goal: "把学习灯打开" };
  const staleApproval = validator.evaluate(changedPlan, {
    evidence: [trustedOccupancyEvidence()],
    approval: { plan_id: plan.plan_id, plan_fingerprint: fingerprintAgentPlan(plan), approved: true },
  });
  assert.equal(staleApproval.decision, "NEED_CONFIRMATION");
});

test("家庭策略硬禁止的动作不能靠确认放行", () => {
  const validator = makeValidator({
    autoAllowedDeviceActions: [{ device_id: "lock.front_door", action: "unlock" }],
    blockedActions: ["unlock"],
  });
  const plan = makePlan({ steps: [{
    step_id: "unlock-door",
    agent_id: "device-manager",
    capability: "execute_device_action",
    depends_on: [],
    evidence_refs: [],
    action: { name: "unlock", target_ref: { device_id: "lock.front_door" }, parameters: {} },
  }] });
  const result = validator.evaluate(plan, {
    approval: { plan_id: plan.plan_id, plan_fingerprint: fingerprintAgentPlan(plan), approved: true },
  });
  assert.equal(result.decision, "DENY");
  assert.ok(result.findings.some((finding) => finding.code === "ACTION_BLOCKED_BY_POLICY"));
});

test("不在家庭设备或动作允许清单中的计划会被拒绝", () => {
  const validator = makeValidator();
  const base = makePlan().steps[2];
  const unknownDevicePlan = makePlan({ steps: [{
    ...base,
    action: { ...base.action, target_ref: { device_id: "switch.garage_door" } },
  }] });
  assert.ok(validator.evaluate(unknownDevicePlan).findings.some((finding) => finding.code === "DEVICE_NOT_ALLOWLISTED"));

  const unknownActionPlan = makePlan({ steps: [{
    ...base,
    action: { ...base.action, name: "factory_reset" },
  }] });
  assert.ok(validator.evaluate(unknownActionPlan).findings.some((finding) => finding.code === "ACTION_NOT_ALLOWLISTED"));
});

test("能力级自动执行白名单可收窄家庭级白名单", () => {
  const validator = new AgentPlanValidator({
    agents: [{
      agent_id: "device-manager",
      capabilities: {
        execute_device_action: {
          effect: "device_action",
          auto_allowed_device_actions: [{ device_id: "light.study", action: "turn_off" }],
        },
      },
    }],
    householdPolicy: {
      allowedDeviceIds: ["light.study"],
      allowedActions: ["turn_on", "turn_off"],
      autoAllowedDeviceActions: [
        { device_id: "light.study", action: "turn_on" },
        { device_id: "light.study", action: "turn_off" },
      ],
    },
  });
  const baseStep = {
    agent_id: "device-manager",
    capability: "execute_device_action",
    depends_on: [],
    evidence_refs: [],
  };
  const turnOn = makePlan({ steps: [{
    ...baseStep,
    step_id: "turn-on",
    action: { name: "turn_on", target_ref: { device_id: "light.study" }, parameters: {} },
  }] });
  const turnOff = makePlan({ steps: [{
    ...baseStep,
    step_id: "turn-off",
    action: { name: "turn_off", target_ref: { device_id: "light.study" }, parameters: {} },
  }] });

  assert.equal(validator.evaluate(turnOn).decision, "NEED_CONFIRMATION");
  assert.equal(validator.evaluate(turnOff).decision, "ALLOW");
});

test("未声明依赖顺序的同设备互斥动作触发确认；声明顺序后可进入校验", () => {
  const validator = makeValidator({ autoAllowedDeviceActions: [
    { device_id: "light.study", action: "turn_on" },
    { device_id: "light.study", action: "turn_off" },
  ] });
  const base = makePlan().steps[2];
  const first = { ...base, step_id: "turn-on", depends_on: [], action: { ...base.action, name: "turn_on" } };
  const second = { ...base, step_id: "turn-off", depends_on: [], action: { ...base.action, name: "turn_off" } };
  const conflictingPlan = makePlan({ steps: [first, second] });
  const evidence = [trustedOccupancyEvidence()];
  const conflict = validator.evaluate(conflictingPlan, { evidence });
  assert.equal(conflict.decision, "NEED_CONFIRMATION");
  assert.ok(conflict.findings.some((finding) => finding.code === "PLAN_RESOURCE_CONFLICT"));

  const orderedPlan = makePlan({ steps: [first, { ...second, depends_on: ["turn-on"] }] });
  const ordered = validator.evaluate(orderedPlan, { evidence });
  assert.equal(ordered.decision, "ALLOW");
});

test("循环依赖、缺失依赖和超长计划均被拒绝", () => {
  const validator = makeValidator();
  const cyclic = makePlan({ steps: [
    { step_id: "a", agent_id: "energy-saving", capability: "plan_energy_action", depends_on: ["b"], evidence_refs: [] },
    { step_id: "b", agent_id: "energy-saving", capability: "plan_energy_action", depends_on: ["a"], evidence_refs: [] },
  ] });
  assert.ok(validator.evaluate(cyclic).findings.some((finding) => finding.code === "PLAN_DEPENDENCY_CYCLE"));

  const missingDependency = makePlan({ steps: [{
    step_id: "a",
    agent_id: "energy-saving",
    capability: "plan_energy_action",
    depends_on: ["missing"],
    evidence_refs: [],
  }] });
  assert.ok(validator.evaluate(missingDependency).findings.some((finding) => finding.code === "INVALID_PLAN_GRAPH"));

  const tooLong = makePlan({ steps: Array.from({ length: 13 }, (_, index) => ({
    step_id: `s${index}`,
    agent_id: "energy-saving",
    capability: "plan_energy_action",
    depends_on: [],
    evidence_refs: [],
  })) });
  assert.ok(validator.evaluate(tooLong).findings.some((finding) => finding.code === "INVALID_PLAN"));
});

test("只在计划 ALLOW 后按 DAG 顺序调用登记的能力处理器", async () => {
  const validator = makeValidator();
  const calls = [];
  const executor = new AgentPlanExecutor({
    validator,
    handlers: {
      "device-manager::read_occupancy": async ({ step_id, evidence }) => {
        calls.push(step_id);
        assert.equal(evidence[0].evidence_id, "occupancy-study");
        return { result: { occupied: false } };
      },
      "energy-saving::plan_energy_action": async ({ step_id, dependency_results }) => {
        calls.push(step_id);
        assert.deepEqual(dependency_results["check-occupancy"], { occupied: false });
        return { result: { action: "turn_off" } };
      },
      "device-manager::execute_device_action": async ({ step_id, action, dependency_results }) => {
        calls.push(step_id);
        assert.equal(action.name, "turn_off");
        assert.deepEqual(dependency_results["plan-energy-action"], { action: "turn_off" });
        return { result: { backend: "mock", state: "off" } };
      },
    },
  });

  const result = await executor.execute(makePlan(), { evidence: [trustedOccupancyEvidence()] });
  assert.equal(result.decision, "ALLOW");
  assert.equal(result.execution_status, "SUCCEEDED");
  assert.equal(result.execution_performed, true);
  assert.deepEqual(calls, ["check-occupancy", "plan-energy-action", "turn-off-study-light"]);
  assert.equal(result.steps[2].result.state, "off");
});

test("计划需要确认或被拒绝时完全不调用能力处理器", async () => {
  const validator = makeValidator({ autoAllowedDeviceActions: [] });
  let calls = 0;
  const executor = new AgentPlanExecutor({
    validator,
    handlers: { "device-manager::execute_device_action": async () => { calls += 1; } },
  });
  const actionPlan = makePlan({ steps: [{ ...makePlan().steps[2], depends_on: [] }] });

  const result = await executor.execute(actionPlan, { evidence: [trustedOccupancyEvidence()] });
  assert.equal(result.decision, "NEED_CONFIRMATION");
  assert.equal(result.execution_status, "NEED_CONFIRMATION");
  assert.equal(result.execution_performed, false);
  assert.equal(calls, 0);
});

test("步骤失败后停止整份计划，不继续执行后续设备动作或独立步骤", async () => {
  const validator = makeValidator();
  const plan = makePlan({ steps: [
    {
      step_id: "failing-plan",
      agent_id: "energy-saving",
      capability: "plan_energy_action",
      depends_on: [],
      evidence_refs: [],
    },
    {
      step_id: "device-action",
      agent_id: "device-manager",
      capability: "execute_device_action",
      depends_on: ["failing-plan"],
      evidence_refs: [],
      action: { name: "turn_off", target_ref: { device_id: "light.study" }, parameters: {} },
    },
    {
      step_id: "independent-read",
      agent_id: "device-manager",
      capability: "read_occupancy",
      depends_on: [],
      evidence_refs: ["occupancy-study"],
    },
  ] });
  const calls = [];
  const executor = new AgentPlanExecutor({
    validator,
    handlers: {
      "energy-saving::plan_energy_action": async () => {
        calls.push("failing-plan");
        throw new Error("模拟能源管家故障");
      },
      "device-manager::execute_device_action": async () => {
        calls.push("device-action");
        return { result: { state: "off" } };
      },
      "device-manager::read_occupancy": async () => {
        calls.push("independent-read");
        return { result: { occupied: false } };
      },
    },
  });

  const result = await executor.execute(plan, { evidence: [trustedOccupancyEvidence()] });
  assert.equal(result.decision, "ALLOW");
  assert.equal(result.execution_status, "FAILED");
  assert.deepEqual(calls, ["failing-plan"]);
  assert.equal(result.steps.find((step) => step.step_id === "device-action").status, "SKIPPED_AFTER_STEP_FAILURE");
  assert.equal(result.steps.find((step) => step.step_id === "independent-read").status, "SKIPPED_AFTER_STEP_FAILURE");
});

test("计划引用了通过校验但没有执行器的能力时记录失败，不伪装成功", async () => {
  const executor = new AgentPlanExecutor({ validator: makeValidator(), handlers: {} });
  const plan = makePlan({ steps: [{
    step_id: "energy-plan",
    agent_id: "energy-saving",
    capability: "plan_energy_action",
    depends_on: [],
    evidence_refs: [],
  }] });
  const result = await executor.execute(plan);
  assert.equal(result.decision, "ALLOW");
  assert.equal(result.execution_status, "FAILED");
  assert.equal(result.steps[0].error.code, "CAPABILITY_HANDLER_UNAVAILABLE");
});
