const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_HISTORY_LIMIT = 50;
const TARGET_AGENT_ID = "device-manager";
const REQUESTER_AGENT_ID = "dev";
const CREDENTIAL_PATTERNS = [
  /\b(?:api[_\s-]?key|access[_\s-]?token|password|secret|authorization)\s*[:=]\s*\S+/i,
  /\bbearer\s+\S+/i,
  /\bsk-[a-z0-9_-]{20,}/i,
  /\bgh[pousr]_[a-z0-9]{20,}/i,
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} 必须是非空字符串`);
  }
  return value.trim();
}

function mainKey(config) {
  const value = config?.session?.mainKey;
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : "main";
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
  return messages.some((message) => missingSessionPattern.test(message.trim()));
}

function resultStatus(status, sentBeforeError = false, error) {
  return {
    status,
    ...(sentBeforeError ? { sentBeforeError: true } : {}),
    ...(error ? { error } : {}),
  };
}

function targetSessionKey(config) {
  return `agent:${TARGET_AGENT_ID}:${mainKey(config)}`;
}

function routedMessage(request) {
  return [
    "[来自用户正在使用的 OpenClaw 主对话的家庭请求]",
    request,
    "请按设备管家 Agent 已配置的设备清单、工具和安全策略处理。你面向用户用简明自然语言回复；需要澄清或确认时，直接说明具体问题或设备动作，不要要求用户切换到设备管家 Agent，也不要要求用户输入内部 ID。不要声称未实际完成的操作已成功。",
  ].join("\n\n");
}

/**
 * Creates the configured user-facing OpenClaw Agent -> `device-manager` relay.
 * It delegates only household requests, returns the device-manager's natural
 * language answer to the original chat, and never invokes a device tool itself.
 */
export function createOpenClawFrontdoorTransport({
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

  return async function relayRequest({ request, timeoutMs = DEFAULT_TIMEOUT_MS, idempotencyKey } = {}) {
    const normalizedRequest = requireNonEmptyString(request, "request");
    const requestIdempotencyKey = requireNonEmptyString(idempotencyKey, "idempotencyKey");
    if (!sourceSessionKey.startsWith(`agent:${sourceAgentId}:`)) {
      return resultStatus("forbidden", false, "该入口只允许从 OpenClaw 用户主对话调用");
    }
    if (normalizedRequest.length > 4_000) {
      return resultStatus("error", false, "转交内容过长；请只转交本次家庭设备请求，不要包含无关聊天记录");
    }
    if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(normalizedRequest))) {
      return resultStatus("error", false, "请求内容疑似包含凭据；为保护隐私，未转交给设备管家");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      return resultStatus("error", false, "等待设备管家回复的超时时间无效");
    }

    const targetKey = targetSessionKey(config);
    const access = await authorizeTarget({
      requesterAgentId: sourceAgentId,
      requesterSessionKey: sourceSessionKey,
      targetAgentId: TARGET_AGENT_ID,
      targetSessionKey: targetKey,
      action: "send",
    });
    if (access?.allowed !== true) {
      return resultStatus("forbidden", false, access?.error ?? "OpenClaw Agent-to-Agent 或会话可见性策略拒绝了调用");
    }

    let sendAttempted = false;
    try {
      let baselineHistory;
      try {
        baselineHistory = await subagentGetSessionMessages({ sessionKey: targetKey, limit: historyLimit });
      } catch (error) {
        if (!isMissingSessionError(error, targetKey)) throw error;
        baselineHistory = { messages: [] };
      }
      const baseline = assistantSnapshot(baselineHistory);

      sendAttempted = true;
      const run = await subagentRun({
        sessionKey: targetKey,
        message: routedMessage(normalizedRequest),
        deliver: false,
        idempotencyKey: requestIdempotencyKey,
      });
      if (!isRecord(run) || typeof run.runId !== "string" || !run.runId) {
        return resultStatus("error", true, "OpenClaw 没有返回可等待的设备管家任务编号；不要自动重发");
      }

      const waited = await subagentWaitForRun({ runId: run.runId, timeoutMs });
      if (waited?.status === "timeout") return resultStatus("timeout", true, "设备管家仍在处理；请先检查该会话状态，不要重复执行设备动作");
      if (waited?.status !== "ok") return resultStatus("error", true, "设备管家处理未正常结束；本次不自动重发");

      const latest = assistantSnapshot(await subagentGetSessionMessages({ sessionKey: targetKey, limit: historyLimit }));
      if (!latest || (baseline && latest.fingerprint === baseline.fingerprint)) {
        return resultStatus("error", true, "没有取得本次设备管家的新回复；本次不自动重发");
      }
      return { status: "ok", reply: latest.text };
    } catch {
      return resultStatus("error", sendAttempted, "OpenClaw 设备管家转接失败；请检查 Gateway 与设备管家会话后再决定是否重试");
    }
  };
}

export const OPENCLAW_FRONTDOOR_TARGET_AGENT = TARGET_AGENT_ID;
export const OPENCLAW_FRONTDOOR_REQUESTER_AGENT = REQUESTER_AGENT_ID;
