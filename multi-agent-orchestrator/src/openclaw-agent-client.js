import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { normalizeTaskAliases } from "../../common-contracts/task-compat.mjs";
import { validateAgainstSchema, validateTaskAliases } from "../../common-contracts/schema-validator.mjs";
import { planEnergyOptimization } from "../../energy-saving/src/energy-optimization.js";
import { validateTask } from "./scheduler.js";

const EVENT_SCHEMA = JSON.parse(readFileSync(new URL("../../common-contracts/schemas/event.schema.json", import.meta.url), "utf8"));
const TASK_SCHEMA = JSON.parse(readFileSync(new URL("../../common-contracts/schemas/task.schema.json", import.meta.url), "utf8"));

const AGENT_OUTPUTS = Object.freeze({
  "learning-companion": Object.freeze({ operation: "produce_learning_event", contract: "event" }),
  "energy-saving": Object.freeze({ operation: "produce_device_task", contract: "task" }),
});

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024;
const FORBIDDEN_INPUT_KEYS = new Set([
  "apikey",
  "authorization",
  "accesstoken",
  "password",
  "secret",
  "token",
  "image",
  "imageurl",
  "imagedata",
  "video",
  "videourl",
  "videodata",
  "base64",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function findForbiddenInputKey(value, path = "input") {
  if (!value || typeof value !== "object") return null;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll(/[-_]/g, "");
    if (FORBIDDEN_INPUT_KEYS.has(normalized)) return `${path}.${key}`;
    const nestedPath = findForbiddenInputKey(nested, `${path}.${key}`);
    if (nestedPath) return nestedPath;
  }
  return null;
}

function clone(value) {
  return structuredClone(value);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export class OpenClawAgentCallError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "OpenClawAgentCallError";
    this.code = code;
    this.details = details;
  }
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new OpenClawAgentCallError("INVALID_AGENT_REQUEST", `${field} 必须是非空字符串`);
  }
  return value.trim();
}

function parseAgentOutput(result, { agentId, contract, traceId, input, maxMessageBytes }) {
  if (!isRecord(result) || typeof result.status !== "string") {
    throw new OpenClawAgentCallError("INVALID_SESSIONS_SEND_RESULT", "OpenClaw sessions_send 返回格式无效");
  }
  if (result.status !== "ok") {
    const code = result.status === "timeout" ? "AGENT_REPLY_TIMEOUT"
      : result.status === "forbidden" ? "AGENT_CALL_FORBIDDEN"
        : result.status === "accepted" ? "AGENT_REPLY_PENDING"
          : "AGENT_CALL_FAILED";
    throw new OpenClawAgentCallError(code, `OpenClaw Agent 调用未完成：${result.status}`, {
      sent_before_error: result.sentBeforeError === true,
    });
  }
  if (typeof result.reply !== "string") {
    throw new OpenClawAgentCallError("INVALID_AGENT_REPLY", "Agent 必须返回 JSON 文本");
  }
  if (Buffer.byteLength(result.reply, "utf8") > maxMessageBytes) {
    throw new OpenClawAgentCallError("AGENT_REPLY_TOO_LARGE", "Agent 回复超过配置的大小上限");
  }

  let output;
  try {
    output = JSON.parse(result.reply);
  } catch {
    throw new OpenClawAgentCallError("AGENT_REPLY_NOT_JSON", "Agent 回复不是严格 JSON；不接受 Markdown 包裹或额外说明文字");
  }
  if (!isRecord(output)) {
    throw new OpenClawAgentCallError("AGENT_REPLY_NOT_OBJECT", "Agent 回复必须是 JSON 对象");
  }

  if (contract === "event") {
    const errors = validateAgainstSchema(output, EVENT_SCHEMA);
    if (output.source_agent !== agentId) errors.push("source_agent 必须与实际被调用的 Agent ID 一致");
    if (output.trace_id !== traceId) errors.push("trace_id 必须与本次编排请求一致");
    if (errors.length > 0) {
      throw new OpenClawAgentCallError("INVALID_AGENT_EVENT", "学习伴学 Agent 输出未通过 Event 契约校验", { errors });
    }
    return output;
  }

  if (contract === "energy_optimization") {
    if (agentId !== "energy-saving") {
      throw new OpenClawAgentCallError("INVALID_AGENT_OPTIMIZATION", "只有能源管家可以返回能耗优化报告");
    }
    if (!isRecord(input) || !Number.isFinite(input.evaluation_time_ms)) {
      throw new OpenClawAgentCallError("INVALID_AGENT_REQUEST", "能源优化委派必须包含适配器注入的评估时刻");
    }
    let expected;
    try {
      expected = planEnergyOptimization({ ...input, now: input.evaluation_time_ms });
    } catch (error) {
      throw new OpenClawAgentCallError(
        "ENERGY_OPTIMIZATION_INPUT_INVALID",
        error instanceof Error ? error.message : "能源优化输入无效",
      );
    }
    if (stableStringify(output) !== stableStringify(expected)) {
      throw new OpenClawAgentCallError(
        "INVALID_AGENT_OPTIMIZATION",
        "能源管家报告未与确定性计算结果完全一致；设备管家拒绝使用该报告",
      );
    }
    return expected;
  }

  // A no-op is a normal energy-agent decision, not a malformed Task. Keep the
  // shape deliberately small so the model cannot smuggle a policy decision or
  // an explanation that downstream code might mistake for an executable Task.
  if (output.outcome === "NO_ACTION") {
    if (contract !== "task" || agentId !== "energy-saving") {
      throw new OpenClawAgentCallError("INVALID_AGENT_NO_ACTION", "只有能源管家可以返回 NO_ACTION 结果");
    }
    const allowedKeys = new Set(["schema_version", "outcome", "source_agent", "trace_id", "reason_code"]);
    const errors = [];
    if (Object.keys(output).some((key) => !allowedKeys.has(key))) errors.push("NO_ACTION 结果包含未允许字段");
    if (output.schema_version !== "0.1") errors.push("NO_ACTION.schema_version 必须为 0.1");
    if (output.source_agent !== agentId) errors.push("source_agent 必须与实际被调用的 Agent ID 一致");
    if (output.trace_id !== traceId) errors.push("trace_id 必须与本次编排请求一致");
    if (typeof output.reason_code !== "string" || !output.reason_code.trim()) errors.push("reason_code 必须是非空字符串");
    if (errors.length > 0) {
      throw new OpenClawAgentCallError("INVALID_AGENT_NO_ACTION", "能源管家的 NO_ACTION 结果未通过契约校验", { errors });
    }
    return output;
  }

  if (Object.hasOwn(output, "policy_decision")) {
    throw new OpenClawAgentCallError("AGENT_POLICY_DECISION_FORBIDDEN", "业务 Agent 不得自行写入策略审批结果");
  }
  const aliasErrors = validateTaskAliases(output);
  if (aliasErrors.length > 0) {
    throw new OpenClawAgentCallError("INVALID_AGENT_TASK", "能源管家输出的 Task 别名冲突", { errors: aliasErrors });
  }
  const normalized = normalizeTaskAliases(output, { requireSource: true });
  if (normalized.error) {
    throw new OpenClawAgentCallError("INVALID_AGENT_TASK", "能源管家输出未通过 Task 契约校验", { errors: [normalized.error] });
  }
  const task = normalized.task;
  const errors = validateAgainstSchema(task, TASK_SCHEMA);
  const schedulerError = validateTask(task);
  if (schedulerError) errors.push(schedulerError);
  if (task.source_agent !== agentId) errors.push("source_agent 必须为 energy-saving");
  if (task.target_agent !== "device-manager") errors.push("target_agent 必须为 device-manager");
  if (task.trace_id !== traceId) errors.push("trace_id 必须与本次编排请求一致");
  if (errors.length > 0) {
    throw new OpenClawAgentCallError("INVALID_AGENT_TASK", "能源管家输出未通过 Task 契约校验", { errors });
  }
  return task;
}

/**
 * Validates the boundary around OpenClaw's synchronous `sessions_send` tool.
 * `sendMessage` is injected so tests can use a fake Gateway and production
 * wiring can use an approved OpenClaw transport without embedding credentials.
 */
export class OpenClawAgentClient {
  constructor({
    sendMessage,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
    maxRememberedRequests = 500,
  } = {}) {
    if (typeof sendMessage !== "function") throw new Error("sendMessage 必须是 sessions_send transport 函数");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new Error("timeoutMs 必须是 1 到 120000 毫秒之间的整数");
    }
    if (!Number.isInteger(maxMessageBytes) || maxMessageBytes < 256) {
      throw new Error("maxMessageBytes 必须是至少 256 字节的整数");
    }
    if (!Number.isInteger(maxRememberedRequests) || maxRememberedRequests < 1) {
      throw new Error("maxRememberedRequests 必须是正整数");
    }
    this.sendMessage = sendMessage;
    this.timeoutMs = timeoutMs;
    this.maxMessageBytes = maxMessageBytes;
    this.maxRememberedRequests = maxRememberedRequests;
    this.requests = new Map();
  }

  invoke({ agentId, operation, contract, traceId, idempotencyKey, input, timeoutMs = this.timeoutMs } = {}) {
    const targetAgentId = requireNonEmptyString(agentId, "agentId");
    const normalizedTraceId = requireNonEmptyString(traceId, "traceId");
    const requestKey = requireNonEmptyString(idempotencyKey, "idempotencyKey");
    const registeredAgentSpec = AGENT_OUTPUTS[targetAgentId];
    if (!registeredAgentSpec) {
      throw new OpenClawAgentCallError("AGENT_NOT_ALLOWED", `不允许通过此适配器调用 Agent：${targetAgentId}`);
    }
    const energyOptimizationOperation = targetAgentId === "energy-saving"
      && operation === "plan_energy_optimization"
      && contract === "energy_optimization";
    const agentSpec = energyOptimizationOperation
      ? { operation, contract }
      : registeredAgentSpec;
    if ((operation !== undefined && operation !== agentSpec.operation)
      || (contract !== undefined && contract !== agentSpec.contract)) {
      throw new OpenClawAgentCallError("AGENT_OPERATION_NOT_ALLOWED", "此适配器不允许调用该 Agent 操作或输出契约");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new OpenClawAgentCallError("INVALID_AGENT_REQUEST", "timeoutMs 必须是 1 到 120000 毫秒之间的整数");
    }

    if (!isRecord(input)) {
      throw new OpenClawAgentCallError("INVALID_AGENT_REQUEST", "input 必须是 JSON 对象");
    }
    const forbiddenPath = findForbiddenInputKey(input);
    if (forbiddenPath) {
      throw new OpenClawAgentCallError("UNSAFE_AGENT_INPUT", `跨 Agent 输入不得包含认证信息或原始图片/视频字段：${forbiddenPath}`);
    }
    let clonedInput;
    try {
      clonedInput = JSON.parse(JSON.stringify(input));
    } catch {
      throw new OpenClawAgentCallError("INVALID_AGENT_REQUEST", "input 必须能被 JSON 序列化");
    }
    const requestFingerprint = fingerprint({
      agentId: targetAgentId,
      operation: agentSpec.operation,
      contract: agentSpec.contract,
      traceId: normalizedTraceId,
      input: clonedInput,
    });
    const existing = this.requests.get(requestKey);
    if (existing) {
      if (existing.fingerprint !== requestFingerprint) {
        throw new OpenClawAgentCallError("IDEMPOTENCY_KEY_CONFLICT", "同一 idempotencyKey 不可用于不同 Agent 请求");
      }
      return existing.promise.then(clone);
    }
    this.#makeRoomForRequest();

    const envelope = {
      protocol: "lt-agent-request/0.1",
      target_agent: targetAgentId,
      operation: agentSpec.operation,
      contract: agentSpec.contract,
      trace_id: normalizedTraceId,
      idempotency_key: requestKey,
      input: clonedInput,
      response_rule: agentSpec.contract === "energy_optimization"
        ? '处理能源优化委派时，必须调用本会话的 calculate_energy_optimization 工具一次，将请求 input 中的全部业务字段和 evaluation_time_ms 原样传给工具；不得自行估算、修改电价或设备候选。然后只返回该工具的完整 JSON 结果，不要增加字段、删字段、改值、输出 Markdown 或补充说明。不得查询或控制设备、创建计划、安装排程或声称动作已执行。'
        : agentSpec.contract === "task"
          ? '只返回一个符合 contract 的 JSON 对象：可执行候选时返回标准 Task；无需动作时仅返回字段为 schema_version、outcome、source_agent、trace_id、reason_code 的对象，其中 schema_version="0.1"、outcome="NO_ACTION"、source_agent="energy-saving"，并填写本请求的 trace_id 与非空 reason_code。不要 Markdown 或解释文字；不要执行设备动作或声明策略审批结果。'
          : '只返回一个裸的标准 Event JSON 对象，不要回显或包装本请求信封。顶层必需字段为 schema_version:"0.1"、event_id、source_agent:"learning-companion"、event_type:"learning_behavior"、occurred_at（ISO 8601）、privacy_level、payload（对象）和 trace_id（必须原样复制本请求 trace_id）。将观察内容放入 payload；occurred_at 必须来自 input.observation.observed_at 或 input.observation.occurred_at，不得伪造发生时间。若输入包含 confidence、needs_review 或 privacy_level，原样保留或采用更保守值，不得提高置信度、清除人工复核标记或降低隐私级别。不得把 protocol、target_agent、operation、contract、idempotency_key、producer_agent、input 或 observed_at 放在 Event 顶层。仅使用 common-contracts Event Schema 中定义的顶层字段；不要 Markdown、围栏或解释文字；不要执行设备动作或声明策略审批结果。',
    };
    const message = JSON.stringify(envelope);
    if (Buffer.byteLength(message, "utf8") > this.maxMessageBytes) {
      throw new OpenClawAgentCallError("AGENT_REQUEST_TOO_LARGE", "Agent 请求超过配置的大小上限");
    }

    const promise = this.#sendAndValidate({
      agentId: targetAgentId,
      traceId: normalizedTraceId,
      idempotencyKey: requestKey,
      contract: agentSpec.contract,
      input: clonedInput,
      message,
      timeoutMs,
    });
    const entry = { fingerprint: requestFingerprint, promise, settled: false };
    this.requests.set(requestKey, entry);
    void promise.then(() => { entry.settled = true; }, () => { entry.settled = true; });
    return promise.then(clone);
  }

  #makeRoomForRequest() {
    while (this.requests.size >= this.maxRememberedRequests) {
      const oldestSettledKey = [...this.requests.entries()].find(([, entry]) => entry.settled)?.[0];
      if (oldestSettledKey === undefined) {
        throw new OpenClawAgentCallError(
          "IDEMPOTENCY_CACHE_FULL",
          "幂等缓存已满且所有请求仍在处理中；为避免重复调用模型，本次请求被拒绝",
        );
      }
      this.requests.delete(oldestSettledKey);
    }
  }

  async #sendAndValidate({ agentId, traceId, idempotencyKey, contract, input, message, timeoutMs }) {
    let timer;
    const sendPromise = Promise.resolve().then(() => this.sendMessage({
      agentId,
      message,
      timeoutSeconds: Math.max(1, Math.ceil(timeoutMs / 1000)),
      idempotencyKey,
    }));
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new OpenClawAgentCallError(
        "AGENT_REPLY_TIMEOUT",
        "等待 OpenClaw Agent 返回结果超时；本地不会自动重试，以免重复请求模型",
      )), timeoutMs);
    });

    try {
      const raw = await Promise.race([sendPromise, timeoutPromise]);
      const output = parseAgentOutput(raw, {
        agentId,
        contract,
        traceId,
        input,
        maxMessageBytes: this.maxMessageBytes,
      });
      return {
        status: "ok",
        agent_id: agentId,
        trace_id: traceId,
        idempotency_key: idempotencyKey,
        output,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const OPENCLAW_AGENT_TARGETS = Object.freeze(Object.keys(AGENT_OUTPUTS));
