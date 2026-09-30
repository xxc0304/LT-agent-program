import assert from "node:assert/strict";
import test from "node:test";

import { createMockOrchestrator, makeDeviceActionTask } from "../src/mock-orchestrator.js";
import { createDeviceToolRuntime } from "../src/tools.js";

test("Mock 编排器可以串起 Task、策略、节点和设备回执", async () => {
  const orchestrator = createMockOrchestrator();
  const record = await orchestrator.submit(makeDeviceActionTask({
    task_id: "task-orchestrator-success",
    trace_id: "trace-orchestrator-success",
    device_id: "switch.living_room_plug",
    action: "turn_on",
  }));

  assert.equal(record.receipt.status, "SUCCEEDED");
  assert.equal(record.policy_decision.decision, "ALLOW");
  assert.equal(record.policy_decision.schema_version, "0.1");
  assert.equal(record.policy_decision.task_id, "task-orchestrator-success");
  assert.equal(record.policy_decision.trace_id, "trace-orchestrator-success");
  assert.equal(typeof record.policy_decision.decided_at, "string");
  assert.equal(record.policy_decision.confirmation_required, false);
  assert.equal(record.resource_status.online, true);
  assert.equal(record.resource_status.schema_version, "0.1");
  assert.ok(Array.isArray(record.resource_status.supported_compute));
  assert.equal(record.receipt.result.action_result.trace_id, "trace-orchestrator-success");
  assert.deepEqual(record.stages.map((stage) => stage.stage), [
    "task_received",
    "resource_selection",
    "policy_decision",
    "device_manager",
    "receipt",
  ]);
});

test("Mock 编排器通过幂等键避免重复设备动作", async () => {
  const deviceRuntime = createDeviceToolRuntime();
  const orchestrator = createMockOrchestrator({ deviceRuntime });
  const task = makeDeviceActionTask({
    task_id: "task-orchestrator-idempotent",
    trace_id: "trace-orchestrator-idempotent",
    device_id: "switch.living_room_plug",
    action: "turn_on",
  });

  const first = await orchestrator.submit(task);
  const second = await orchestrator.submit(task);

  assert.equal(first.receipt.status, "SUCCEEDED");
  assert.equal(second.receipt.status, "SUCCEEDED");
  assert.equal(second.receipt.result.deduplicated, true);
  assert.equal(deviceRuntime.homeAssistant.getAuditLog().length, 1);
});

test("高风险开锁任务由 Mock 策略返回 CHALLENGE", async () => {
  const deviceRuntime = createDeviceToolRuntime();
  const orchestrator = createMockOrchestrator({ deviceRuntime });
  const record = await orchestrator.submit(makeDeviceActionTask({
    task_id: "task-orchestrator-unlock",
    trace_id: "trace-orchestrator-unlock",
    device_id: "lock.front_door",
    action: "unlock",
    compute_class: "lock",
  }));

  assert.equal(record.policy_decision.decision, "CHALLENGE");
  assert.equal(record.policy_decision.confirmation_required, true);
  assert.equal(record.receipt.status, "CHALLENGE");
  assert.equal(record.receipt.error.code, "CONFIRMATION_REQUIRED");
  assert.equal(deviceRuntime.homeAssistant.getAuditLog().length, 0);
});

test("没有可用执行节点时不调用设备管家", async () => {
  const deviceRuntime = createDeviceToolRuntime();
  const orchestrator = createMockOrchestrator({
    deviceRuntime,
    resourceStatus: {
      schema_version: "0.1",
      node_id: "mock-edge-offline",
      observed_at: "2026-09-29T00:00:00.000Z",
      online: false,
      supported_compute: ["switch"],
      data_zone: "home_local",
    },
  });
  const record = await orchestrator.submit(makeDeviceActionTask({
    task_id: "task-orchestrator-resource-offline",
    trace_id: "trace-orchestrator-resource-offline",
    device_id: "switch.living_room_plug",
    action: "turn_on",
  }));

  assert.equal(record.receipt.status, "RETRYABLE");
  assert.equal(record.receipt.error.code, "RESOURCE_OFFLINE");
  assert.equal(deviceRuntime.homeAssistant.getAuditLog().length, 0);
});

test("设备离线时策略拒绝，不执行控制", async () => {
  const deviceRuntime = createDeviceToolRuntime();
  deviceRuntime.homeAssistant.devices.get("switch.living_room_plug").available = false;
  const orchestrator = createMockOrchestrator({ deviceRuntime });
  const record = await orchestrator.submit(makeDeviceActionTask({
    task_id: "task-orchestrator-device-offline",
    trace_id: "trace-orchestrator-device-offline",
    device_id: "switch.living_room_plug",
    action: "turn_on",
  }));

  assert.equal(record.policy_decision.decision, "DENY");
  assert.equal(record.receipt.status, "DENIED");
  assert.equal(record.receipt.error.code, "POLICY_DENIED");
  assert.equal(deviceRuntime.homeAssistant.getAuditLog().length, 0);
});

test("接口联动：Task 缺字段时在入口拒绝，且不触发策略或设备执行", async () => {
  const deviceRuntime = createDeviceToolRuntime();
  let policyCalls = 0;
  let executionCalls = 0;
  const orchestrator = createMockOrchestrator({
    deviceRuntime,
    policyProvider: async () => { policyCalls += 1; return null; },
    taskExecutor: async () => { executionCalls += 1; return null; },
  });
  const task = makeDeviceActionTask({
    task_id: "task-missing-device-ref",
    trace_id: "trace-missing-device-ref",
    device_id: "switch.living_room_plug",
    action: "turn_on",
  });
  delete task.target_ref;

  const record = await orchestrator.submit(task);

  assert.equal(record.receipt.status, "FAILED");
  assert.equal(record.receipt.error.code, "INVALID_TASK");
  assert.equal(policyCalls, 0);
  assert.equal(executionCalls, 0);
  assert.equal(deviceRuntime.homeAssistant.getAuditLog().length, 0);
});

test("接口联动：ResourceStatus 缺字段时 fail closed，不调用策略和设备管家", async () => {
  const deviceRuntime = createDeviceToolRuntime();
  let policyCalls = 0;
  const orchestrator = createMockOrchestrator({
    deviceRuntime,
    resourceProvider: async () => ({
      schema_version: "0.1",
      node_id: "mock-edge-01",
      observed_at: "2026-09-29T00:00:00.000Z",
      supported_compute: ["switch"],
      data_zone: "home_local",
    }),
    policyProvider: async () => { policyCalls += 1; return null; },
  });

  const record = await orchestrator.submit(makeDeviceActionTask({
    task_id: "task-resource-missing-online",
    trace_id: "trace-resource-missing-online",
    device_id: "switch.living_room_plug",
    action: "turn_on",
  }));

  assert.equal(record.receipt.status, "FAILED");
  assert.equal(record.receipt.error.code, "INVALID_RESOURCE_STATUS");
  assert.equal(record.stages.find((stage) => stage.stage === "resource_status").status, "invalid");
  assert.equal(policyCalls, 0);
  assert.equal(deviceRuntime.homeAssistant.getAuditLog().length, 0);
});

test("接口联动：ResourceStatus 超时返回 TIMEOUT，后续接口不再调用", async () => {
  const deviceRuntime = createDeviceToolRuntime();
  let policyCalls = 0;
  const orchestrator = createMockOrchestrator({
    deviceRuntime,
    resourceProvider: () => new Promise(() => {}),
    policyProvider: async () => { policyCalls += 1; return null; },
    timeouts: { resource: 5 },
  });

  const record = await orchestrator.submit(makeDeviceActionTask({
    task_id: "task-resource-timeout",
    trace_id: "trace-resource-timeout",
    device_id: "switch.living_room_plug",
    action: "turn_on",
  }));

  assert.equal(record.receipt.status, "TIMEOUT");
  assert.equal(record.receipt.error.code, "RESOURCE_STATUS_TIMEOUT");
  assert.equal(record.receipt.error.side_effects_unknown, false);
  assert.equal(policyCalls, 0);
  assert.equal(deviceRuntime.homeAssistant.getAuditLog().length, 0);
});

test("接口联动：策略接口异常和非法回包均 fail closed", async () => {
  const task = makeDeviceActionTask({
    task_id: "task-policy-error",
    trace_id: "trace-policy-error",
    device_id: "switch.living_room_plug",
    action: "turn_on",
  });

  for (const [policyProvider, expectedCode] of [
    [async () => { throw new Error("模拟策略服务不可用"); }, "POLICY_DECISION_ERROR"],
    [async () => ({ decision_id: "missing-decision", reason_code: "BAD", reason_message: "缺决策" }), "INVALID_POLICY_DECISION"],
    [async ({ task: submitted }) => ({
      schema_version: "0.1",
      decision_id: "stale-policy",
      task_id: "another-task",
      trace_id: submitted.trace_id,
      decision: "ALLOW",
      decided_at: "2026-09-29T00:00:00.000Z",
      reason_code: "STALE",
      reason_message: "决策不属于当前任务",
      confirmation_required: false,
    }), "INVALID_POLICY_DECISION"],
    [async ({ task: submitted }) => ({
      schema_version: "0.1",
      decision_id: `${submitted.task_id}:policy`,
      task_id: submitted.task_id,
      trace_id: submitted.trace_id,
      decision: "CHALLENGE",
      decided_at: "2026-09-29T00:00:00.000Z",
      reason_code: "CONFIRMATION_REQUIRED",
      reason_message: "需要用户确认",
      confirmation_required: false,
    }), "INVALID_POLICY_DECISION"],
  ]) {
    const deviceRuntime = createDeviceToolRuntime();
    let executionCalls = 0;
    const orchestrator = createMockOrchestrator({
      deviceRuntime,
      policyProvider,
      taskExecutor: async () => { executionCalls += 1; return null; },
    });

    const record = await orchestrator.submit(task);

    assert.equal(record.receipt.error.code, expectedCode);
    assert.equal(executionCalls, 0);
    assert.equal(deviceRuntime.homeAssistant.getAuditLog().length, 0);
  }
});

test("接口联动：策略超时返回 TIMEOUT，不会越过策略阶段执行设备动作", async () => {
  const deviceRuntime = createDeviceToolRuntime();
  let executionCalls = 0;
  const orchestrator = createMockOrchestrator({
    deviceRuntime,
    policyProvider: () => new Promise(() => {}),
    taskExecutor: async () => { executionCalls += 1; return null; },
    timeouts: { policy: 5 },
  });

  const record = await orchestrator.submit(makeDeviceActionTask({
    task_id: "task-policy-timeout",
    trace_id: "trace-policy-timeout",
    device_id: "switch.living_room_plug",
    action: "turn_on",
  }));

  assert.equal(record.receipt.status, "TIMEOUT");
  assert.equal(record.receipt.error.code, "POLICY_DECISION_TIMEOUT");
  assert.equal(executionCalls, 0);
  assert.equal(deviceRuntime.homeAssistant.getAuditLog().length, 0);
});

test("接口联动：设备管家超时标记副作用未知，异常回执不伪装成功", async () => {
  const task = makeDeviceActionTask({
    task_id: "task-device-manager-timeout",
    trace_id: "trace-device-manager-timeout",
    device_id: "switch.living_room_plug",
    action: "turn_on",
  });

  const timeoutOrchestrator = createMockOrchestrator({
    taskExecutor: () => new Promise(() => {}),
    timeouts: { execution: 5 },
  });
  const timeoutRecord = await timeoutOrchestrator.submit(task);
  assert.equal(timeoutRecord.receipt.status, "TIMEOUT");
  assert.equal(timeoutRecord.receipt.error.code, "DEVICE_MANAGER_TIMEOUT");
  assert.equal(timeoutRecord.receipt.error.side_effects_unknown, true);

  const errorOrchestrator = createMockOrchestrator({
    taskExecutor: async () => ({
      task_id: task.task_id,
      target_agent: "device-manager",
      status: "SUCCEEDED",
      completed_at: new Date().toISOString(),
      trace_id: "wrong-trace-id",
      result: {},
    }),
  });
  const errorRecord = await errorOrchestrator.submit(task);
  assert.equal(errorRecord.receipt.status, "FAILED");
  assert.equal(errorRecord.receipt.error.code, "INVALID_TASK_RECEIPT");
  assert.equal(errorRecord.receipt.error.side_effects_unknown, true);
});
