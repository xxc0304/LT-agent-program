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
  assert.equal(record.resource_status.online, true);
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
  assert.equal(record.receipt.status, "CHALLENGE");
  assert.equal(record.receipt.error.code, "CONFIRMATION_REQUIRED");
  assert.equal(deviceRuntime.homeAssistant.getAuditLog().length, 0);
});

test("没有可用执行节点时不调用设备管家", async () => {
  const deviceRuntime = createDeviceToolRuntime();
  const orchestrator = createMockOrchestrator({
    deviceRuntime,
    resourceStatus: {
      node_id: "mock-edge-offline",
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
