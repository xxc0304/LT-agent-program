import { OPENCLAW_AGENT_TARGETS } from "./openclaw-agent-client.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_HISTORY_LIMIT = 50;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} 必须是非空字符串`);
  }
  return value.trim();
}

function configuredMainKey(config) {
  const mainKey = config?.session?.mainKey;
  return typeof mainKey === "string" && mainKey.trim() ? mainKey.trim().toLowerCase() : "main";
}

function targetMainSessionKey(agentId, config) {
  return `agent:${agentId}:${configuredMainKey(config)}`;
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

function assistantSnapshot(history) {
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
    return { text, fingerprint };
  }
  return null;
}

function resultStatus(status, sentBeforeError = false, error) {
  return {
    status,
    ...(sentBeforeError ? { sentBeforeError: true } : {}),
    ...(error ? { error } : {}),
  };
}

function isMissingSessionError(error, sessionKey) {
  const nestedError = error?.error ?? error?.details?.error;
  const messages = [
    typeof error === "string" ? error : null,
    error?.message,
    nestedError?.message,
    error?.details?.message,
  ].filter((value) => typeof value === "string");
  const escapedSessionKey = sessionKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const missingSessionPattern = new RegExp(`No session found:\\s*${escapedSessionKey}$`, "i");
  // Some Gateway client layers preserve INVALID_REQUEST, while others expose
  // only the RPC error message. The exact target-key suffix is sufficiently
  // specific; unrelated errors still fail closed.
  return messages.some((message) => missingSessionPattern.test(message.trim()));
}

/**
 * Creates the OpenClaw 2026.7.1-2 plugin subagent transport for OpenClawAgentClient.
 *
 * Use the public runtime.subagent surface: runtime.gateway.request is restricted
 * to bundled/trusted-official plugins and is not available to this local plugin.
 * `authorizeTarget` must use trusted runtime-supplied requester context and
 * OpenClaw's A2A/session-visibility policy before dispatching to another agent.
 * The transport intentionally calls no device API and never retries a run.
 */
export function createOpenClawGatewaySendMessage({
  subagentRun,
  subagentWaitForRun,
  subagentGetSessionMessages,
  requesterAgentId,
  requesterSessionKey,
  config,
  authorizeTarget,
  historyLimit = DEFAULT_HISTORY_LIMIT,
} = {}) {
  if (typeof subagentRun !== "function"
    || typeof subagentWaitForRun !== "function"
    || typeof subagentGetSessionMessages !== "function") {
    throw new Error("必须提供 OpenClaw runtime.subagent 的 run、waitForRun 和 getSessionMessages 函数");
  }
  if (typeof authorizeTarget !== "function") throw new Error("authorizeTarget 必须执行 OpenClaw A2A/会话可见性校验");
  const sourceAgentId = requireNonEmptyString(requesterAgentId, "requesterAgentId");
  const sourceSessionKey = requireNonEmptyString(requesterSessionKey, "requesterSessionKey");
  if (!Number.isInteger(historyLimit) || historyLimit < 1 || historyLimit > 500) {
    throw new Error("historyLimit 必须是 1 到 500 之间的整数");
  }

  return async function sendMessage({ agentId, message, timeoutSeconds, idempotencyKey } = {}) {
    const targetAgentId = requireNonEmptyString(agentId, "agentId");
    if (!OPENCLAW_AGENT_TARGETS.includes(targetAgentId)) {
      return resultStatus("forbidden", false, "目标 Agent 不在项目白名单中");
    }
    if (sourceAgentId !== "device-manager" || !sourceSessionKey.startsWith("agent:device-manager:")) {
      return resultStatus("forbidden", false, "只有设备管家主会话可以调用独立业务 Agent");
    }
    if (targetAgentId === sourceAgentId) {
      return resultStatus("forbidden", false, "不允许调用当前 Agent 自身");
    }

    const targetSessionKey = targetMainSessionKey(targetAgentId, config);
    const access = await authorizeTarget({
      requesterAgentId: sourceAgentId,
      requesterSessionKey: sourceSessionKey,
      targetAgentId,
      targetSessionKey,
      action: "send",
    });
    if (access?.allowed !== true) {
      return resultStatus("forbidden", false, access?.error ?? "OpenClaw A2A/会话可见性策略拒绝了调用");
    }

    const timeoutMs = Math.max(1, Math.min(120_000, Number(timeoutSeconds) * 1000 || DEFAULT_TIMEOUT_MS));
    let sendAttempted = false;
    try {
      let baselineHistory;
      try {
        baselineHistory = await subagentGetSessionMessages({
          sessionKey: targetSessionKey,
          limit: historyLimit,
        });
      } catch (error) {
        // runtime.subagent.run creates a target session on first use. Reading
        // its history first may therefore report this exact missing-session
        // error; ignore only that case and fail closed for every other error.
        if (!isMissingSessionError(error, targetSessionKey)) throw error;
        baselineHistory = { messages: [] };
      }
      const baseline = assistantSnapshot(baselineHistory);

      // Once run() is called, conservatively treat the request as sent. If the
      // RPC fails after accepting the run, the caller must not blindly retry it.
      sendAttempted = true;
      const sendResult = await subagentRun({
        sessionKey: targetSessionKey,
        message: requireNonEmptyString(message, "message"),
        deliver: false,
        idempotencyKey: requireNonEmptyString(idempotencyKey, "idempotencyKey"),
      });
      if (!isRecord(sendResult) || typeof sendResult.runId !== "string" || !sendResult.runId) {
        return resultStatus("error", sendAttempted, "Gateway 未返回可等待的 Agent runId");
      }

      const waitResult = await subagentWaitForRun({
        runId: sendResult.runId,
        timeoutMs,
      });
      if (waitResult?.status === "timeout") return resultStatus("timeout", true, "等待独立 Agent 回复超时");
      if (waitResult?.status !== "ok") return resultStatus("error", true, "独立 Agent 执行失败；本次不重发");

      const finalHistory = await subagentGetSessionMessages({
        sessionKey: targetSessionKey,
        limit: historyLimit,
      });
      const latest = assistantSnapshot(finalHistory);
      if (!latest || (baseline && latest.fingerprint === baseline.fingerprint)) {
        return resultStatus("error", true, "未取得本次独立 Agent 的新回复；本次不重发");
      }
      return { status: "ok", reply: latest.text };
    } catch {
      return resultStatus("error", sendAttempted, "OpenClaw subagent 请求失败；请检查 Gateway 状态与 Agent 配置后再决定是否重试");
    }
  };
}

export { targetMainSessionKey };
