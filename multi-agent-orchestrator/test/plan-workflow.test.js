import test from "node:test";
import assert from "node:assert/strict";
import { AgentPlanValidator } from "../src/plan-validator.js";
import { AgentPlanExecutor } from "../src/plan-executor.js";
import { AgentPlanWorkflow } from "../src/plan-workflow.js";

const NOW = Date.parse("2026-10-09T10:00:00.000Z");

function makeActionPlan(overrides = {}) {
  return {
    schema_version: "0.1",
    plan_id: "plan-turn-off-study-light",
    trace_id: "trace-turn-off-study-light",
    goal: "关闭学习灯",
    steps: [{
      step_id: "turn-off",
      agent_id: "device-manager",
      capability: "execute_device_action",
      depends_on: [],
      evidence_refs: [],
      action: { name: "turn_off", target_ref: { device_id: "light.study" }, parameters: {} },
    }],
    ...overrides,
  };
}

function buildWorkflow({
  now = () => NOW,
  approvalTtlMs = 60_000,
  autoAllowedDeviceActions = [],
  authorizeActor = async () => true,
  evidenceProvider = async () => [],
  handlers = { "device-manager::execute_device_action": async () => ({ result: { mock: true, state: "off" } }) },
  requiredEvidence = false,
} = {}) {
  const validator = new AgentPlanValidator({
    clock: now,
    agents: [{
      agent_id: "device-manager",
      capabilities: {
        read_occupancy: {
          effect: "read_only",
          ...(requiredEvidence ? { required_evidence: [{
            evidence_type: "occupancy",
            trusted: true,
            allowed_sources: ["home_assistant"],
            max_age_ms: 60_000,
          }] } : {}),
        },
        execute_device_action: { effect: "device_action" },
      },
    }],
    householdPolicy: {
      allowedDeviceIds: ["light.study"],
      allowedActions: ["turn_on", "turn_off"],
      autoAllowedDeviceActions,
    },
  });
  const executor = new AgentPlanExecutor({ validator, handlers });
  const workflow = new AgentPlanWorkflow({
    validator,
    executor,
    authorizeActor,
    evidenceProvider,
    clock: now,
    approvalTtlMs,
  });
  return { workflow, validator, executor };
}

function trustedEvidence() {
  return {
    evidence_id: "occupancy-study",
    evidence_type: "occupancy",
    trust_level: "trusted",
    source_type: "home_assistant",
    observed_at: new Date(NOW - 1_000).toISOString(),
  };
}

test("需要确认的计划会挂起展示，等待期间不调用 Agent handler", async () => {
  let calls = 0;
  const { workflow } = buildWorkflow({
    handlers: { "device-manager::execute_device_action": async () => { calls += 1; return { result: {} }; } },
  });
  const result = await workflow.submit(makeActionPlan());

  assert.equal(result.decision, "NEED_CONFIRMATION");
  assert.equal(result.workflow_status, "WAITING_FOR_APPROVAL");
  assert.equal(result.execution_performed, false);
  assert.equal(calls, 0);
  assert.equal(workflow.listPending().length, 1);
  assert.equal(result.approval.steps[0].action.name, "turn_off");
  assert.equal("parameters" in result.approval.steps[0].action, false);
});

test("经过授权的人确认后先刷新证据，再对同一计划重新校验并只执行一次", async () => {
  let calls = 0;
  let evidenceRefreshes = 0;
  const { workflow } = buildWorkflow({
    evidenceProvider: async ({ phase }) => {
      assert.equal(phase, "approval");
      evidenceRefreshes += 1;
      return [];
    },
    handlers: { "device-manager::execute_device_action": async ({ action }) => {
      calls += 1;
      return { result: { action: action.name, state: "off" } };
    } },
  });
  const pending = await workflow.submit(makeActionPlan());
  const result = await workflow.approve(pending.approval.approval_id, { actor: { id: "parent-1" } });
  const repeated = await workflow.approve(pending.approval.approval_id, { actor: { id: "parent-1" } });

  assert.equal(result.workflow_status, "COMPLETED");
  assert.equal(result.decision, "ALLOW");
  assert.equal(result.steps[0].result.state, "off");
  assert.equal(evidenceRefreshes, 1);
  assert.equal(calls, 1);
  assert.deepEqual(repeated, result);
  assert.equal(workflow.getApproval(pending.approval.approval_id).workflow_status, "COMPLETED");
});

test("授权服务拒绝时不执行，并且待确认项仍可由有权限的人处理", async () => {
  let calls = 0;
  const { workflow } = buildWorkflow({
    authorizeActor: async ({ actor }) => actor.id === "parent-1",
    handlers: { "device-manager::execute_device_action": async () => { calls += 1; return { result: {} }; } },
  });
  const pending = await workflow.submit(makeActionPlan());
  const denied = await workflow.approve(pending.approval.approval_id, { actor: { id: "visitor-1" } });
  assert.equal(denied.workflow_status, "AUTHORIZATION_DENIED");
  assert.equal(workflow.getApproval(pending.approval.approval_id).workflow_status, "WAITING_FOR_APPROVAL");
  assert.equal(calls, 0);

  const approved = await workflow.approve(pending.approval.approval_id, { actor: { id: "parent-1" } });
  assert.equal(approved.workflow_status, "COMPLETED");
  assert.equal(calls, 1);
});

test("人工拒绝终止计划，且绝不刷新证据或调用 Agent", async () => {
  let calls = 0;
  let refreshes = 0;
  const { workflow } = buildWorkflow({
    evidenceProvider: async () => { refreshes += 1; return []; },
    handlers: { "device-manager::execute_device_action": async () => { calls += 1; return { result: {} }; } },
  });
  const pending = await workflow.submit(makeActionPlan());
  const result = await workflow.reject(pending.approval.approval_id, { actor: { id: "parent-1" } });
  assert.equal(result.workflow_status, "REJECTED");
  assert.equal(result.execution_performed, false);
  assert.equal(refreshes, 0);
  assert.equal(calls, 0);
});

test("无人响应到期后安全结束，不自动执行动作", async () => {
  let now = NOW;
  let authCalls = 0;
  let actionCalls = 0;
  const { workflow } = buildWorkflow({
    now: () => now,
    approvalTtlMs: 1_000,
    authorizeActor: async () => { authCalls += 1; return true; },
    handlers: { "device-manager::execute_device_action": async () => { actionCalls += 1; return { result: {} }; } },
  });
  const pending = await workflow.submit(makeActionPlan());
  now += 1_000;
  assert.deepEqual(workflow.sweepExpired(), { expired: 1 });
  const result = await workflow.approve(pending.approval.approval_id, { actor: { id: "parent-1" } });

  assert.equal(result.workflow_status, "EXPIRED_NO_ACTION");
  assert.equal(result.execution_performed, false);
  assert.equal(authCalls, 0);
  assert.equal(actionCalls, 0);
  assert.equal(workflow.listPending().length, 0);
});

test("确认期间重新校验证据，证据变得无效时拒绝执行", async () => {
  let actionCalls = 0;
  const { workflow } = buildWorkflow({
    requiredEvidence: true,
    evidenceProvider: async () => [],
    handlers: {
      "device-manager::read_occupancy": async () => ({ result: { occupied: false } }),
      "device-manager::execute_device_action": async () => { actionCalls += 1; return { result: {} }; },
    },
  });
  const plan = makeActionPlan({
    steps: [
      {
        step_id: "read-occupancy",
        agent_id: "device-manager",
        capability: "read_occupancy",
        depends_on: [],
        evidence_refs: ["occupancy-study"],
      },
      {
        ...makeActionPlan().steps[0],
        depends_on: ["read-occupancy"],
      },
    ],
  });
  const pending = await workflow.submit(plan, { evidence: [trustedEvidence()] });
  assert.equal(pending.workflow_status, "WAITING_FOR_APPROVAL");
  const result = await workflow.approve(pending.approval.approval_id, { actor: { id: "parent-1" } });

  assert.equal(result.workflow_status, "DENIED_AFTER_RECHECK");
  assert.equal(result.decision, "DENY");
  assert.equal(actionCalls, 0);
});

test("人确认不能消除计划内部的设备动作冲突，要求修改计划而不是执行", async () => {
  let calls = 0;
  const autoAllowedDeviceActions = [
    { device_id: "light.study", action: "turn_on" },
    { device_id: "light.study", action: "turn_off" },
  ];
  const { workflow } = buildWorkflow({
    autoAllowedDeviceActions,
    handlers: { "device-manager::execute_device_action": async () => { calls += 1; return { result: {} }; } },
  });
  const plan = makeActionPlan({ steps: [
    { ...makeActionPlan().steps[0], step_id: "turn-on", action: { name: "turn_on", target_ref: { device_id: "light.study" }, parameters: {} } },
    { ...makeActionPlan().steps[0], step_id: "turn-off", action: { name: "turn_off", target_ref: { device_id: "light.study" }, parameters: {} } },
  ] });
  const result = await workflow.submit(plan);

  assert.equal(result.workflow_status, "CLARIFICATION_REQUIRED");
  assert.equal(result.clarification.reason, "RESOURCE_CONFLICT");
  assert.equal(result.execution_performed, false);
  assert.equal(workflow.listPending().length, 0);
  assert.equal(calls, 0);
});

test("自动授权范围内的低风险计划不排队，可由执行器直接处理", async () => {
  let calls = 0;
  const { workflow } = buildWorkflow({
    autoAllowedDeviceActions: [{ device_id: "light.study", action: "turn_off" }],
    handlers: { "device-manager::execute_device_action": async () => { calls += 1; return { result: { mock: true } }; } },
  });
  const result = await workflow.submit(makeActionPlan());
  assert.equal(result.workflow_status, "COMPLETED");
  assert.equal(result.decision, "ALLOW");
  assert.equal(calls, 1);
  assert.equal(workflow.listPending().length, 0);
});

test("待确认计划被快照保存，提交后调用方改动原对象不会改变批准内容", async () => {
  let executedAction;
  const { workflow } = buildWorkflow({
    evidenceProvider: async () => [],
    handlers: { "device-manager::execute_device_action": async ({ action }) => {
      executedAction = action.name;
      return { result: {} };
    } },
  });
  const plan = makeActionPlan();
  const pending = await workflow.submit(plan);
  plan.goal = "改成开灯";
  plan.steps[0].action.name = "turn_on";
  const result = await workflow.approve(pending.approval.approval_id, { actor: { id: "parent-1" } });

  assert.equal(result.plan_fingerprint, pending.plan_fingerprint);
  assert.equal(executedAction, "turn_off");
});

test("并发重复点击确认不会重复执行", async () => {
  let releaseAuthorization;
  let actionCalls = 0;
  const { workflow } = buildWorkflow({
    authorizeActor: () => new Promise((resolve) => { releaseAuthorization = resolve; }),
    handlers: { "device-manager::execute_device_action": async () => { actionCalls += 1; return { result: {} }; } },
  });
  const pending = await workflow.submit(makeActionPlan());
  const first = workflow.approve(pending.approval.approval_id, { actor: { id: "parent-1" } });
  const second = await workflow.approve(pending.approval.approval_id, { actor: { id: "parent-1" } });
  assert.equal(second.workflow_status, "APPROVAL_IN_PROGRESS");
  releaseAuthorization(true);
  const firstResult = await first;
  assert.equal(firstResult.workflow_status, "COMPLETED");
  assert.equal(actionCalls, 1);
});
