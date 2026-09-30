import { createDeviceTaskRuntime } from "./task-runtime.js";
import { createDeviceToolRuntime } from "./tools.js";

const TARGET_AGENT = "device-manager";

function now() {
  return new Date().toISOString();
}

function privacyLevelForDataLevel(level) {
  return { L0: "family", L1: "family", L2: "sensitive", L3: "restricted" }[level] ?? "family";
}

function makeFailure(task, status, code, message, details = {}) {
  return {
    schema_version: "0.1",
    task_id: task?.task_id ?? "unknown",
    target_agent: TARGET_AGENT,
    status,
    completed_at: now(),
    trace_id: task?.trace_id,
    result: {},
    error: { code, message, ...details },
    elapsed_ms: 0,
  };
}

const RECEIPT_STATUSES = new Set(["SUCCEEDED", "FAILED", "DENIED", "CHALLENGE", "TIMEOUT", "RETRYABLE"]);

function validateTask(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) return "Task 必须是 JSON 对象";
  for (const field of ["task_id", "trace_id", "target", "target_ref", "action", "idempotency_key"]) {
    if (task[field] === undefined) return `缺少 Task 必填字段：${field}`;
  }
  if (typeof task.task_id !== "string" || !task.task_id) return "task_id 必须是非空字符串";
  if (typeof task.trace_id !== "string" || !task.trace_id) return "trace_id 必须是非空字符串";
  if (task.task_type !== "device_action") return "task_type 必须是 device_action";
  if (!["device-manager", "device_manager"].includes(task.target)) return "target 必须指向 device-manager";
  if (!task.target_ref || typeof task.target_ref.device_id !== "string" || !task.target_ref.device_id) {
    return "target_ref.device_id 必须是非空字符串";
  }
  if (typeof task.action !== "string" || !task.action) return "action 必须是非空字符串";
  if (typeof task.idempotency_key !== "string" || !task.idempotency_key) return "idempotency_key 必须是非空字符串";
  return null;
}

function validateResourceStatus(resource) {
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) return "ResourceStatus 必须是 JSON 对象";
  if (resource.schema_version !== "0.1") return "ResourceStatus.schema_version 必须是 0.1";
  if (typeof resource.node_id !== "string" || !resource.node_id) return "ResourceStatus.node_id 缺失或无效";
  if (typeof resource.observed_at !== "string" || !Number.isFinite(Date.parse(resource.observed_at))) return "ResourceStatus.observed_at 缺失或无效";
  if (typeof resource.online !== "boolean") return "ResourceStatus.online 缺失或无效";
  if (!Array.isArray(resource.supported_compute) || resource.supported_compute.some((item) => typeof item !== "string" || !item)) return "ResourceStatus.supported_compute 缺失或无效";
  if (typeof resource.data_zone !== "string" || !resource.data_zone) return "ResourceStatus.data_zone 缺失或无效";
  return null;
}

function validatePolicyDecision(decision, task) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return "PolicyDecision 必须是 JSON 对象";
  if (decision.schema_version !== "0.1") return "PolicyDecision.schema_version 必须是 0.1";
  if (!["ALLOW", "DENY", "CHALLENGE"].includes(decision.decision)) return "PolicyDecision.decision 缺失或无效";
  if (typeof decision.decision_id !== "string" || !decision.decision_id) return "PolicyDecision.decision_id 缺失或无效";
  if (decision.task_id !== task.task_id) return "PolicyDecision.task_id 与当前 Task 不匹配";
  if (decision.trace_id !== task.trace_id) return "PolicyDecision.trace_id 与当前 Task 不匹配";
  if (typeof decision.decided_at !== "string" || !Number.isFinite(Date.parse(decision.decided_at))) return "PolicyDecision.decided_at 缺失或无效";
  if (typeof decision.reason_code !== "string" || !decision.reason_code) return "PolicyDecision.reason_code 缺失或无效";
  if (typeof decision.reason_message !== "string" || !decision.reason_message) return "PolicyDecision.reason_message 缺失或无效";
  if (typeof decision.confirmation_required !== "boolean") return "PolicyDecision.confirmation_required 缺失或无效";
  if (decision.decision === "CHALLENGE" && decision.confirmation_required !== true) return "CHALLENGE 必须要求用户确认";
  return null;
}

function validateReceipt(receipt, task) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return "TaskReceipt 必须是 JSON 对象";
  if (receipt.task_id !== task.task_id) return "TaskReceipt.task_id 与请求不匹配";
  if (receipt.target_agent !== TARGET_AGENT) return "TaskReceipt.target_agent 与请求不匹配";
  if (!RECEIPT_STATUSES.has(receipt.status)) return "TaskReceipt.status 缺失或无效";
  if (typeof receipt.completed_at !== "string" || !Number.isFinite(Date.parse(receipt.completed_at))) {
    return "TaskReceipt.completed_at 缺失或无效";
  }
  if (receipt.trace_id !== task.trace_id) return "TaskReceipt.trace_id 与请求不匹配";
  return null;
}

async function settleWithin(operation, timeoutMs) {
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(operation).then((value) => ({ value })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      }),
    ]);
    return result;
  } finally {
    clearTimeout(timer);
  }
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
    schema_version: "0.1",
    task_id,
    scene: "device-control",
    task_type: "device_action",
    source,
    source_agent: source,
    target: TARGET_AGENT,
    target_agent: TARGET_AGENT,
    target_ref: { device_id },
    action,
    parameters,
    priority,
    deadline_ms: 500,
    data_level,
    privacy_level: privacyLevelForDataLevel(data_level),
    resource_requirement: { execution_mode: "local", capabilities: [compute_class] },
    compute_requirement: { class: compute_class, gpu_required: false },
    idempotency_key,
    status: "POLICY_PENDING",
    trace_id,
    ...(policy_decision ? { policy_decision } : {}),
  };
}

function makePolicyDecision(task, decision, reason_code, reason_message, confirmation_required = false) {
  return {
    schema_version: "0.1",
    decision_id: `${task.task_id}:policy`,
    task_id: task.task_id,
    trace_id: task.trace_id,
    decision,
    decided_at: now(),
    reason_code,
    reason_message,
    confirmation_required,
  };
}

function evaluatePolicy(task, device, resourceStatus) {
  if (task.policy_decision) return task.policy_decision;
  if (task.action === "unlock") {
    return makePolicyDecision(task, "CHALLENGE", "HIGH_RISK_UNLOCK", "开锁必须经过用户明确确认", true);
  }
  if (task.data_level === "L3" && resourceStatus.data_zone !== "home_local") {
    return makePolicyDecision(task, "DENY", "L3_DATA_OUT_OF_HOME", "原始敏感数据不得离开家庭本地节点");
  }
  if (!device) {
    return makePolicyDecision(task, "DENY", "DEVICE_NOT_FOUND", "策略阶段未找到目标设备");
  }
  if (!device.available) {
    return makePolicyDecision(task, "DENY", "DEVICE_OFFLINE", "目标设备当前离线");
  }
  return makePolicyDecision(task, "ALLOW", "LOCAL_DEVICE_CONTROL", "本地设备控制允许执行");
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
export function createMockOrchestrator({
  deviceRuntime = createDeviceToolRuntime(),
  resourceStatus,
  resourceProvider,
  policyProvider,
  taskExecutor,
  timeouts = {},
} = {}) {
  const taskRuntime = createDeviceTaskRuntime(deviceRuntime);
  const currentResource = resourceStatus ?? defaultResourceStatus();
  const getResourceStatus = resourceProvider ?? (async () => currentResource);
  const getPolicyDecision = policyProvider ?? (async ({ task, device, resource }) => evaluatePolicy(task, device, resource));
  const executeTask = taskExecutor ?? ((task) => taskRuntime.execute(task));
  const timeoutMs = {
    resource: timeouts.resource ?? 1000,
    policy: timeouts.policy ?? 1000,
    execution: timeouts.execution ?? 1000,
  };
  const traceLog = [];

  function finish(record) {
    traceLog.push(record);
    return record;
  }

  return {
    resourceStatus: currentResource,
    traceLog,

    async submit(task) {
      const startedAt = Date.now();
      const stages = [];
      const trace_id = task?.trace_id;
      const taskError = validateTask(task);
      if (taskError) {
        const receipt = makeFailure(task, "FAILED", "INVALID_TASK", taskError);
        stages.push({ stage: "task_validation", status: "failed", trace_id, error: taskError });
        return finish({ trace_id, task_id: task?.task_id ?? null, policy_decision: null, resource_status: null, stages, receipt, elapsed_ms: Date.now() - startedAt });
      }

      const deviceId = task.target_ref?.device_id;
      const state = deviceId ? deviceRuntime.invoke("get_state", { device_id: deviceId }) : null;
      const device = state?.success ? state.device : null;

      stages.push({ stage: "task_received", status: "ok", trace_id });
      let resourceResult;
      try {
        resourceResult = await settleWithin(getResourceStatus, timeoutMs.resource);
      } catch {
        const receipt = makeFailure(task, "FAILED", "RESOURCE_STATUS_ERROR", "ResourceStatus 接口调用失败");
        stages.push({ stage: "resource_status", status: "failed", trace_id });
        return finish({ trace_id, task_id: task.task_id, policy_decision: null, resource_status: null, stages, receipt, elapsed_ms: Date.now() - startedAt });
      }
      if (resourceResult.timedOut) {
        const receipt = makeFailure(task, "TIMEOUT", "RESOURCE_STATUS_TIMEOUT", "ResourceStatus 接口超时", { side_effects_unknown: false });
        stages.push({ stage: "resource_status", status: "timeout", trace_id });
        return finish({ trace_id, task_id: task.task_id, policy_decision: null, resource_status: null, stages, receipt, elapsed_ms: Date.now() - startedAt });
      }
      const resource = resourceResult.value;
      const resourceError = validateResourceStatus(resource);
      if (resourceError) {
        const receipt = makeFailure(task, "FAILED", "INVALID_RESOURCE_STATUS", resourceError);
        stages.push({ stage: "resource_status", status: "invalid", trace_id, error: resourceError });
        return finish({ trace_id, task_id: task.task_id, policy_decision: null, resource_status: resource ?? null, stages, receipt, elapsed_ms: Date.now() - startedAt });
      }

      const resourceSelection = selectResource(task, resource);
      stages.push({ stage: "resource_selection", status: resourceSelection.ok ? "ok" : "failed", trace_id, ...resourceSelection });
      if (!resourceSelection.ok) {
        const receipt = makeFailure(task, "RETRYABLE", resourceSelection.reason, "当前没有满足要求的执行节点", {
          resource_id: resource.node_id,
        });
        stages.push({ stage: "device_manager", status: "skipped", trace_id });
        return finish({ trace_id, task_id: task.task_id, policy_decision: null, resource_status: resource, stages, receipt, elapsed_ms: Date.now() - startedAt });
      }

      let policyResult;
      try {
        policyResult = await settleWithin(() => getPolicyDecision({ task, device, resource }), timeoutMs.policy);
      } catch {
        const receipt = makeFailure(task, "FAILED", "POLICY_DECISION_ERROR", "PolicyDecision 接口调用失败");
        stages.push({ stage: "policy_decision", status: "failed", trace_id });
        return finish({ trace_id, task_id: task.task_id, policy_decision: null, resource_status: resource, stages, receipt, elapsed_ms: Date.now() - startedAt });
      }
      if (policyResult.timedOut) {
        const receipt = makeFailure(task, "TIMEOUT", "POLICY_DECISION_TIMEOUT", "PolicyDecision 接口超时", { side_effects_unknown: false });
        stages.push({ stage: "policy_decision", status: "timeout", trace_id });
        return finish({ trace_id, task_id: task.task_id, policy_decision: null, resource_status: resource, stages, receipt, elapsed_ms: Date.now() - startedAt });
      }
      const policyDecision = policyResult.value;
      const policyError = validatePolicyDecision(policyDecision, task);
      if (policyError) {
        const receipt = makeFailure(task, "DENIED", "INVALID_POLICY_DECISION", policyError);
        stages.push({ stage: "policy_decision", status: "invalid", trace_id, error: policyError });
        return finish({ trace_id, task_id: task.task_id, policy_decision: policyDecision ?? null, resource_status: resource, stages, receipt, elapsed_ms: Date.now() - startedAt });
      }
      stages.push({ stage: "policy_decision", status: policyDecision.decision.toLowerCase(), trace_id, decision_id: policyDecision.decision_id });
      let executionResult;
      try {
        executionResult = await settleWithin(() => executeTask({ ...task, policy_decision: policyDecision }), timeoutMs.execution);
      } catch {
        const receipt = makeFailure(task, "FAILED", "DEVICE_MANAGER_ERROR", "设备管家接口调用失败", { side_effects_unknown: true });
        stages.push({ stage: "device_manager", status: "failed", trace_id });
        return finish({ trace_id, task_id: task.task_id, policy_decision: policyDecision, resource_status: resource, stages, receipt, elapsed_ms: Date.now() - startedAt });
      }
      if (executionResult.timedOut) {
        const receipt = makeFailure(task, "TIMEOUT", "DEVICE_MANAGER_TIMEOUT", "设备管家接口超时；设备副作用状态未知", { side_effects_unknown: true });
        stages.push({ stage: "device_manager", status: "timeout", trace_id });
        return finish({ trace_id, task_id: task.task_id, policy_decision: policyDecision, resource_status: resource, stages, receipt, elapsed_ms: Date.now() - startedAt });
      }
      const receipt = executionResult.value;
      const receiptError = validateReceipt(receipt, task);
      if (receiptError) {
        const invalidReceipt = makeFailure(task, "FAILED", "INVALID_TASK_RECEIPT", receiptError, { side_effects_unknown: true });
        stages.push({ stage: "device_manager", status: "invalid_receipt", trace_id, error: receiptError });
        return finish({ trace_id, task_id: task.task_id, policy_decision: policyDecision, resource_status: resource, stages, receipt: invalidReceipt, elapsed_ms: Date.now() - startedAt });
      }
      stages.push({ stage: "device_manager", status: receipt.status.toLowerCase(), trace_id });
      stages.push({ stage: "receipt", status: receipt.status.toLowerCase(), trace_id });

      return finish({
        trace_id,
        task_id: task.task_id,
        policy_decision: policyDecision,
        resource_status: resource,
        stages,
        receipt,
        elapsed_ms: Date.now() - startedAt,
      });
    },
  };
}
