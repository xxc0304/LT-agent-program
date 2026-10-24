import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const STORE_SCHEMA_VERSION = 1;
const DEFAULT_IDEMPOTENCY_TTL_MS = 5 * 60_000;
const STORED_STATUSES = new Set([
  "WAITING_FOR_APPROVAL",
  "APPROVING",
  "REJECTING",
  "EXECUTING",
  "RECOVERY_REQUIRED",
  "EXECUTION_UNCERTAIN",
  "COMPLETED",
  "EXECUTION_FAILED",
  "DENIED_AFTER_RECHECK",
  "PLAN_REVISION_REQUIRED",
  "REJECTED",
  "EXPIRED_NO_ACTION",
]);

function clone(value) {
  return structuredClone(value);
}

function safeString(value, fallback = "") {
  return typeof value === "string" ? value.slice(0, 500) : fallback;
}

function safeAction(step) {
  const action = step?.action;
  const deviceId = action?.target_ref?.device_id;
  const name = action?.name ?? action?.action;
  if (typeof name !== "string" || typeof deviceId !== "string") return undefined;

  const parameters = {};
  const allowedParameter = new Map([
    ["set_temperature", ["temperature"]],
    ["set_brightness", ["brightness"]],
    ["set_position", ["position"]],
  ]).get(name) ?? [];
  for (const key of allowedParameter) {
    const value = action.parameters?.[key];
    if (typeof value === "number" && Number.isFinite(value)) parameters[key] = value;
  }

  return {
    name: name.slice(0, 80),
    target_ref: { device_id: deviceId.slice(0, 255) },
    ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
  };
}

function summarizePlan(plan) {
  return (Array.isArray(plan?.steps) ? plan.steps : []).slice(0, 12).map((step, index) => {
    const action = safeAction(step);
    return {
      step_id: safeString(step?.step_id, `step-${index + 1}`),
      agent_id: safeString(step?.agent_id),
      capability: safeString(step?.capability),
      ...(action ? { action } : {}),
    };
  });
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function validateRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)
    || typeof record.approval_id !== "string" || !record.approval_id
    || typeof record.plan_id !== "string" || !record.plan_id
    || typeof record.plan_fingerprint !== "string" || !record.plan_fingerprint
    || !STORED_STATUSES.has(record.status)
    || !Number.isSafeInteger(record.created_at_ms)
    || !Number.isSafeInteger(record.expires_at_ms)
    || !Number.isSafeInteger(record.idempotency_expires_at_ms)
    || !Number.isSafeInteger(record.updated_at_ms)
    || typeof record.source !== "string"
    || record.approval_id.length > 255
    || record.plan_id.length > 500
    || record.plan_fingerprint.length > 500
    || record.source.length > 80
    || !hasOnlyKeys(record, new Set([
      "approval_id",
      "plan_id",
      "plan_fingerprint",
      "status",
      "source",
      "created_at_ms",
      "expires_at_ms",
      "idempotency_expires_at_ms",
      "updated_at_ms",
      "steps",
    ]))
    || !Array.isArray(record.steps)
    || record.steps.length > 12) {
    throw new Error("Agent 确认状态文件格式无效；为避免重复执行，已停止加载");
  }
  for (const step of record.steps) {
    if (!step || typeof step.step_id !== "string"
      || typeof step.agent_id !== "string"
      || typeof step.capability !== "string"
      || !hasOnlyKeys(step, new Set(["step_id", "agent_id", "capability", "action"]))) {
      throw new Error("Agent 确认状态文件包含无效步骤；为避免重复执行，已停止加载");
    }
    if (step.action) {
      const expectedParameters = new Map([
        ["set_temperature", ["temperature"]],
        ["set_brightness", ["brightness"]],
        ["set_position", ["position"]],
      ]).get(step.action.name) ?? [];
      if (typeof step.action.name !== "string"
        || typeof step.action.target_ref?.device_id !== "string"
        || !hasOnlyKeys(step.action, new Set(["name", "target_ref", "parameters"]))
        || !hasOnlyKeys(step.action.target_ref, new Set(["device_id"]))
        || (step.action.parameters !== undefined
          && (!step.action.parameters || typeof step.action.parameters !== "object"
            || Array.isArray(step.action.parameters)
            || !hasOnlyKeys(step.action.parameters, new Set(expectedParameters))
            || Object.values(step.action.parameters).some((value) => typeof value !== "number" || !Number.isFinite(value))))) {
        throw new Error("Agent 确认状态文件包含无效设备动作；为避免重复执行，已停止加载");
      }
    }
  }
  return clone(record);
}

function recoverRecord(record, now) {
  const recovered = clone(record);
  if (record.status === "EXECUTING") {
    recovered.status = "EXECUTION_UNCERTAIN";
  } else if (record.status === "EXECUTION_FAILED") {
    recovered.status = "EXECUTION_UNCERTAIN";
  } else if (["WAITING_FOR_APPROVAL", "APPROVING", "REJECTING"].includes(record.status)) {
    recovered.status = record.expires_at_ms <= now
      ? "EXPIRED_NO_ACTION"
      : "RECOVERY_REQUIRED";
  }
  return recovered;
}

/**
 * Minimal, fail-closed persistence for confirmation/idempotency metadata.
 * It intentionally never stores plan inputs, chat text, evidence, device
 * state, tool results, credentials, or arbitrary action parameters.
 */
export class AgentApprovalStateStore {
  constructor({
    filePath = resolveAgentApprovalStatePath(),
    clock = () => Date.now(),
    idempotencyTtlMs = DEFAULT_IDEMPOTENCY_TTL_MS,
  } = {}) {
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new Error("AgentApprovalStateStore 需要有效的 filePath");
    }
    if (typeof clock !== "function") throw new Error("AgentApprovalStateStore clock 必须是函数");
    if (!Number.isSafeInteger(idempotencyTtlMs) || idempotencyTtlMs <= 0) {
      throw new Error("idempotencyTtlMs 必须是正整数");
    }
    this.filePath = resolve(filePath);
    this.clock = clock;
    this.idempotencyTtlMs = idempotencyTtlMs;
    this.records = new Map();
    this.#load();
  }

  #load() {
    if (!existsSync(this.filePath)) return;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      throw new Error("Agent 确认状态文件无法解析；为避免重复执行，已停止加载");
    }
    if (!parsed || typeof parsed !== "object"
      || parsed.schema_version !== STORE_SCHEMA_VERSION
      || !Number.isSafeInteger(parsed.updated_at_ms)
      || !Array.isArray(parsed.records)
      || !hasOnlyKeys(parsed, new Set(["schema_version", "updated_at_ms", "records"]))) {
      throw new Error("Agent 确认状态文件版本或结构无效；为避免重复执行，已停止加载");
    }

    const now = this.clock();
    for (const value of parsed.records) {
      const recovered = recoverRecord(validateRecord(value), now);
      if (recovered.idempotency_expires_at_ms <= now
        && recovered.status !== "EXECUTION_UNCERTAIN") continue;
      const previous = this.records.get(recovered.approval_id);
      if (previous) throw new Error("Agent 确认状态文件包含重复 approval_id；为避免重复执行，已停止加载");
      this.records.set(recovered.approval_id, recovered);
    }
  }

  list() {
    return [...this.records.values()].map(clone);
  }

  get(approvalId) {
    const record = this.records.get(approvalId);
    return record ? clone(record) : null;
  }

  recordWorkflowState({ approval_id, status, plan, plan_fingerprint, created_at_ms, expires_at_ms }, source = "unknown") {
    if (typeof approval_id !== "string" || !approval_id
      || !STORED_STATUSES.has(status)
      || typeof plan_fingerprint !== "string" || !plan_fingerprint
      || !Number.isSafeInteger(created_at_ms)
      || !Number.isSafeInteger(expires_at_ms)) {
      throw new Error("拒绝写入无效的 Agent 确认状态");
    }
    const existing = this.records.get(approval_id);
    const record = {
      approval_id,
      plan_id: safeString(plan?.plan_id),
      plan_fingerprint,
      status,
      source: safeString(source, "unknown"),
      created_at_ms,
      expires_at_ms,
      idempotency_expires_at_ms: existing?.idempotency_expires_at_ms
        ?? Math.max(expires_at_ms, created_at_ms + this.idempotencyTtlMs),
      updated_at_ms: this.clock(),
      steps: summarizePlan(plan),
    };
    validateRecord(record);
    this.records.set(approval_id, record);
    try {
      this.#save();
    } catch (error) {
      if (existing) this.records.set(approval_id, existing);
      else this.records.delete(approval_id);
      throw error;
    }
    return clone(record);
  }

  remove(approvalId) {
    const previous = this.records.get(approvalId);
    if (!previous) return false;
    this.records.delete(approvalId);
    try {
      this.#save();
    } catch (error) {
      this.records.set(approvalId, previous);
      throw error;
    }
    return true;
  }

  #save() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const now = this.clock();
    const records = [...this.records.values()].filter((record) =>
      record.idempotency_expires_at_ms > now || record.status === "EXECUTION_UNCERTAIN");
    const contents = `${JSON.stringify({
      schema_version: STORE_SCHEMA_VERSION,
      updated_at_ms: now,
      records,
    }, null, 2)}\n`;
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try { unlinkSync(temporaryPath); } catch {}
      throw new Error(`Agent 确认状态无法安全原子写入；当前操作已停止：${error?.code ?? "WRITE_FAILED"}`);
    }
  }
}

export function resolveAgentApprovalStatePath(env = process.env) {
  if (typeof env.DEVICE_MANAGER_APPROVAL_STATE_PATH === "string"
    && env.DEVICE_MANAGER_APPROVAL_STATE_PATH.trim()) {
    return resolve(env.DEVICE_MANAGER_APPROVAL_STATE_PATH.trim());
  }
  const stateDir = typeof env.OPENCLAW_STATE_DIR === "string" && env.OPENCLAW_STATE_DIR.trim()
    ? resolve(env.OPENCLAW_STATE_DIR.trim())
    : join(homedir(), ".openclaw");
  return join(stateDir, "device-manager", "agent-approval-state.json");
}
