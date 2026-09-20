import { createDeviceTaskRuntime } from "./task-runtime.js";
import { createDeviceToolRuntime } from "./tools.js";

const TARGET_AGENT = "device-manager";

function now() {
  return new Date().toISOString();
}

function makeFailure(task, status, code, message, details = {}) {
  return {
    schema_version: "0.1",
    task_id: task.task_id,
    target_agent: TARGET_AGENT,
    status,
    completed_at: now(),
    trace_id: task.trace_id,
    result: {},
    error: { code, message, ...details },
    elapsed_ms: 0,
  };
}

function defaultResourceStatus() {
  return {
    schema_version: "0.1",
    node_id: "mock-edge-01",
    node_type: "edge",
    labels: ["home_local", "device_control"],
    observed_at: now(),
    ttl_seconds: 15,
    online: true,
    resources: {
      cpu_percent: 20,
      memory_percent: 35,
      gpu_available: false,
      npu_available: false,
    },
    network: { rtt_to_cloud_ms: 0, bandwidth_mbps: null },
    queue_depth: 0,
    supported_compute: ["switch", "smart_plug", "light", "climate", "curtain", "lock", "rule_engine"],
    data_zone: "home_local",
  };
}

export function makeDeviceActionTask({
  task_id = `task-${Date.now()}`,
  device_id,
  action,
  parameters = {},
  priority = "P2",
  data_level = "L0",
  trace_id = `trace-${Date.now()}`,
  idempotency_key = `${task_id}:${action}`,
  source = "mock-orchestrator",
  compute_class = "switch",
  policy_decision,
} = {}) {
  return {
    task_id,
    scene: "device-control",
    task_type: "device_action",
    source,
    target: "device_manager",
    target_ref: { device_id },
    action,
    parameters,
    priority,
    deadline_ms: 500,
    data_level,
    compute_requirement: { class: compute_class, gpu_required: false },
    idempotency_key,
    status: "policy_pending",
    trace_id,
    ...(policy_decision ? { policy_decision } : {}),
  };
}

function evaluatePolicy(task, device, resourceStatus) {
  if (task.policy_decision) return task.policy_decision;
  if (task.action === "unlock") {
    return {
      decision: "CHALLENGE",
      decision_id: `${task.task_id}:policy`,
      reason_code: "HIGH_RISK_UNLOCK",
      reason_message: "开锁必须经过用户明确确认",
      confirmation_required: true,
    };
  }
  if (task.data_level === "L3" && resourceStatus.data_zone !== "home_local") {
    return {
      decision: "DENY",
      decision_id: `${task.task_id}:policy`,
      reason_code: "L3_DATA_OUT_OF_HOME",
      reason_message: "原始敏感数据不得离开家庭本地节点",
    };
  }
  if (!device) {
    return {
      decision: "DENY",
      decision_id: `${task.task_id}:policy`,
      reason_code: "DEVICE_NOT_FOUND",
      reason_message: "策略阶段未找到目标设备",
    };
  }
  if (!device.available) {
    return {
      decision: "DENY",
      decision_id: `${task.task_id}:policy`,
      reason_code: "DEVICE_OFFLINE",
      reason_message: "目标设备当前离线",
    };
  }
  return {
    decision: "ALLOW",
    decision_id: `${task.task_id}:policy`,
    reason_code: "LOCAL_DEVICE_CONTROL",
    reason_message: "本地设备控制允许执行",
    confirmation_required: false,
  };
}

function selectResource(task, resourceStatus) {
  if (!resourceStatus.online) {
    return { ok: false, reason: "RESOURCE_OFFLINE" };
  }
  const requestedClass = task.compute_requirement?.class;
  if (requestedClass && !resourceStatus.supported_compute.includes(requestedClass)) {
    return { ok: false, reason: "COMPUTE_NOT_SUPPORTED", requestedClass };
  }
  return { ok: true, node_id: resourceStatus.node_id, reason: "LOCAL_EDGE_AVAILABLE" };
}

/**
 * Local-only stand-in for the Orchestrator, Security and Cloud/Edge groups.
 * It is deliberately small: replace its policy/resource functions later with
 * the real group interfaces without changing the Device Manager runtime.
 */
export function createMockOrchestrator({ deviceRuntime = createDeviceToolRuntime(), resourceStatus } = {}) {
  const taskRuntime = createDeviceTaskRuntime(deviceRuntime);
  const currentResource = resourceStatus ?? defaultResourceStatus();
  const traceLog = [];

  return {
    resourceStatus: currentResource,
    traceLog,

    async submit(task) {
      const startedAt = Date.now();
      const stages = [];
      const trace_id = task.trace_id;
      const deviceId = task.target_ref?.device_id;
      const state = deviceId ? deviceRuntime.invoke("get_state", { device_id: deviceId }) : null;
      const device = state?.success ? state.device : null;

      stages.push({ stage: "task_received", status: "ok", trace_id });
      const resourceSelection = selectResource(task, currentResource);
      stages.push({ stage: "resource_selection", status: resourceSelection.ok ? "ok" : "failed", trace_id, ...resourceSelection });
      if (!resourceSelection.ok) {
        const receipt = makeFailure(task, "RETRYABLE", resourceSelection.reason, "当前没有满足要求的执行节点", {
          resource_id: currentResource.node_id,
        });
        stages.push({ stage: "device_manager", status: "skipped", trace_id });
        const record = { trace_id, task_id: task.task_id, policy_decision: null, resource_status: currentResource, stages, receipt, elapsed_ms: Date.now() - startedAt };
        traceLog.push(record);
        return record;
      }

      const policyDecision = evaluatePolicy(task, device, currentResource);
      stages.push({ stage: "policy_decision", status: policyDecision.decision.toLowerCase(), trace_id, decision_id: policyDecision.decision_id });
      const receipt = await taskRuntime.execute({ ...task, policy_decision: policyDecision });
      stages.push({ stage: "device_manager", status: receipt.status.toLowerCase(), trace_id });
      stages.push({ stage: "receipt", status: receipt.status.toLowerCase(), trace_id });

      const record = {
        trace_id,
        task_id: task.task_id,
        policy_decision: policyDecision,
        resource_status: currentResource,
        stages,
        receipt,
        elapsed_ms: Date.now() - startedAt,
      };
      traceLog.push(record);
      return record;
    },
  };
}
