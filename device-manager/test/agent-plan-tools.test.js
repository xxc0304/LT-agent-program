import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { Check } from "typebox/value";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnergySavingAgent } from "../../energy-saving/src/energy-agent.js";
import { MockHomeAssistant } from "../src/mock-ha.js";
import { AGENT_PLAN_TOOL_DEFINITIONS, createAgentPlanTools } from "../src/agent-plan-tools.js";
import { AgentApprovalStateStore } from "../src/agent-approval-state-store.js";
import {
  createEd25519LockAuthorizationVerifier,
  createHttpLockAuthorizationProvider,
} from "../src/lock-authorization.js";
import { createDeviceTaskRuntime } from "../src/task-runtime.js";
import { createDeviceToolRuntime } from "../src/tools.js";

function fixture(options = {}) {
  const { devices, lockAuthorizationVerifier, ...toolOptions } = options;
  const homeAssistant = new MockHomeAssistant({ devices, lockAuthorizationVerifier });
  const baseRuntime = createDeviceToolRuntime(homeAssistant);
  const deviceRuntime = toolOptions.deviceRuntime ?? baseRuntime;
  const energyAgent = new EnergySavingAgent({
    deviceClient: { listDevices: () => deviceRuntime.invoke("list_devices", {}) },
  });
  const tools = createAgentPlanTools({
    deviceRuntime,
    deviceTaskRuntime: createDeviceTaskRuntime(deviceRuntime),
    energyAgent,
    ...toolOptions,
  });
  return { homeAssistant, runtime: baseRuntime, tools };
}

function candidatePlan(actions) {
  return {
    schema_version: "0.1",
    plan_id: "candidate-plan-1",
    trace_id: "trace-candidate-plan-1",
    goal: "候选多 Agent 家庭任务",
    steps: actions.map((action, index) => ({
      step_id: `action-${index + 1}`,
      agent_id: "device-manager",
      capability: "execute_device_action",
      depends_on: [],
      evidence_refs: [],
      input: {},
      action: {
        name: action.name,
        target_ref: { device_id: action.device_id },
        parameters: action.parameters ?? {},
      },
    })),
  };
}

test("submit_agent_plan 的工具 schema 明确限制计划、步骤和设备动作结构", () => {
  const schema = AGENT_PLAN_TOOL_DEFINITIONS.find(({ name }) => name === "submit_agent_plan").inputSchema;
  const completePlan = candidatePlan([{ device_id: "light.living_room", name: "turn_off" }]);
  const modelPlan = {
    ...completePlan,
    steps: completePlan.steps.map(({ evidence_refs, ...step }) => step),
  };

  assert.equal(Check(schema, { plan: modelPlan }), true);
  assert.equal(Check(schema, { plan: { ...modelPlan, steps: [] } }), false);
  assert.equal(Check(schema, {
    plan: {
      ...modelPlan,
      steps: [{ ...modelPlan.steps[0], name: "turn_off" }],
    },
  }), false, "动作不能放在 step 顶层");
  assert.equal(Check(schema, {
    plan: {
      ...modelPlan,
      steps: [{
        ...modelPlan.steps[0],
        action: { name: "turn_off", target_ref: {}, parameters: {} },
      }],
    },
  }), false, "设备动作必须指向 device_id");
  assert.equal(Check(schema, {
    plan: {
      ...modelPlan,
      steps: [{ ...modelPlan.steps[0], evidence_refs: ["model-invented-evidence"] }],
    },
  }), false, "模型不能提交自造的证据 ID");
  assert.equal(Check(schema, {
    plan: {
      ...modelPlan,
      steps: Array.from({ length: 13 }, (_, index) => ({
        ...modelPlan.steps[0],
        step_id: `step-${index + 1}`,
      })),
    },
  }), false, "计划最多 12 步");
});

test("明确的单设备普通操作默认免二次确认，并通过设备回读", async () => {
  const cases = [
    { device_id: "light.living_room", action: "turn_on", expected: (device) => device.state === "on" },
    { device_id: "switch.living_room_plug", action: "turn_on", expected: (device) => device.state === "on" },
    { device_id: "climate.bedroom", action: "set_temperature", parameters: { temperature: 22 }, expected: (device) => device.attributes.temperature === 22 },
    { device_id: "cover.living_room_curtain", action: "open", expected: (device) => device.state === "open" },
  ];

  for (const item of cases) {
    const { homeAssistant, tools } = fixture();
    const result = await tools.requestDeviceAction(item);
    assert.equal(result.workflow_status, "COMPLETED", item.device_id);
    assert.equal(result.execution_performed, true, item.device_id);
    assert.equal(item.expected(homeAssistant.getState({ device_id: item.device_id }).device), true, item.device_id);
    assert.equal(homeAssistant.getAuditLog().at(-1).verified, true, item.device_id);
  }
});

test("门锁动作先要求聊天批准；拒绝时不执行", async () => {
  const { homeAssistant, tools } = fixture();
  const cases = [
    { device_id: "lock.front_door", action: "lock", state: "locked" },
    { device_id: "lock.front_door", action: "unlock", state: "locked" },
  ];

  for (const item of cases) {
    const before = homeAssistant.getState({ device_id: item.device_id }).device;
    const result = await tools.requestDeviceAction({ ...item, confirmed: true });
    assert.equal(result.workflow_status, "WAITING_FOR_APPROVAL", item.device_id);
    assert.equal(result.execution_performed, false, item.device_id);
    assert.deepEqual(homeAssistant.getState({ device_id: item.device_id }).device, before);
    assert.equal(before.state, item.state);
    const resolved = await tools.resolveApproval({
      approval_id: result.approval.approval_id,
      decision: "reject",
    });
    assert.equal(resolved.workflow_status, "REJECTED", item.device_id);
  }

  assert.equal(homeAssistant.getAuditLog().length, 0);
});

test("缺少可信认证服务时，聊天批准仍不能解锁", async () => {
  const { homeAssistant, tools } = fixture();
  const before = homeAssistant.getState({ device_id: "lock.front_door" }).device;
  const pending = await tools.requestDeviceAction({ device_id: "lock.front_door", action: "unlock" });
  assert.equal(pending.workflow_status, "WAITING_FOR_APPROVAL");

  const result = await tools.resolveApproval({
    approval_id: pending.approval.approval_id,
    decision: "approve",
  });

  assert.equal(result.workflow_status, "TRUSTED_AUTHENTICATION_REQUIRED");
  assert.equal(result.execution_performed, false);
  assert.deepEqual(homeAssistant.getState({ device_id: "lock.front_door" }).device, before);
  assert.equal(homeAssistant.getAuditLog().length, 0);
});

test("可信认证凭据只在服务端链路中传递并绑定当前审批与计划", async () => {
  let requestedContext;
  let verifierInput;
  const { homeAssistant, tools } = fixture({
    lockAuthorizationVerifier: {
      verifyLockAuthorization(input) {
        verifierInput = input;
        return input.proof === "opaque-test-proof"
          ? { success: true, subject: "test-household-user" }
          : { success: false, error: { code: "LOCK_AUTHORIZATION_INVALID", message: "invalid" } };
      },
    },
    lockAuthorizationProvider: async (context) => {
      requestedContext = context;
      return "opaque-test-proof";
    },
  });
  const pending = await tools.requestDeviceAction({ device_id: "lock.front_door", action: "unlock" });
  const result = await tools.resolveApproval({
    approval_id: pending.approval.approval_id,
    decision: "approve",
  });

  assert.equal(result.workflow_status, "COMPLETED");
  assert.equal(homeAssistant.getState({ device_id: "lock.front_door" }).device.state, "unlocked");
  assert.equal(requestedContext.approval_id, pending.approval.approval_id);
  assert.equal(requestedContext.plan_id, pending.approval.plan_id);
  assert.equal(requestedContext.device_id, "lock.front_door");
  assert.equal(requestedContext.action, "unlock");
  assert.equal(verifierInput.proof, "opaque-test-proof");
  assert.deepEqual(verifierInput.expected, {
    ...requestedContext,
    device_id: "lock.front_door",
    action: "unlock",
  });
  assert.equal(JSON.stringify(homeAssistant.getAuditLog()).includes("opaque-test-proof"), false);
});

test("本机假认证服务的有效授权可完成 Mock 开锁，错绑授权在设备写入前被拒绝", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const issuer = "local-test-lock-auth";
  const audience = "lt-agent-device-manager";
  let mismatchDevice = false;
  let requestedPayload;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requestedPayload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const claims = {
      iss: issuer,
      aud: audience,
      sub: "local-test-user",
      jti: randomUUID(),
      iat: nowSeconds,
      exp: nowSeconds + 45,
      ...requestedPayload,
      ...(mismatchDevice ? { device_id: "lock.back_door" } : {}),
    };
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signedContent = `${header}.${payload}`;
    const proof = `${signedContent}.${sign(null, Buffer.from(signedContent), privateKey).toString("base64url")}`;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ proof }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const provider = createHttpLockAuthorizationProvider({
      url: `http://127.0.0.1:${address.port}/authorize`,
    });
    const lockAuthorizationVerifier = createEd25519LockAuthorizationVerifier({ publicKey: publicKeyPem, issuer, audience });
    const first = fixture({ lockAuthorizationProvider: provider, lockAuthorizationVerifier });
    const pending = await first.tools.requestDeviceAction({ device_id: "lock.front_door", action: "unlock" });
    const completed = await first.tools.resolveApproval({
      approval_id: pending.approval.approval_id,
      decision: "approve",
    });

    assert.equal(completed.workflow_status, "COMPLETED");
    assert.equal(first.homeAssistant.getState({ device_id: "lock.front_door" }).device.state, "unlocked");
    assert.equal(requestedPayload.approval_id, pending.approval.approval_id);
    assert.equal(requestedPayload.plan_id, pending.approval.plan_id);
    assert.equal(requestedPayload.device_id, "lock.front_door");
    assert.equal(requestedPayload.action, "unlock");
    assert.equal(Object.hasOwn(requestedPayload, "pin"), false);
    assert.equal(JSON.stringify(completed).includes("proof"), false);

    mismatchDevice = true;
    const second = fixture({ lockAuthorizationProvider: provider, lockAuthorizationVerifier });
    const secondPending = await second.tools.requestDeviceAction({ device_id: "lock.front_door", action: "unlock" });
    const rejected = await second.tools.resolveApproval({
      approval_id: secondPending.approval.approval_id,
      decision: "approve",
    });

    assert.equal(rejected.workflow_status, "EXECUTION_FAILED");
    assert.equal(second.homeAssistant.getState({ device_id: "lock.front_door" }).device.state, "locked");
    assert.equal(second.homeAssistant.getAuditLog().length, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("显式标记为高风险的非门锁设备仍要求确认", async () => {
  const sourceDevices = new MockHomeAssistant().listDevices().devices;
  const devices = sourceDevices.map((device) => device.device_id === "switch.living_room_plug"
    ? { ...device, attributes: { ...device.attributes, risk_level: "high" } }
    : device);
  const { homeAssistant, tools } = fixture({ devices });

  const result = await tools.requestDeviceAction({
    device_id: "switch.living_room_plug",
    action: "turn_on",
    confirmed: true,
  });

  assert.equal(result.workflow_status, "WAITING_FOR_APPROVAL");
  assert.equal(result.execution_performed, false);
  assert.equal(homeAssistant.getState({ device_id: "switch.living_room_plug" }).device.state, "off");
});

test("候选计划中同设备互斥动作要求先澄清，不建立可批准项", async () => {
  const { homeAssistant, tools } = fixture();
  const result = await tools.submitAgentPlan({
    plan: candidatePlan([
      { device_id: "light.living_room", name: "turn_on" },
      { device_id: "light.living_room", name: "turn_off" },
    ]),
  });

  assert.equal(result.workflow_status, "CLARIFICATION_REQUIRED");
  assert.equal(result.clarification.reason, "RESOURCE_CONFLICT");
  assert.equal(result.execution_performed, false);
  assert.equal(result.approval, undefined);
  assert.match(result.clarification.user_question, /客厅灯/);
  assert.deepEqual(result.clarification.conflicts[0].actions.map(({ action }) => action), ["turn_on", "turn_off"]);
  assert.equal(result.clarification.approval_allowed, false);
  assert.equal(homeAssistant.getAuditLog().length, 0);
});

test("用户澄清后提交新计划会重新校验、再次确认，并仅执行新计划", async () => {
  const { homeAssistant, tools } = fixture();
  const conflict = await tools.invokeTool("submit_agent_plan", {
    plan: candidatePlan([
      { device_id: "light.living_room", name: "turn_on" },
      { device_id: "light.living_room", name: "turn_off" },
    ]),
  });
  assert.equal(conflict.workflow_status, "CLARIFICATION_REQUIRED");
  assert.equal(conflict.execution_performed, false);
  assert.equal(homeAssistant.getAuditLog().length, 0);

  // This is the plan an OpenClaw planner would submit after the user selects
  // “只留关灯”; it is a fresh plan with its own identity and validation pass.
  const revisedPlan = {
    ...candidatePlan([{ device_id: "light.living_room", name: "turn_off" }]),
    plan_id: "candidate-plan-revised",
    trace_id: "trace-candidate-plan-revised",
    goal: "按用户澄清仅关闭客厅灯",
  };
  const pending = await tools.invokeTool("submit_agent_plan", { plan: revisedPlan });
  assert.equal(pending.workflow_status, "WAITING_FOR_APPROVAL");
  assert.equal(pending.execution_performed, false);
  assert.equal(homeAssistant.getState({ device_id: "light.living_room" }).device.state, "off");
  assert.equal(homeAssistant.getAuditLog().length, 0);

  const executed = await tools.invokeTool("resolve_agent_action_confirmation", {
    approval_id: pending.approval.approval_id,
    decision: "approve",
  });
  assert.equal(executed.workflow_status, "COMPLETED");
  assert.equal(homeAssistant.getState({ device_id: "light.living_room" }).device.state, "off");
  assert.equal(homeAssistant.getAuditLog().length, 1);
  assert.equal(homeAssistant.getAuditLog()[0].action, "turn_off");
  assert.equal(homeAssistant.getAuditLog()[0].verified, true);
});

test("设备执行完成但调用方重试相同计划时，在原 TTL 内返回完成结果而不重复动作", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lt-agent-approval-complete-dedup-"));
  try {
    const filePath = join(directory, "approval-state.json");
    const store = new AgentApprovalStateStore({ filePath });
    const first = fixture({ approvalStateStore: store });
    const { homeAssistant, tools } = first;
    const plan = candidatePlan([{ device_id: "light.living_room", name: "turn_on" }]);
    const pending = await tools.submitAgentPlan({ plan });
    const completed = await tools.resolveApproval({ approval_id: pending.approval.approval_id, decision: "approve" });
    assert.equal(completed.workflow_status, "COMPLETED");
    assert.equal(homeAssistant.getAuditLog().length, 1);

    const duplicate = await tools.submitAgentPlan({ plan: structuredClone(plan) });
    assert.equal(duplicate.workflow_status, "COMPLETED");
    assert.equal(duplicate.idempotency.deduplicated, true);
    assert.equal(homeAssistant.getAuditLog().length, 1);

    const restartedStore = new AgentApprovalStateStore({ filePath });
    const restarted = fixture({ deviceRuntime: first.runtime, approvalStateStore: restartedStore });
    const afterRestart = await restarted.tools.submitAgentPlan({ plan: structuredClone(plan) });
    assert.equal(afterRestart.workflow_status, "COMPLETED");
    assert.equal(afterRestart.idempotency.deduplicated, true);
    assert.equal(homeAssistant.getAuditLog().length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("由 OpenClaw/LLM 提交的单灯候选计划也需要确认，不能套用直接口令的快捷白名单", async () => {
  const { homeAssistant, tools } = fixture();
  const result = await tools.submitAgentPlan({
    plan: candidatePlan([{ device_id: "light.living_room", name: "turn_on" }]),
  });

  assert.equal(result.workflow_status, "WAITING_FOR_APPROVAL");
  assert.equal(result.execution_performed, false);
  assert.equal(homeAssistant.getState({ device_id: "light.living_room" }).device.state, "off");
  await tools.resolveApproval({ approval_id: result.approval.approval_id, decision: "reject" });
  assert.equal(homeAssistant.getState({ device_id: "light.living_room" }).device.state, "off");
});

test("相同 plan_id 和相同计划重复提交时复用原待确认项", async () => {
  const { homeAssistant, tools } = fixture();
  const plan = candidatePlan([{ device_id: "light.living_room", name: "turn_on" }]);

  const first = await tools.submitAgentPlan({ plan });
  const duplicate = await tools.submitAgentPlan({ plan: structuredClone(plan) });

  assert.equal(first.workflow_status, "WAITING_FOR_APPROVAL");
  assert.equal(duplicate.workflow_status, "WAITING_FOR_APPROVAL");
  assert.equal(duplicate.idempotency.deduplicated, true);
  assert.equal(duplicate.approval.approval_id, first.approval.approval_id);
  assert.equal(tools.listPendingApprovals().length, 1);
  assert.equal(homeAssistant.getAuditLog().length, 0);
});

test("不同 plan_id 的语义相同计划也复用同一个待确认项", async () => {
  const { tools } = fixture();
  const originalPlan = candidatePlan([{ device_id: "light.living_room", name: "turn_on" }]);
  const retryPlan = {
    ...originalPlan,
    plan_id: "candidate-plan-retry",
    trace_id: "trace-candidate-plan-retry",
  };

  const first = await tools.submitAgentPlan({ plan: originalPlan });
  const duplicate = await tools.submitAgentPlan({ plan: retryPlan });

  assert.equal(duplicate.idempotency.deduplicated, true);
  assert.equal(duplicate.idempotency.submitted_plan_id, retryPlan.plan_id);
  assert.equal(duplicate.idempotency.original_plan_id, originalPlan.plan_id);
  assert.equal(duplicate.approval.approval_id, first.approval.approval_id);
  assert.equal(tools.listPendingApprovals().length, 1);
});

test("待确认中的 plan_id 不能被不同内容复用", async () => {
  const { homeAssistant, tools } = fixture();
  const plan = candidatePlan([{ device_id: "light.living_room", name: "turn_on" }]);
  const first = await tools.submitAgentPlan({ plan });
  const changedPlan = {
    ...plan,
    steps: [{
      ...plan.steps[0],
      action: { ...plan.steps[0].action, name: "turn_off" },
    }],
  };

  const changed = await tools.submitAgentPlan({ plan: changedPlan });

  assert.equal(changed.error.code, "PLAN_ID_REUSED_WITH_DIFFERENT_CONTENT");
  assert.equal(changed.execution_performed, false);
  assert.equal(tools.listPendingApprovals().length, 1);
  assert.equal(tools.listPendingApprovals()[0].approval_id, first.approval.approval_id);
  assert.equal(homeAssistant.getAuditLog().length, 0);
});

test("并发重复提交只建立一个待确认项", async () => {
  const { homeAssistant, tools } = fixture();
  const plan = candidatePlan([{ device_id: "light.living_room", name: "turn_on" }]);

  const results = await Promise.all([
    tools.submitAgentPlan({ plan }),
    tools.submitAgentPlan({ plan: structuredClone(plan) }),
    tools.submitAgentPlan({ plan: structuredClone(plan) }),
  ]);

  assert.equal(results.filter((result) => result.idempotency?.deduplicated !== true).length, 1);
  assert.equal(new Set(results.map((result) => result.approval.approval_id)).size, 1);
  assert.equal(tools.listPendingApprovals().length, 1);
  assert.equal(homeAssistant.getAuditLog().length, 0);
});

test("拒绝后幂等记录释放，同一计划可重新提交", async () => {
  const { tools } = fixture();
  const plan = candidatePlan([{ device_id: "light.living_room", name: "turn_on" }]);
  const first = await tools.submitAgentPlan({ plan });
  const rejected = await tools.resolveApproval({
    approval_id: first.approval.approval_id,
    decision: "reject",
  });
  const retry = await tools.submitAgentPlan({ plan: structuredClone(plan) });

  assert.equal(rejected.workflow_status, "REJECTED");
  assert.equal(retry.workflow_status, "WAITING_FOR_APPROVAL");
  assert.equal(retry.idempotency, undefined);
  assert.notEqual(retry.approval.approval_id, first.approval.approval_id);
  assert.equal(tools.listPendingApprovals().length, 1);
});

test("待确认项过期后幂等记录释放，同一计划可重新提交", async () => {
  let now = Date.parse("2026-10-13T00:00:00.000Z");
  const { tools } = fixture({ clock: () => now, approvalTtlMs: 5_000 });
  const plan = candidatePlan([{ device_id: "light.living_room", name: "turn_on" }]);
  const first = await tools.submitAgentPlan({ plan });
  now += 5_001;

  const retry = await tools.submitAgentPlan({ plan: structuredClone(plan) });

  assert.equal(retry.workflow_status, "WAITING_FOR_APPROVAL");
  assert.equal(retry.idempotency, undefined);
  assert.notEqual(retry.approval.approval_id, first.approval.approval_id);
  assert.equal(tools.listPendingApprovals().length, 1);
});

test("Gateway 重启后待确认计划只恢复为需重新规划，旧确认绝不会执行", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lt-agent-approval-recovery-"));
  try {
    const filePath = join(directory, "approval-state.json");
    const firstStore = new AgentApprovalStateStore({ filePath });
    const first = fixture({ approvalStateStore: firstStore });
    const plan = candidatePlan([{ device_id: "light.living_room", name: "turn_on" }]);
    plan.steps[0].input = { event: { private_note: "不得落盘的会话内容" } };
    const created = await first.tools.submitAgentPlan({ plan });
    assert.equal(created.workflow_status, "WAITING_FOR_APPROVAL");
    assert.equal(first.homeAssistant.getAuditLog().length, 0);

    const persistedText = readFileSync(filePath, "utf8");
    assert.doesNotMatch(persistedText, /不得落盘的会话内容|候选多 Agent 家庭任务|evidence|private_note/);
    assert.match(persistedText, /light\.living_room/);

    const restartedStore = new AgentApprovalStateStore({ filePath });
    const restarted = fixture({ deviceRuntime: first.runtime, approvalStateStore: restartedStore });
    const pending = restarted.tools.listPendingApprovals();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].workflow_status, "RECOVERY_REQUIRED");
    assert.equal(pending[0].recovery_required, true);
    assert.equal(pending[0].approval_id, created.approval.approval_id);

    const attemptedApproval = await restarted.tools.resolveApproval({
      approval_id: created.approval.approval_id,
      decision: "approve",
    });
    assert.equal(attemptedApproval.workflow_status, "RECOVERY_REQUIRED");
    assert.equal(first.homeAssistant.getAuditLog().length, 0);

    const duplicate = await restarted.tools.submitAgentPlan({ plan: structuredClone(plan) });
    assert.equal(duplicate.workflow_status, "RECOVERY_REQUIRED");
    assert.equal(duplicate.idempotency.deduplicated, true);
    assert.equal(duplicate.approval.approval_id, created.approval.approval_id);
    assert.equal(first.homeAssistant.getAuditLog().length, 0);

    const closed = await restarted.tools.resolveApproval({
      approval_id: created.approval.approval_id,
      decision: "reject",
    });
    assert.equal(closed.workflow_status, "REJECTED");
    assert.equal(first.homeAssistant.getAuditLog().length, 0);
    const replanned = await restarted.tools.submitAgentPlan({ plan: structuredClone(plan) });
    assert.equal(replanned.workflow_status, "WAITING_FOR_APPROVAL");
    assert.notEqual(replanned.approval.approval_id, created.approval.approval_id);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("崩溃在设备执行窗口时恢复为 EXECUTION_UNCERTAIN，不允许自动重放", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lt-agent-approval-uncertain-"));
  try {
    const filePath = join(directory, "approval-state.json");
    const store = new AgentApprovalStateStore({ filePath });
    const plan = candidatePlan([{ device_id: "light.living_room", name: "turn_off" }]);
    store.recordWorkflowState({
      approval_id: "approval-executing",
      status: "EXECUTING",
      plan,
      plan_fingerprint: "semantic-fingerprint",
      created_at_ms: Date.now(),
      expires_at_ms: Date.now() + 30_000,
    }, "candidate_plan");

    const afterRestart = new AgentApprovalStateStore({ filePath });
    const recovered = afterRestart.list()[0];
    assert.equal(recovered.status, "EXECUTION_UNCERTAIN");
    assert.equal(recovered.steps[0].action.name, "turn_off");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("确认状态文件损坏时失败关闭，不继续处理审批", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lt-agent-approval-corrupt-"));
  try {
    const filePath = join(directory, "approval-state.json");
    writeFileSync(filePath, "{not-json", "utf8");
    assert.throws(() => new AgentApprovalStateStore({ filePath }), /无法解析/);
    writeFileSync(filePath, JSON.stringify({ schema_version: 1, updated_at_ms: Date.now(), records: [], leaked_field: "private" }), "utf8");
    assert.throws(() => new AgentApprovalStateStore({ filePath }), /版本或结构无效/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("确认状态无法写入时不创建可批准项，也不执行设备动作", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lt-agent-approval-write-fail-"));
  try {
    const blocker = join(directory, "not-a-directory");
    writeFileSync(blocker, "occupied", "utf8");
    const store = new AgentApprovalStateStore({ filePath: join(blocker, "state.json") });
    const { homeAssistant, tools } = fixture({ approvalStateStore: store });
    const result = await tools.submitAgentPlan({
      plan: candidatePlan([{ device_id: "light.living_room", name: "turn_on" }]),
    });
    assert.equal(result.workflow_status, "APPROVAL_STATE_PERSIST_FAILED");
    assert.equal(result.execution_performed, false);
    assert.equal(tools.listPendingApprovals().length, 0);
    assert.equal(homeAssistant.getAuditLog().length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("EXECUTION_UNCERTAIN 必须核对后显式关闭；拒绝旧确认不能解除阻止", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lt-agent-approval-reconcile-"));
  try {
    const filePath = join(directory, "approval-state.json");
    const firstStore = new AgentApprovalStateStore({ filePath });
    const first = fixture({ approvalStateStore: firstStore });
    const plan = candidatePlan([{ device_id: "light.living_room", name: "turn_off" }]);
    const pending = await first.tools.submitAgentPlan({ plan });
    const initialRecord = firstStore.list()[0];
    firstStore.recordWorkflowState({
      approval_id: pending.approval.approval_id,
      status: "EXECUTING",
      plan,
      plan_fingerprint: initialRecord.plan_fingerprint,
      created_at_ms: initialRecord.created_at_ms,
      expires_at_ms: initialRecord.expires_at_ms,
    }, "candidate_plan");

    const restartedStore = new AgentApprovalStateStore({ filePath });
    const restarted = fixture({ deviceRuntime: first.runtime, approvalStateStore: restartedStore });
    const rejected = await restarted.tools.resolveApproval({
      approval_id: pending.approval.approval_id,
      decision: "reject",
    });
    assert.equal(rejected.workflow_status, "EXECUTION_UNCERTAIN");
    assert.equal(restartedStore.list().length, 1);

    const duplicate = await restarted.tools.submitAgentPlan({ plan: structuredClone(plan) });
    assert.equal(duplicate.workflow_status, "EXECUTION_UNCERTAIN");
    assert.equal(duplicate.idempotency.deduplicated, true);

    const light = first.homeAssistant.devices.get("light.living_room");
    const originalState = { state: light.state, available: light.available };
    light.state = "unavailable";
    light.available = false;
    const unavailable = await restarted.tools.resolveApproval({
      approval_id: pending.approval.approval_id,
      decision: "check_state",
    });
    assert.equal(unavailable.workflow_status, "EXECUTION_UNCERTAIN");
    assert.equal(unavailable.recovery_required, true);
    assert.equal(unavailable.reconciliation_status, "DEVICE_STATE_UNAVAILABLE");
    assert.equal(unavailable.reconciliation_error_code, "DEVICE_STATE_UNAVAILABLE");
    assert.equal(restartedStore.list().length, 1, "设备离线时不清除不确定记录");

    light.state = originalState.state;
    light.available = originalState.available;
    const checked = await restarted.tools.resolveApproval({
      approval_id: pending.approval.approval_id,
      decision: "check_state",
    });
    assert.equal(checked.workflow_status, "EXECUTION_UNCERTAIN");
    assert.equal(checked.reconciliation_status, "WAITING_FOR_USER_REVIEW");
    assert.equal(checked.current_device_states[0].state, originalState.state);
    assert.equal(typeof checked.checked_at, "string");
    assert.equal(restartedStore.list().length, 1, "只读检查不会关闭不确定记录");

    light.state = originalState.state === "on" ? "off" : "on";
    const changed = await restarted.tools.resolveApproval({
      approval_id: pending.approval.approval_id,
      decision: "reconciled",
    });
    assert.equal(changed.workflow_status, "EXECUTION_UNCERTAIN");
    assert.equal(changed.reconciliation_status, "STATE_CHANGED");
    assert.equal(changed.current_device_states[0].state, light.state);
    assert.equal(restartedStore.list().length, 1, "复查发现状态变化时继续阻止关闭");

    const reconciled = await restarted.tools.resolveApproval({
      approval_id: pending.approval.approval_id,
      decision: "reconciled",
    });
    assert.equal(reconciled.workflow_status, "RECONCILED");
    assert.equal(reconciled.prior_execution_result, "UNKNOWN");
    assert.deepEqual(reconciled.current_device_states, [{
      device_id: "light.living_room",
      domain: "light",
      available: true,
      state: light.state,
      affected_actions: ["turn_off"],
    }]);
    assert.equal(first.homeAssistant.getAuditLog().length, 0);
    assert.equal(restartedStore.list().length, 0);

    const replanned = await restarted.tools.submitAgentPlan({ plan: structuredClone(plan) });
    assert.equal(replanned.workflow_status, "WAITING_FOR_APPROVAL");
    assert.equal(first.homeAssistant.getAuditLog().length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("不确定记录关闭前必须先查询状态，超过两分钟的查询结果不能复用", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lt-agent-approval-reconcile-ttl-"));
  try {
    let now = 100_000;
    const clock = () => now;
    const filePath = join(directory, "approval-state.json");
    const firstStore = new AgentApprovalStateStore({ filePath, clock });
    const first = fixture({ approvalStateStore: firstStore, clock });
    const plan = candidatePlan([{ device_id: "light.living_room", name: "turn_off" }]);
    const pending = await first.tools.submitAgentPlan({ plan });
    const initialRecord = firstStore.list()[0];
    firstStore.recordWorkflowState({
      approval_id: pending.approval.approval_id,
      status: "EXECUTING",
      plan,
      plan_fingerprint: initialRecord.plan_fingerprint,
      created_at_ms: initialRecord.created_at_ms,
      expires_at_ms: initialRecord.expires_at_ms,
    }, "candidate_plan");

    const restartedStore = new AgentApprovalStateStore({ filePath, clock });
    const restarted = fixture({ deviceRuntime: first.runtime, approvalStateStore: restartedStore, clock });
    const approvalId = pending.approval.approval_id;
    const withoutCheck = await restarted.tools.resolveApproval({ approval_id: approvalId, decision: "reconciled" });
    assert.equal(withoutCheck.workflow_status, "EXECUTION_UNCERTAIN");
    assert.equal(withoutCheck.reconciliation_status, "CHECK_REQUIRED");
    assert.equal(restartedStore.list().length, 1);

    const checked = await restarted.tools.resolveApproval({ approval_id: approvalId, decision: "check_state" });
    assert.equal(checked.reconciliation_status, "WAITING_FOR_USER_REVIEW");
    now += 2 * 60_000 + 1;
    const stale = await restarted.tools.resolveApproval({ approval_id: approvalId, decision: "reconciled" });
    assert.equal(stale.workflow_status, "EXECUTION_UNCERTAIN");
    assert.equal(stale.reconciliation_status, "CHECK_REQUIRED");
    assert.equal(restartedStore.list().length, 1);
    assert.equal(first.homeAssistant.getAuditLog().length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("重启不会延长原审批 TTL；过期项不再可批准，允许重新规划", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lt-agent-approval-ttl-"));
  try {
    let now = 10_000;
    const clock = () => now;
    const filePath = join(directory, "approval-state.json");
    const firstStore = new AgentApprovalStateStore({ filePath, clock, idempotencyTtlMs: 100 });
    const first = fixture({ approvalStateStore: firstStore, clock, approvalTtlMs: 100 });
    const plan = candidatePlan([{ device_id: "light.living_room", name: "turn_on" }]);
    const pending = await first.tools.submitAgentPlan({ plan });
    assert.equal(pending.workflow_status, "WAITING_FOR_APPROVAL");

    now += 101;
    const restartedStore = new AgentApprovalStateStore({ filePath, clock, idempotencyTtlMs: 100 });
    const restarted = fixture({ deviceRuntime: first.runtime, approvalStateStore: restartedStore, clock, approvalTtlMs: 100 });
    assert.equal(restarted.tools.listPendingApprovals().length, 0);
    const oldApproval = await restarted.tools.resolveApproval({
      approval_id: pending.approval.approval_id,
      decision: "approve",
    });
    assert.equal(oldApproval.workflow_status, "APPROVAL_NOT_FOUND_OR_EXPIRED");
    const replanned = await restarted.tools.submitAgentPlan({ plan: structuredClone(plan) });
    assert.equal(replanned.workflow_status, "WAITING_FOR_APPROVAL");
    assert.notEqual(replanned.approval.approval_id, pending.approval.approval_id);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("设备状态证据缺失或过期时拒绝执行，不以用户确认代替证据", async () => {
  const { homeAssistant, runtime } = fixture();
  runtime.invoke("control_device", { device_id: "light.living_room", action: "turn_on" });
  const unavailableRuntime = {
    invoke(name, args) {
      if (name === "get_state") return { success: false, error: { code: "DEVICE_UNAVAILABLE", message: "mock unavailable" } };
      return runtime.invoke(name, args);
    },
  };
  const missingEvidenceTools = fixture({ deviceRuntime: unavailableRuntime }).tools;
  const missing = await missingEvidenceTools.requestDeviceAction({
    device_id: "light.living_room",
    action: "turn_off",
  });
  assert.equal(missing.workflow_status, "DENIED");
  assert.equal(missing.findings.some((finding) => finding.code === "REQUIRED_EVIDENCE_MISSING"), true);
  assert.equal(homeAssistant.getState({ device_id: "light.living_room" }).device.state, "on");

  let tick = 0;
  const staleFixture = fixture({ clock: () => Date.parse("2026-10-09T00:00:00.000Z") + tick++ * 6_000 });
  staleFixture.runtime.invoke("control_device", { device_id: "light.living_room", action: "turn_on" });
  const staleTools = staleFixture.tools;
  const stale = await staleTools.requestDeviceAction({
    device_id: "light.living_room",
    action: "turn_off",
  });
  assert.equal(stale.workflow_status, "DENIED");
  assert.equal(stale.findings.some((finding) => ["EVIDENCE_STALE", "EVIDENCE_EXPIRED"].includes(finding.code)), true);
  assert.equal(staleFixture.homeAssistant.getState({ device_id: "light.living_room" }).device.state, "on");
});

test("未认证的节能计划不会自动控制设备，明确确认后才由设备管家执行", async () => {
  const { homeAssistant, tools } = fixture();
  await tools.requestDeviceAction({ device_id: "light.living_room", action: "turn_on" });
  const task = {
    schema_version: "0.1",
    task_id: "task-energy-untrusted-1",
    source_agent: "energy-saving",
    target_agent: "device-manager",
    task_type: "device_action",
    target_ref: { device_id: "light.living_room" },
    action: "turn_off",
    parameters: {},
    priority: "P3",
    deadline_ms: 30_000,
    data_level: "L0",
    privacy_level: "family",
    resource_requirement: { execution_mode: "local", capabilities: ["device_control"] },
    idempotency_key: "energy-untrusted-key",
    trace_id: "trace-energy-untrusted-1",
    metadata: { reason_code: "AREA_UNOCCUPIED", trigger_event_type: "occupancy_changed" },
  };

  const challenge = await tools.executeEnergyTask(task, { trustedEventSource: false });
  assert.equal(challenge.status, "CHALLENGE");
  assert.equal(challenge.error.code, "CONFIRMATION_REQUIRED");
  assert.equal(homeAssistant.getState({ device_id: "light.living_room" }).device.state, "on");

  const resolved = await tools.resolveApproval({
    approval_id: challenge.error.approval_id,
    decision: "approve",
  });
  assert.equal(resolved.workflow_status, "COMPLETED");
  assert.equal(homeAssistant.getState({ device_id: "light.living_room" }).device.state, "off");
  assert.equal(homeAssistant.getAuditLog().at(-1).verified, true);
});

test("可信内部事件仅能自动执行能源管家生成的关灯任务", async () => {
  const { homeAssistant, tools } = fixture();
  await tools.requestDeviceAction({ device_id: "light.living_room", action: "turn_on" });
  const task = {
    schema_version: "0.1",
    task_id: "task-energy-trusted-1",
    source_agent: "energy-saving",
    target_agent: "device-manager",
    task_type: "device_action",
    target_ref: { device_id: "light.living_room" },
    action: "turn_off",
    parameters: {},
    priority: "P3",
    deadline_ms: 30_000,
    data_level: "L0",
    privacy_level: "family",
    resource_requirement: { execution_mode: "local", capabilities: ["device_control"] },
    idempotency_key: "energy-trusted-key",
    trace_id: "trace-energy-trusted-1",
    metadata: { reason_code: "AREA_UNOCCUPIED", trigger_event_type: "occupancy_changed" },
  };

  const receipt = await tools.executeEnergyTask(task, { trustedEventSource: true });
  assert.equal(receipt.status, "SUCCEEDED");
  assert.equal(homeAssistant.getState({ device_id: "light.living_room" }).device.state, "off");
  assert.equal(homeAssistant.getAuditLog().at(-1).verified, true);
});
