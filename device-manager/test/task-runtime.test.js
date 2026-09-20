import assert from "node:assert/strict";
import test from "node:test";

import { createDeviceTaskRuntime } from "../src/task-runtime.js";
import { createDeviceToolRuntime } from "../src/tools.js";

function task(overrides = {}) {
  return {
    schema_version: "0.1",
    task_id: "task-test-001",
    source_agent: "mock-learning-behavior",
    target_agent: "device-manager",
    task_type: "control_device",
    priority: "normal",
    deadline_ms: 5000,
    resource_requirement: { execution_mode: "local", capabilities: ["home_assistant"] },
    privacy_level: "family",
    trace_id: "trace-test-001",
    payload: { device_id: "light.living_room", action: "turn_on" },
    ...overrides,
  };
}

function canonicalTask(overrides = {}) {
  return {
    task_id: "task-canonical-001",
    scene: "home",
    task_type: "device_action",
    source: "orchestrator",
    target: "device_manager",
    target_ref: { device_id: "switch.living_room_plug" },
    action: "turn_on",
    parameters: {},
    priority: "P2",
    deadline_ms: 500,
    data_level: "L0",
    compute_requirement: { class: "switch", gpu_required: false },
    idempotency_key: "task-canonical-001:turn_on",
    status: "policy_pending",
    trace_id: "trace-canonical-001",
    policy_decision: { decision: "ALLOW", decision_id: "pd-canonical-001" },
    ...overrides,
  };
}

test("标准 control_device 任务返回成功回执并验证状态", async () => {
  const deviceRuntime = createDeviceToolRuntime();
  const runtime = createDeviceTaskRuntime(deviceRuntime);
  const receipt = await runtime.execute(task());

  assert.equal(receipt.schema_version, "0.1");
  assert.equal(receipt.status, "SUCCEEDED");
  assert.equal(receipt.result.device_id, "light.living_room");
  assert.equal(receipt.result.new_state, "on");
  assert.equal(receipt.result.verified, true);
  assert.equal(receipt.audit_ref, "device-manager-audit-1");
});

test("没有用户确认的开锁任务返回 CHALLENGE", async () => {
  const deviceRuntime = createDeviceToolRuntime();
  const runtime = createDeviceTaskRuntime(deviceRuntime);
  const receipt = await runtime.execute(task({
    task_id: "task-unlock-001",
    payload: { device_id: "lock.front_door", action: "unlock" },
  }));

  assert.equal(receipt.status, "CHALLENGE");
  assert.equal(receipt.error.code, "CONFIRMATION_REQUIRED");
});

test("非法任务不会调用设备工具", async () => {
  let called = false;
  const runtime = createDeviceTaskRuntime({
    invoke() {
      called = true;
      return { success: true };
    },
  });
  const receipt = await runtime.execute(task({ priority: "urgent" }));

  assert.equal(receipt.status, "FAILED");
  assert.equal(receipt.error.code, "INVALID_TASK");
  assert.equal(called, false);
});

test("目标 Agent 不匹配时拒绝任务", async () => {
  const runtime = createDeviceTaskRuntime();
  const receipt = await runtime.execute(task({ target_agent: "security-agent" }));

  assert.equal(receipt.status, "FAILED");
  assert.match(receipt.error.message, /target_agent/);
});

test("标准 get_state 任务返回设备数据", async () => {
  const runtime = createDeviceTaskRuntime();
  const receipt = await runtime.execute(task({
    task_id: "task-state-001",
    task_type: "get_state",
    payload: { device_id: "sensor.living_room_temperature" },
  }));

  assert.equal(receipt.status, "SUCCEEDED");
  assert.equal(receipt.result.data.device.state, "22.5");
});

test("canonical device_action 任务转换为设备动作并返回标准动作回执", async () => {
  const deviceRuntime = createDeviceToolRuntime();
  const runtime = createDeviceTaskRuntime(deviceRuntime);
  const receipt = await runtime.execute(canonicalTask());

  assert.equal(receipt.status, "SUCCEEDED");
  assert.equal(receipt.trace_id, "trace-canonical-001");
  assert.equal(receipt.result.action_result.schema_version, "1.0");
  assert.equal(receipt.result.action_result.policy_decision_id, "pd-canonical-001");
  assert.equal(receipt.result.action_result.device_id, "switch.living_room_plug");
  assert.equal(receipt.result.action_result.status, "success");
  assert.equal(receipt.result.action_result.result.new_state, "on");
  assert.equal(receipt.result.action_result.result.verified, true);
});

test("canonical 任务使用幂等键避免重复控制", async () => {
  const deviceRuntime = createDeviceToolRuntime();
  const runtime = createDeviceTaskRuntime(deviceRuntime);
  const first = await runtime.execute(canonicalTask());
  const second = await runtime.execute(canonicalTask());

  assert.equal(first.status, "SUCCEEDED");
  assert.equal(second.status, "SUCCEEDED");
  assert.equal(second.result.deduplicated, true);
  assert.equal(deviceRuntime.homeAssistant.getAuditLog().length, 1);
});

test("canonical PolicyDecision=DENY 时不执行设备动作", async () => {
  const deviceRuntime = createDeviceToolRuntime();
  const runtime = createDeviceTaskRuntime(deviceRuntime);
  const receipt = await runtime.execute(canonicalTask({
    policy_decision: { decision: "DENY", decision_id: "pd-deny-001", reason_message: "测试拒绝" },
  }));

  assert.equal(receipt.status, "DENIED");
  assert.equal(receipt.error.code, "POLICY_DENIED");
  assert.equal(deviceRuntime.homeAssistant.getAuditLog().length, 0);
  assert.equal(deviceRuntime.invoke("get_state", { device_id: "switch.living_room_plug" }).device.state, "off");
});
