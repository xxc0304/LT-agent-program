import { createDeviceToolRuntime } from "./tools.js";

const CONTRACT_VERSION = "0.1";
const ACTION_RESULT_VERSION = "1.0";
const TARGET_AGENT = "device-manager";
const TASK_TYPES = new Set(["control_device", "get_state", "run_scene", "diagnose_device"]);
const PRIORITIES = new Set(["low", "normal", "high", "critical"]);
const PRIVACY_LEVELS = new Set(["family", "sensitive", "restricted"]);
const CANONICAL_PRIORITIES = new Set(["P0", "P1", "P2", "P3", "P4"]);
const DATA_LEVELS = new Set(["L0", "L1", "L2", "L3"]);

function now() {
  return new Date().toISOString();
}

function errorReceipt(task, status, code, message, startedAt, details = {}) {
  return {
    schema_version: CONTRACT_VERSION,
    task_id: task?.task_id ?? "unknown",
    target_agent: TARGET_AGENT,
    status,
    completed_at: now(),
    trace_id: task?.trace_id,
    result: {},
    error: { code, message, ...details },
    elapsed_ms: Date.now() - startedAt,
  };
}

function validateTask(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) return "任务必须是 JSON 对象";
  const required = [
    "schema_version",
    "task_id",
    "source_agent",
    "target_agent",
    "task_type",
    "priority",
    "deadline_ms",
    "resource_requirement",
    "privacy_level",
    "payload",
  ];
  const missing = required.find((field) => task[field] === undefined);
  if (missing) return `缺少必填字段：${missing}`;
  if (task.schema_version !== CONTRACT_VERSION) return `不支持的 schema_version：${task.schema_version}`;
  if (typeof task.task_id !== "string" || !task.task_id) return "task_id 必须是非空字符串";
  if (typeof task.source_agent !== "string" || !task.source_agent) return "source_agent 必须是非空字符串";
  if (task.target_agent !== TARGET_AGENT) return `target_agent 必须是 ${TARGET_AGENT}`;
  if (!TASK_TYPES.has(task.task_type)) return `不支持的 task_type：${task.task_type}`;
  if (!PRIORITIES.has(task.priority)) return `不支持的 priority：${task.priority}`;
  if (!Number.isInteger(task.deadline_ms) || task.deadline_ms < 0) return "deadline_ms 必须是非负整数";
  if (!task.resource_requirement || typeof task.resource_requirement !== "object") return "resource_requirement 必须是 JSON 对象";
  if (!["local", "edge", "cloud"].includes(task.resource_requirement.execution_mode)) return "resource_requirement.execution_mode 不合法";
  if (!PRIVACY_LEVELS.has(task.privacy_level)) return `不支持的 privacy_level：${task.privacy_level}`;
  if (!task.payload || typeof task.payload !== "object" || Array.isArray(task.payload)) return "payload 必须是 JSON 对象";
  return null;
}

function isCanonicalTask(task) {
  return task?.task_type === "device_action" || task?.target_ref?.device_id !== undefined;
}

function validateCanonicalTask(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) return "任务必须是 JSON 对象";
  const required = ["task_id", "target", "target_ref", "action", "priority", "deadline_ms", "data_level", "idempotency_key", "trace_id"];
  const missing = required.find((field) => task[field] === undefined);
  if (missing) return `缺少必填字段：${missing}`;
  if (task.task_type !== "device_action") return "canonical Task 的 task_type 必须是 device_action";
  if (![TARGET_AGENT, "device_manager"].includes(task.target)) return "target 必须是 device-manager";
  if (!task.target_ref || typeof task.target_ref !== "object" || typeof task.target_ref.device_id !== "string") {
    return "target_ref.device_id 必须是非空字符串";
  }
  if (typeof task.action !== "string" || !task.action) return "action 必须是非空字符串";
  if (task.parameters !== undefined && (!task.parameters || typeof task.parameters !== "object" || Array.isArray(task.parameters))) {
    return "parameters 必须是 JSON 对象";
  }
  if (!CANONICAL_PRIORITIES.has(task.priority)) return `不支持的 priority：${task.priority}`;
  if (!Number.isInteger(task.deadline_ms) || task.deadline_ms < 0) return "deadline_ms 必须是非负整数";
  if (!DATA_LEVELS.has(task.data_level)) return `不支持的 data_level：${task.data_level}`;
  if (typeof task.idempotency_key !== "string" || !task.idempotency_key) return "idempotency_key 必须是非空字符串";
  if (typeof task.trace_id !== "string" || !task.trace_id) return "trace_id 必须是非空字符串";
  if (task.policy_decision && !["ALLOW", "DENY", "CHALLENGE"].includes(task.policy_decision.decision)) {
    return "policy_decision.decision 必须是 ALLOW、DENY 或 CHALLENGE";
  }
  return null;
}

function canonicalPriorityToLegacy(priority) {
  return { P0: "critical", P1: "high", P2: "normal", P3: "low", P4: "low" }[priority];
}

function dataLevelToPrivacy(level) {
  return { L0: "family", L1: "family", L2: "sensitive", L3: "restricted" }[level];
}

function canonicalToLegacyTask(task) {
  const source = typeof task.source === "string" ? task.source : task.source?.id;
  const decisionAllows = task.policy_decision?.decision === "ALLOW";
  return {
    schema_version: CONTRACT_VERSION,
    task_id: task.task_id,
    source_agent: source || "canonical-orchestrator",
    target_agent: TARGET_AGENT,
    task_type: "control_device",
    priority: canonicalPriorityToLegacy(task.priority),
    deadline_ms: task.deadline_ms,
    resource_requirement: {
      execution_mode: task.compute_requirement?.class === "cloud" ? "cloud" : "local",
      capabilities: task.compute_requirement?.class ? [task.compute_requirement.class] : [],
    },
    privacy_level: dataLevelToPrivacy(task.data_level),
    trace_id: task.trace_id,
    payload: {
      device_id: task.target_ref.device_id,
      action: task.action,
      parameters: task.parameters ?? {},
      confirmed: task.confirmed === true || decisionAllows,
      task_id: task.task_id,
      trace_id: task.trace_id,
      idempotency_key: task.idempotency_key,
    },
  };
}

function resultFor(task, result, elapsedMs) {
  if (task.task_type === "control_device") {
    return {
      device_id: result.device_id,
      action: result.action,
      old_state: result.old_state,
      new_state: result.new_state,
      verified: Boolean(result.verified),
      elapsed_ms: elapsedMs,
    };
  }
  return { data: result, elapsed_ms: elapsedMs };
}

function policyFailure(task, startedAt) {
  const decision = task.policy_decision?.decision;
  if (decision === "DENY") {
    return errorReceipt(task, "DENIED", "POLICY_DENIED", task.policy_decision.reason_message ?? "安全策略拒绝执行", startedAt, {
      decision_id: task.policy_decision.decision_id,
    });
  }
  if (decision === "CHALLENGE") {
    return errorReceipt(task, "CHALLENGE", "CONFIRMATION_REQUIRED", task.policy_decision.reason_message ?? "需要用户确认后才能执行", startedAt, {
      decision_id: task.policy_decision.decision_id,
    });
  }
  return null;
}

function withCanonicalActionResult(receipt, task) {
  if (receipt.status !== "SUCCEEDED") return receipt;
  const legacyResult = receipt.result;
  return {
    ...receipt,
    result: {
      ...legacyResult,
      action_result: {
        schema_version: ACTION_RESULT_VERSION,
        action_id: `${task.task_id}:action`,
        task_id: task.task_id,
        policy_decision_id: task.policy_decision?.decision_id ?? task.policy_decision_id ?? null,
        trace_id: task.trace_id,
        idempotency_key: task.idempotency_key,
        device_id: task.target_ref.device_id,
        action: task.action,
        parameters: task.parameters ?? {},
        status: "success",
        result: {
          old_state: legacyResult.old_state,
          new_state: legacyResult.new_state,
          verified: legacyResult.verified,
        },
        executed_at: receipt.completed_at,
        device_acknowledged: Boolean(legacyResult.verified),
        error: null,
      },
    },
  };
}

/**
 * Public-contract consumer for the device-manager Agent.
 * It accepts the original v0.1 Task shape and the newer device_action shape
 * used by the shared Demo plan. Internal tools remain implementation details.
 */
export function createDeviceTaskRuntime(deviceRuntime = createDeviceToolRuntime()) {
  const completedByIdempotencyKey = new Map();

  async function executeLegacy(task) {
    const startedAt = Date.now();
    const validationError = validateTask(task);
    if (validationError) {
      return errorReceipt(task, "FAILED", "INVALID_TASK", validationError, startedAt);
    }

    let result;
    try {
      result = await deviceRuntime.invoke(task.task_type, task.payload);
    } catch (error) {
      return errorReceipt(task, "RETRYABLE", "TOOL_EXECUTION_ERROR", "设备工具执行异常，请稍后重试", startedAt);
    }

    const elapsedMs = Date.now() - startedAt;
    if (!result?.success) {
      const error = result?.error ?? { code: "TASK_FAILED", message: "设备工具执行失败" };
      return errorReceipt(
        task,
        error.code === "CONFIRMATION_REQUIRED" ? "CHALLENGE" : "FAILED",
        error.code,
        error.message,
        startedAt,
      );
    }

    let verified = true;
    if (task.task_type === "control_device") {
      const state = await deviceRuntime.invoke("get_state", { device_id: result.device_id });
      verified = Boolean(result.verified && state?.success && state.device?.state === result.new_state);
      if (!verified) {
        return errorReceipt(task, "RETRYABLE", "POST_ACTION_VERIFICATION_FAILED", "设备控制后状态回读未通过", startedAt);
      }
    }

    return {
      schema_version: CONTRACT_VERSION,
      task_id: task.task_id,
      target_agent: TARGET_AGENT,
      status: "SUCCEEDED",
      completed_at: now(),
      trace_id: task.trace_id,
      result: resultFor(task, { ...result, verified }, elapsedMs),
      audit_ref: `${TARGET_AGENT}-audit-${deviceRuntime.homeAssistant?.getAuditLog?.().length ?? 0}`,
      elapsed_ms: elapsedMs,
    };
  }

  async function executeCanonical(task) {
    const startedAt = Date.now();
    const validationError = validateCanonicalTask(task);
    if (validationError) return errorReceipt(task, "FAILED", "INVALID_TASK", validationError, startedAt);

    const policyError = policyFailure(task, startedAt);
    if (policyError) return policyError;

    const previous = completedByIdempotencyKey.get(task.idempotency_key);
    if (previous) {
      return {
        ...previous,
        result: { ...previous.result, deduplicated: true },
      };
    }

    const receipt = withCanonicalActionResult(await executeLegacy(canonicalToLegacyTask(task)), task);
    if (["SUCCEEDED", "DENIED"].includes(receipt.status)) {
      completedByIdempotencyKey.set(task.idempotency_key, receipt);
    }
    return receipt;
  }

  return {
    async execute(task) {
      return isCanonicalTask(task) ? executeCanonical(task) : executeLegacy(task);
    },
  };
}
