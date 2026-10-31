// LLM-backed planning/analysis Agents can need more than one model/tool turn.
// The OpenClaw public subagent API caps waits at 120 seconds, so use that
// available window by default and still fail closed without resending.
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024;
const FORBIDDEN_KEYS = new Set([
  "apikey", "authorization", "accesstoken", "password", "secret", "token",
  "image", "imageurl", "imagedata", "imagedataurl", "video", "videourl", "videodata", "base64",
]);
const RESPONSE_STATUSES = new Set([
  "COMPLETED", "PROPOSED", "NO_ACTION", "NEEDS_CLARIFICATION",
  "NEEDS_CONFIRMATION", "CONFLICT", "BLOCKED", "FAILED",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function mainKey(config) {
  const value = config?.session?.mainKey;
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : "main";
}

export function openClawAgentSessionKey(agentId, config) {
  return `agent:${requireText(agentId, "agentId")}:${mainKey(config)}`;
}

function assistantText(message) {
  if (!isRecord(message) || message.role !== "assistant") return null;
  if (typeof message.content === "string") return message.content.trim() || null;
  if (!Array.isArray(message.content)) return null;
  const text = message.content
    .filter((item) => isRecord(item) && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("")
    .trim();
  return text || null;
}

function latestAssistantSnapshot(history) {
  if (!Array.isArray(history?.messages)) return null;
  for (let index = history.messages.length - 1; index >= 0; index -= 1) {
    const message = history.messages[index];
    const text = assistantText(message);
    if (!text) continue;
    let fingerprint;
    try {
      fingerprint = JSON.stringify(message);
    } catch {
      fingerprint = text;
    }
    return { text, fingerprint, messageCount: history.messages.length };
  }
  return null;
}

function missingSessionError(error, sessionKey) {
  const messages = [error?.message, error?.details?.message, error?.error?.message]
    .filter((value) => typeof value === "string");
  const escaped = sessionKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`No session found:\\s*${escaped}$`, "i");
  return messages.some((message) => pattern.test(message.trim()));
}

function findForbiddenKey(value, path = "input") {
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll(/[-_]/g, "");
    if (FORBIDDEN_KEYS.has(normalized)) return `${path}.${key}`;
    const nested = findForbiddenKey(child, `${path}.${key}`);
    if (nested) return nested;
  }
  return null;
}

function hasCredentialText(value) {
  return /\b(?:api[_\s-]?key|access[_\s-]?token|password|secret|authorization)\s*[:=]\s*\S+|\bbearer\s+\S+|\bsk-[a-z0-9_-]{20,}|\bgh[pousr]_[a-z0-9]{20,}/i.test(value);
}

function errorWithCode(code, message, { sentBeforeError = false, cause } = {}) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  if (sentBeforeError) error.sentBeforeError = true;
  return error;
}

function parseAgentReply(reply, { agentId, traceId }) {
  if (typeof reply !== "string") throw errorWithCode("INVALID_AGENT_REPLY", "OpenClaw Agent did not return text");
  let output;
  try {
    output = JSON.parse(reply);
  } catch {
    throw errorWithCode("AGENT_REPLY_NOT_JSON", "Agent must return one plain JSON object; Markdown and extra prose are not accepted");
  }
  if (!isRecord(output) || !RESPONSE_STATUSES.has(output.status)) {
    throw errorWithCode("INVALID_AGENT_REPLY", "Agent reply must include a supported typed status");
  }
  if (output.source_agent !== agentId || output.trace_id !== traceId) {
    throw errorWithCode("INVALID_AGENT_REPLY_IDENTITY", "Agent reply source_agent or trace_id does not match the dispatched request");
  }
  if (typeof output.result !== "undefined" && !isRecord(output.result)) {
    throw errorWithCode("INVALID_AGENT_REPLY", "Agent result must be a JSON object when present");
  }
  if (["NEEDS_CLARIFICATION", "NEEDS_CONFIRMATION", "CONFLICT"].includes(output.status)
    && !(typeof output.question === "string" && output.question.trim())
    && !(typeof output.message === "string" && output.message.trim())) {
    throw errorWithCode("INVALID_AGENT_REPLY", "Clarification/confirmation replies must include a user-facing question");
  }
  return output;
}

function requestEnvelope(call) {
  const envelope = {
    protocol: "lt-platform-agent-task/0.1",
    target_agent: call.agentId,
    capability: call.capability,
    trace_id: call.traceId,
    step_id: call.stepId,
    task: call.task,
    user_request: call.originalRequest,
    input: call.input ?? {},
    dependency_results: call.dependencyResults ?? {},
    context: call.context ?? {},
    action: call.action ?? undefined,
    response_contract: {
      status: [...RESPONSE_STATUSES],
      source_agent: "must exactly match target_agent",
      trace_id: "must exactly match trace_id from this request",
      result: "optional JSON object",
      summary: "optional short string",
      question: "required for NEEDS_CLARIFICATION, NEEDS_CONFIRMATION, or CONFLICT",
      options: "optional array of user-facing choices",
    },
    instructions: [
      "只处理本次 capability 和 task，不要擅自调用未授权的其他 Agent。",
      "不得把分析建议当成设备操作授权；设备操作必须由设备管家自己的策略和确认流程决定。",
      "证据不足、目标不清、结果矛盾、存在冲突或需要用户决定时，返回 NEEDS_CLARIFICATION 或 NEEDS_CONFIRMATION，并用日常语言写清问题。",
      "遇到安全策略禁止、工具不可用或前置条件缺失时返回 BLOCKED，不要猜测或伪称成功。",
      "只输出一个符合 response_contract 的 JSON 对象；每种状态都必须填写 source_agent 和 trace_id；不要 Markdown、围栏或额外说明。",
    ],
  };
  return JSON.stringify(envelope);
}

/**
 * Adapter from the platform registry to OpenClaw's public runtime.subagent API.
 * Caller identity comes from the trusted tool factory context; plan arguments
 * can select only registered target Agent IDs. This transport has no HA API.
 */
export function createOpenClawPlatformAgentInvoker({
  subagentRun,
  subagentWaitForRun,
  subagentGetSessionMessages,
  requesterAgentId,
  requesterSessionKey,
  config,
  authorizeTarget,
  agentIds,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  historyLimit = DEFAULT_HISTORY_LIMIT,
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
} = {}) {
  if (typeof subagentRun !== "function"
    || typeof subagentWaitForRun !== "function"
    || typeof subagentGetSessionMessages !== "function") {
    throw new Error("OpenClaw runtime.subagent run, waitForRun, and getSessionMessages are required");
  }
  if (typeof authorizeTarget !== "function") throw new Error("authorizeTarget must enforce OpenClaw A2A/session visibility policy");
  const caller = requireText(requesterAgentId, "requesterAgentId");
  const callerSession = requireText(requesterSessionKey, "requesterSessionKey");
  if (!callerSession.startsWith(`agent:${caller}:`)) throw new Error("requesterSessionKey must belong to requesterAgentId");
  if (!Array.isArray(agentIds) || agentIds.length === 0 || agentIds.some((id) => typeof id !== "string" || !id.trim())) {
    throw new Error("agentIds must be the non-empty registered Agent allowlist");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("timeoutMs must be 1..120000");
  if (!Number.isInteger(historyLimit) || historyLimit < 1 || historyLimit > 500) throw new Error("historyLimit must be 1..500");
  if (!Number.isInteger(maxMessageBytes) || maxMessageBytes < 256) throw new Error("maxMessageBytes must be at least 256");

  const allowedTargets = new Set(agentIds);
  const agentTails = new Map();

  async function serializePerAgent(agentId, operation) {
    const previous = agentTails.get(agentId) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    agentTails.set(agentId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (agentTails.get(agentId) === queued) agentTails.delete(agentId);
    }
  }

  return async function invokeOpenClawAgent(call = {}) {
    const agentId = requireText(call.agentId, "agentId");
    requireText(call.capability, "capability");
    const task = requireText(call.task, "task");
    if (!allowedTargets.has(agentId)) throw errorWithCode("AGENT_NOT_REGISTERED", `Agent is not in the platform registry: ${agentId}`);
    if (agentId === caller) throw errorWithCode("SELF_AGENT_CALL_FORBIDDEN", "OpenClaw frontdoor cannot call itself as a sub-Agent");
    if (typeof call.traceId !== "string" || call.traceId.length > 128
      || typeof call.stepId !== "string" || !call.stepId.trim() || call.stepId.length > 128) {
      throw errorWithCode("INVALID_AGENT_REQUEST", "traceId and stepId are required and each must be at most 128 characters");
    }
    if (!isRecord(call.input ?? {}) || !isRecord(call.context ?? {}) || !isRecord(call.dependencyResults ?? {})
      || (call.action !== null && call.action !== undefined && !isRecord(call.action))) {
      throw errorWithCode("INVALID_AGENT_REQUEST", "Agent input, context, and dependency results must be JSON objects");
    }
    const forbiddenPath = findForbiddenKey({
      input: call.input ?? {},
      context: call.context ?? {},
      dependency_results: call.dependencyResults ?? {},
      action: call.action ?? {},
    });
    if (forbiddenPath) throw errorWithCode("UNSAFE_AGENT_INPUT", `Credential or raw media field is not allowed across Agent calls: ${forbiddenPath}`);
    if (hasCredentialText(`${task}\n${call.originalRequest ?? ""}`)) {
      throw errorWithCode("UNSAFE_AGENT_INPUT", "Request text appears to contain a credential; it was not forwarded to another Agent");
    }

    let message;
    try {
      message = requestEnvelope(call);
    } catch (error) {
      throw errorWithCode("INVALID_AGENT_REQUEST", "Agent request must be JSON serializable", { cause: error });
    }
    if (Buffer.byteLength(message, "utf8") > maxMessageBytes) {
      throw errorWithCode("AGENT_REQUEST_TOO_LARGE", "Agent request exceeds the configured byte limit");
    }

    return serializePerAgent(agentId, async () => {
      const targetSessionKey = openClawAgentSessionKey(agentId, config);
      let access;
      try {
        access = await authorizeTarget({
          requesterAgentId: caller,
          requesterSessionKey: callerSession,
          targetAgentId: agentId,
          targetSessionKey,
          action: "send",
        });
      } catch (error) {
        throw errorWithCode("AGENT_CALL_AUTHORIZATION_FAILED", "OpenClaw Agent-to-Agent authorization check failed", { cause: error });
      }
      if (access?.allowed !== true) {
        throw errorWithCode("AGENT_CALL_FORBIDDEN", access?.error ?? "OpenClaw A2A/session visibility policy denied this Agent call");
      }

      let baseline;
      try {
        baseline = latestAssistantSnapshot(await subagentGetSessionMessages({ sessionKey: targetSessionKey, limit: historyLimit }));
      } catch (error) {
        if (!missingSessionError(error, targetSessionKey)) {
          throw errorWithCode("AGENT_SESSION_READ_FAILED", "Could not read the target Agent session before dispatch", { cause: error });
        }
      }

      let sent = false;
      try {
        sent = true;
        const run = await subagentRun({
          sessionKey: targetSessionKey,
          message,
          deliver: false,
          idempotencyKey: `platform:${call.traceId}:${call.stepId}`,
        });
        if (!isRecord(run) || typeof run.runId !== "string" || !run.runId) {
          throw errorWithCode("AGENT_RUN_ID_MISSING", "OpenClaw did not return a waitable run ID", { sentBeforeError: true });
        }
        const waited = await subagentWaitForRun({ runId: run.runId, timeoutMs });
        if (waited?.status === "timeout") {
          throw errorWithCode("AGENT_REPLY_TIMEOUT", "The Agent is still processing; do not automatically resend this request", { sentBeforeError: true });
        }
        if (waited?.status !== "ok") {
          throw errorWithCode("AGENT_RUN_FAILED", "The Agent run did not finish successfully; do not automatically resend", { sentBeforeError: true });
        }
        const latest = latestAssistantSnapshot(await subagentGetSessionMessages({ sessionKey: targetSessionKey, limit: historyLimit }));
        if (!latest || (baseline
          && latest.fingerprint === baseline.fingerprint
          && latest.messageCount <= baseline.messageCount)) {
          throw errorWithCode("AGENT_REPLY_NOT_FOUND", "No new reply was found for this Agent run; do not automatically resend", { sentBeforeError: true });
        }
        return parseAgentReply(latest.text, { agentId, traceId: call.traceId });
      } catch (error) {
        if (error?.sentBeforeError) throw error;
        throw errorWithCode(error?.code ?? "AGENT_TRANSPORT_FAILED", "OpenClaw Agent call failed; check the Gateway/Agent session before deciding whether to retry", {
          sentBeforeError: sent,
          cause: error,
        });
      }
    });
  };
}
