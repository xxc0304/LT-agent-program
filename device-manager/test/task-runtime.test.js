import assert from "node:assert/strict";
import test from "node:test";

import { canonicalToLegacyTask, createDeviceTaskRuntime } from "../src/task-runtime.js";
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
    schema_version: "0.1",
    task_id: "task-canonical-001",
    scene: "home",
    task_type: "device_action",
    source_agent: "orchestrator",
    target_agent: "device-manager",
    target_ref: { device_id: "switch.living_room_plug" },
    action: "turn_on",
    parameters: {},
    priority: "P2",
    deadline_ms: 500,
    resource_requirement: { execution_mode: "local", capabilities: ["home_assistant", "device_control"] },
    privacy_level: "family",
    data_level: "L0",
    compute_requirement: { class: "switch", gpu_required: false },
    idempotency_key: "task-canonical-001:turn_on",
    status: "POLICY_PENDING",
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

test("P3/P4 映射到旧 low 时，标准动作回执仍保留原 canonical 优先级", async () => {
  const deviceRuntime = createDeviceToolRuntime();
  const runtime = createDeviceTaskRuntime(deviceRuntime);
  const p3Task = canonicalTask({
    task_id: "task-priority-p3",
    priority: "P3",
    idempotency_key: "priority-p3-key",
    trace_id: "trace-priority-p3",
    action: "turn_on",
  });
  const p4Task = canonicalTask({
    task_id: "task-priority-p4",
    priority: "P4",
    idempotency_key: "priority-p4-key",
    trace_id: "trace-priority-p4",
    action: "turn_off",
  });

  assert.equal(canonicalToLegacyTask(p3Task).priority, "low");
  assert.equal(canonicalToLegacyTask(p4Task).priority, "low");
  const p3Receipt = await runtime.execute(p3Task);
  const p4Receipt = await runtime.execute(p4Task);
  assert.equal(p3Receipt.result.action_result.task_priority, "P3");
  assert.equal(p4Receipt.result.action_result.task_priority, "P4");
});

test("canonical Task 校验必填资源和隐私字段，且适配时不混淆 resource 与 compute", async () => {
  const deviceRuntime = createDeviceToolRuntime();
  const runtime = createDeviceTaskRuntime(deviceRuntime);

  const missingResource = canonicalTask();
  delete missingResource.resource_requirement;
  const invalidPrivacy = await runtime.execute(canonicalTask({ privacy_level: "public" }));
  const missingSchemaVersion = canonicalTask();
  delete missingSchemaVersion.schema_version;
  const missingResourceReceipt = await runtime.execute(missingResource);
  const missingVersionReceipt = await runtime.execute(missingSchemaVersion);

  assert.equal(missingResourceReceipt.error.code, "INVALID_TASK");
  assert.match(missingResourceReceipt.error.message, /resource_requirement/);
  assert.equal(missingVersionReceipt.error.code, "INVALID_TASK");
  assert.match(missingVersionReceipt.error.message, /schema_version/);
  assert.equal(invalidPrivacy.error.code, "INVALID_TASK");
  assert.match(invalidPrivacy.error.message, /privacy_level/);
  assert.equal(deviceRuntime.homeAssistant.getAuditLog().length, 0);

  const adapted = canonicalToLegacyTask(canonicalTask({
    resource_requirement: { execution_mode: "edge", capabilities: ["ha-adapter"] },
    compute_requirement: { class: "cloud", gpu_required: true },
    privacy_level: "restricted",
    data_level: "L0",
  }));
  assert.deepEqual(adapted.resource_requirement, { execution_mode: "edge", capabilities: ["ha-adapter"] });
  assert.equal(adapted.privacy_level, "restricted");

  const derivedRestriction = canonicalToLegacyTask(canonicalTask({
    resource_requirement: { execution_mode: "local" },
    privacy_level: "family",
    data_level: "L3",
  }));
  assert.equal(derivedRestriction.privacy_level, "restricted");
});

test("canonical Task 兼容旧别名输入，并在规范字段与别名冲突时 fail closed", async () => {
  const deviceRuntime = createDeviceToolRuntime();
  const runtime = createDeviceTaskRuntime(deviceRuntime);
  const legacyAliases = canonicalTask();
  legacyAliases.source = legacyAliases.source_agent;
  legacyAliases.target = legacyAliases.target_agent;
  delete legacyAliases.source_agent;
  delete legacyAliases.target_agent;

  const compatible = await runtime.execute(legacyAliases);
  assert.equal(compatible.status, "SUCCEEDED");

  const sourceConflict = await runtime.execute(canonicalTask({ source: "different-agent" }));
  const targetConflict = await runtime.execute(canonicalTask({ target: "security-agent" }));
  assert.equal(sourceConflict.error.code, "INVALID_TASK");
  assert.match(sourceConflict.error.message, /source_agent.*source/);
  assert.equal(targetConflict.error.code, "INVALID_TASK");
  assert.match(targetConflict.error.message, /target_agent.*target/);
  assert.equal(deviceRuntime.homeAssistant.getAuditLog().length, 1);
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
