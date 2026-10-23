import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIndependentEnergyWorkflow } from "../src/independent-energy-workflow.js";
import { createDeviceToolRuntime } from "../src/tools.js";
import { MockHomeAssistant } from "../src/mock-ha.js";
import { createOrchestratorBridge } from "../src/orchestrator-bridge.js";
import { AgentApprovalStateStore } from "../src/agent-approval-state-store.js";

const TRACE_ID = "trace-independent-energy-001";

function event(overrides = {}) {
  return {
    schema_version: "0.1",
    event_id: "evt-independent-energy-001",
    source_agent: "openclaw-unverified-input",
    event_type: "occupancy_changed",
    occurred_at: "2026-10-15T08:00:00.000Z",
    privacy_level: "family",
    trace_id: TRACE_ID,
    payload: { area: "living_room", occupied: false, observed_for_ms: 600_000 },
    ...overrides,
  };
}

function task(traceId = TRACE_ID) {
  return {
    schema_version: "0.1",
    task_id: "task-independent-energy-001",
    source_agent: "energy-saving",
    target_agent: "device-manager",
    task_type: "device_action",
    target_ref: { device_id: "light.living_room" },
    action: "turn_off",
    parameters: {},
    priority: "P3",
    deadline_ms: 30_000,
    resource_requirement: { execution_mode: "local", capabilities: ["device_control"] },
    privacy_level: "family",
    data_level: "L0",
    idempotency_key: "energy:evt-independent-energy-001:light.living_room:turn_off",
    trace_id: traceId,
  };
}

function recordedGatewayCandidate() {
  return {
    ...task("trace-energy-task-positive-20261016"),
    task_id: "task-energy-trace-energy-task-positive-20261016-light-living_room-off",
    status: "READY",
    resource_requirement: { execution_mode: "local", capabilities: ["home_assistant", "device_control"] },
    compute_requirement: { class: "switch", gpu_required: false },
    // The captured idempotency key is redacted in the session record.
    idempotency_key: "synthetic-energy-task-positive-20261016",
    metadata: {
      reason_code: "HOME_MODE_AWAY",
      trigger_event_id: "evt-home-mode-away-synthetic-20261016",
      area: "living_room",
    },
  };
}

function recordedGatewayEvent(candidate) {
  return event({
    event_id: "evt-home-mode-away-synthetic-20261016",
    event_type: "home_mode_changed",
    trace_id: candidate.trace_id,
    payload: { mode: "away", area: "living_room" },
  });
}

test("NO_ACTION 是正常结果，不创建设备计划也不执行动作", async () => {
  let agentCalls = 0;
  let taskCalls = 0;
  const workflow = createIndependentEnergyWorkflow({
    agentClient: {
      async invoke(request) {
        agentCalls += 1;
        assert.equal(request.agentId, "energy-saving");
        assert.equal(request.traceId, TRACE_ID);
        assert.equal(request.input.event.event_id, "evt-independent-energy-001");
        return {
          status: "ok",
          output: {
            schema_version: "0.1",
            outcome: "NO_ACTION",
            source_agent: "energy-saving",
            trace_id: TRACE_ID,
            reason_code: "OCCUPANCY_NOT_CONFIRMED",
          },
        };
      },
    },
    async executeEnergyTask() { taskCalls += 1; },
  });

  const result = await workflow.evaluate({ event: event() });
  assert.equal(result.status, "NO_ACTION");
  assert.equal(result.execution_performed, false);
  assert.equal(result.reason_code, "OCCUPANCY_NOT_CONFIRMED");
  assert.equal(agentCalls, 1);
  assert.equal(taskCalls, 0);
});

test("候选 Task 交由设备管家既有流程，并因对话来源未认证而请求确认", async () => {
  const executeCalls = [];
  const workflow = createIndependentEnergyWorkflow({
    agentClient: { async invoke() { return { status: "ok", output: task() }; } },
    async executeEnergyTask(candidate, options) {
      executeCalls.push({ candidate, options });
      return {
        status: "CHALLENGE",
        error: { code: "CONFIRMATION_REQUIRED", approval_id: "approval-001" },
      };
    },
  });

  const result = await workflow.evaluate({ event: event() });
  assert.equal(result.outcome, "TASK_SUBMITTED");
  assert.equal(result.status, "CHALLENGE");
  assert.equal(result.execution_performed, false);
  assert.equal(result.confirmation_required, true);
  assert.equal(executeCalls.length, 1);
  assert.equal(executeCalls[0].candidate.task_id, "task-independent-energy-001");
  assert.deepEqual(executeCalls[0].options, { trustedEventSource: false });
});

test("Gateway Task 样例在等待、暂缓和拒绝确认时均不产生设备动作", async () => {
  const homeAssistant = new MockHomeAssistant();
  const runtime = createDeviceToolRuntime(homeAssistant);
  runtime.invoke("control_device", { device_id: "light.living_room", action: "turn_on" });
  const actionsBeforeCandidate = homeAssistant.auditLog.length;
  const bridge = createOrchestratorBridge(runtime);
  // Based on the Gateway/DeepSeek candidate generated on 2026-10-16.
  const gatewayCandidate = recordedGatewayCandidate();
  const workflow = createIndependentEnergyWorkflow({
    agentClient: { async invoke() { return { status: "ok", output: gatewayCandidate }; } },
    executeEnergyTask: (candidate, options) => bridge.agentPlanTools.executeEnergyTask(candidate, options),
  });

  const result = await workflow.evaluate({ event: recordedGatewayEvent(gatewayCandidate) });
  assert.equal(result.status, "CHALLENGE");
  assert.equal(result.execution_performed, false);
  assert.equal(result.confirmation_required, true);
  assert.equal(result.task.task_id, gatewayCandidate.task_id);
  assert.ok(result.receipt.error.approval_id);
  const approvalId = result.receipt.error.approval_id;
  assert.equal(bridge.agentPlanTools.listPendingApprovals().some((item) => item.approval_id === approvalId), true);
  assert.equal(homeAssistant.getState({ device_id: "light.living_room" }).device.state, "on");
  assert.equal(homeAssistant.auditLog.length - actionsBeforeCandidate, 0);

  const deferred = await bridge.agentPlanTools.resolveApproval({ approval_id: approvalId, decision: "defer" });
  assert.equal(deferred.workflow_status, "WAITING_FOR_APPROVAL");
  assert.equal(bridge.agentPlanTools.listPendingApprovals().some((item) => item.approval_id === approvalId), true);
  assert.equal(homeAssistant.getState({ device_id: "light.living_room" }).device.state, "on");
  assert.equal(homeAssistant.auditLog.length - actionsBeforeCandidate, 0);

  const rejected = await bridge.agentPlanTools.resolveApproval({ approval_id: approvalId, decision: "reject" });
  assert.equal(rejected.workflow_status, "REJECTED");
  assert.equal(rejected.execution_performed, false);
  assert.equal(bridge.agentPlanTools.listPendingApprovals().some((item) => item.approval_id === approvalId), false);
  assert.equal(homeAssistant.getState({ device_id: "light.living_room" }).device.state, "on");
  assert.equal(homeAssistant.auditLog.length - actionsBeforeCandidate, 0);
});

test("候选 Task 自称来自可信 HA 事件也不能绕过确认", async () => {
  const homeAssistant = new MockHomeAssistant();
  const runtime = createDeviceToolRuntime(homeAssistant);
  runtime.invoke("control_device", { device_id: "light.living_room", action: "turn_on" });
  const actionsBeforeCandidate = homeAssistant.auditLog.length;
  const bridge = createOrchestratorBridge(runtime);
  const candidate = recordedGatewayCandidate();
  candidate.metadata = {
    ...candidate.metadata,
    reason_code: "HOME_AWAY",
    trigger_event_type: "home_mode_changed",
    corroborating_occupancy_event_id: "evt-claimed-ha-corroboration",
  };
  const workflow = createIndependentEnergyWorkflow({
    agentClient: { async invoke() { return { status: "ok", output: candidate }; } },
    executeEnergyTask: (taskResult, options) => bridge.agentPlanTools.executeEnergyTask(taskResult, options),
  });

  const result = await workflow.evaluate({ event: recordedGatewayEvent(candidate) });
  assert.equal(result.status, "CHALLENGE");
  assert.equal(result.confirmation_required, true);
  assert.equal(result.execution_performed, false);
  assert.equal(homeAssistant.getState({ device_id: "light.living_room" }).device.state, "on");
  assert.equal(homeAssistant.auditLog.length - actionsBeforeCandidate, 0);
});

test("独立 Agent 调用失败或返回错误状态时不调用设备管家", async () => {
  let executeCalls = 0;
  const executeEnergyTask = async () => { executeCalls += 1; };
  const failedResultWorkflow = createIndependentEnergyWorkflow({
    agentClient: { async invoke() { return { status: "error", output: recordedGatewayCandidate() }; } },
    executeEnergyTask,
  });
  await assert.rejects(
    failedResultWorkflow.evaluate({ event: event() }),
    { code: "INVALID_AGENT_RESULT" },
  );

  const transportFailureWorkflow = createIndependentEnergyWorkflow({
    agentClient: { async invoke() { throw new Error("synthetic Gateway timeout"); } },
    executeEnergyTask,
  });
  await assert.rejects(
    transportFailureWorkflow.evaluate({ event: event({ event_id: "evt-agent-timeout" }) }),
    /synthetic Gateway timeout/,
  );
  assert.equal(executeCalls, 0);
});

test("独立节能候选在设备管家重启后恢复为需重新规划，旧确认不能执行", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lt-independent-energy-recovery-"));
  try {
    const filePath = join(directory, "approval-state.json");
    const homeAssistant = new MockHomeAssistant();
    const runtime = createDeviceToolRuntime(homeAssistant);
    runtime.invoke("control_device", { device_id: "light.living_room", action: "turn_on" });
    const actionsBeforeCandidate = homeAssistant.auditLog.length;
    const gatewayCandidate = recordedGatewayCandidate();
    const firstStore = new AgentApprovalStateStore({ filePath });
    const firstBridge = createOrchestratorBridge(runtime, { approvalStateStore: firstStore });
    const firstWorkflow = createIndependentEnergyWorkflow({
      agentClient: { async invoke() { return { status: "ok", output: gatewayCandidate }; } },
      executeEnergyTask: (candidate, options) => firstBridge.agentPlanTools.executeEnergyTask(candidate, options),
    });

    const challenge = await firstWorkflow.evaluate({ event: recordedGatewayEvent(gatewayCandidate) });
    const approvalId = challenge.receipt.error.approval_id;
    assert.equal(challenge.status, "CHALLENGE");
    assert.equal(homeAssistant.getState({ device_id: "light.living_room" }).device.state, "on");
    assert.equal(homeAssistant.auditLog.length - actionsBeforeCandidate, 0);

    const recoveredStore = new AgentApprovalStateStore({ filePath });
    const recoveredBridge = createOrchestratorBridge(runtime, { approvalStateStore: recoveredStore });
    const recovered = recoveredBridge.agentPlanTools.listPendingApprovals();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].approval_id, approvalId);
    assert.equal(recovered[0].workflow_status, "RECOVERY_REQUIRED");
    assert.equal(recovered[0].recovery_required, true);

    const staleApproval = await recoveredBridge.agentPlanTools.resolveApproval({
      approval_id: approvalId,
      decision: "approve",
    });
    assert.equal(staleApproval.workflow_status, "RECOVERY_REQUIRED");
    assert.equal(staleApproval.execution_performed, false);
    assert.equal(homeAssistant.getState({ device_id: "light.living_room" }).device.state, "on");
    assert.equal(homeAssistant.auditLog.length - actionsBeforeCandidate, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("重复投递复用同一工作流结果，不重复创建计划；幂等键冲突失败关闭", async () => {
  let agentCalls = 0;
  let taskCalls = 0;
  const workflow = createIndependentEnergyWorkflow({
    agentClient: { async invoke(request) { agentCalls += 1; return { status: "ok", output: task(request.traceId) }; } },
    async executeEnergyTask() {
      taskCalls += 1;
      return { status: "CHALLENGE", error: { code: "CONFIRMATION_REQUIRED" } };
    },
  });
  const request = { event: event({ trace_id: undefined }), idempotencyKey: "idem-independent-001" };
  const [first, second] = await Promise.all([workflow.evaluate(request), workflow.evaluate(request)]);
  assert.deepEqual(first, second);
  assert.equal(agentCalls, 1);
  assert.equal(taskCalls, 1);
  await assert.rejects(workflow.evaluate({
    ...request,
    event: event({ payload: { area: "bedroom", occupied: false, observed_for_ms: 600_000 } }),
  }), { code: "IDEMPOTENCY_KEY_CONFLICT" });
});

test("非标准 Event 在调用模型前拒绝", async () => {
  let calls = 0;
  const workflow = createIndependentEnergyWorkflow({
    agentClient: { async invoke() { calls += 1; return { status: "ok", output: {} }; } },
    async executeEnergyTask() { throw new Error("should not be reached"); },
  });
  await assert.rejects(workflow.evaluate({ event: { event_id: "missing-fields" } }), { code: "INVALID_ENERGY_EVENT" });
  assert.equal(calls, 0);
});
