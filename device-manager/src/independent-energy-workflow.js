import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { validateAgainstSchema } from "../../common-contracts/schema-validator.mjs";

const EVENT_SCHEMA = JSON.parse(readFileSync(new URL("../../common-contracts/schemas/event.schema.json", import.meta.url), "utf8"));

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 必须是非空字符串`);
  return value.trim();
}

/**
 * Connect an independently hosted energy-saving Agent to the device-manager
 * plan workflow. The energy Agent may propose a Task, but only the existing
 * device-manager workflow can validate, request approval, execute, and verify it.
 */
export function createIndependentEnergyWorkflow({ agentClient, executeEnergyTask, maxRememberedRequests = 200 } = {}) {
  if (!agentClient || typeof agentClient.invoke !== "function") throw new Error("agentClient.invoke 必须是函数");
  if (typeof executeEnergyTask !== "function") throw new Error("executeEnergyTask 必须是函数");
  if (!Number.isInteger(maxRememberedRequests) || maxRememberedRequests < 1) {
    throw new Error("maxRememberedRequests 必须是正整数");
  }

  const requests = new Map();

  async function evaluate({ event, traceId, idempotencyKey } = {}) {
    if (!isRecord(event)) throw new Error("event 必须是标准 Event JSON 对象");
    if (traceId !== undefined && event.trace_id !== undefined && traceId !== event.trace_id) {
      const error = new Error("请求 trace_id 必须与 Event 中的 trace_id 一致");
      error.code = "TRACE_ID_CONFLICT";
      throw error;
    }
    const fallbackTraceId = typeof event.event_id === "string" && event.event_id.trim()
      ? `trace-energy-${event.event_id.trim()}`
      : `trace-energy-${randomUUID()}`;
    const normalizedTraceId = requireString(traceId ?? event.trace_id ?? fallbackTraceId, "trace_id");
    const normalizedIdempotencyKey = requireString(
      idempotencyKey ?? `independent-energy:${event.event_id ?? normalizedTraceId}`,
      "idempotency_key",
    );
    const candidateEvent = { ...clone(event), trace_id: normalizedTraceId };
    const eventErrors = validateAgainstSchema(candidateEvent, EVENT_SCHEMA);
    if (eventErrors.length > 0) {
      const error = new Error(`输入 Event 未通过公共契约校验：${eventErrors.join("；")}`);
      error.code = "INVALID_ENERGY_EVENT";
      error.details = { errors: eventErrors };
      throw error;
    }

    const requestFingerprint = fingerprint({ event: candidateEvent, traceId: normalizedTraceId });
    const previous = requests.get(normalizedIdempotencyKey);
    if (previous) {
      if (previous.fingerprint !== requestFingerprint) {
        const error = new Error("同一 idempotency_key 不可用于不同的能源管家事件");
        error.code = "IDEMPOTENCY_KEY_CONFLICT";
        throw error;
      }
      return previous.promise.then(clone);
    }

    while (requests.size >= maxRememberedRequests) {
      const settledKey = [...requests.entries()].find(([, entry]) => entry.settled)?.[0];
      if (settledKey === undefined) {
        const error = new Error("节能编排幂等缓存已满且所有请求仍在处理中；本次请求被拒绝");
        error.code = "IDEMPOTENCY_CACHE_FULL";
        throw error;
      }
      requests.delete(settledKey);
    }

    const promise = runWorkflow({
      event: candidateEvent,
      traceId: normalizedTraceId,
      idempotencyKey: normalizedIdempotencyKey,
    });
    const entry = { fingerprint: requestFingerprint, promise, settled: false };
    requests.set(normalizedIdempotencyKey, entry);
    void promise.then(() => { entry.settled = true; }, () => { entry.settled = true; });
    return promise.then(clone);
  }

  async function runWorkflow({ event, traceId, idempotencyKey }) {
    const agentResult = await agentClient.invoke({
      agentId: "energy-saving",
      traceId,
      idempotencyKey,
      input: { event },
    });
    const output = agentResult?.output;
    if (agentResult?.status !== "ok" || !isRecord(output)) {
      const error = new Error("独立能源管家未返回已校验的候选结果");
      error.code = "INVALID_AGENT_RESULT";
      throw error;
    }

    if (output.outcome === "NO_ACTION") {
      return {
        success: true,
        status: "NO_ACTION",
        execution_performed: false,
        trace_id: traceId,
        event_id: event.event_id,
        source_agent: "energy-saving",
        reason_code: output.reason_code,
        message: "能源管家判断当前无需设备动作。",
      };
    }

    const receipt = await executeEnergyTask(output, { trustedEventSource: false });
    const receiptStatus = receipt?.status ?? "FAILED";
    return {
      success: !["FAILED", "DENIED"].includes(receiptStatus),
      status: receiptStatus,
      outcome: "TASK_SUBMITTED",
      execution_performed: receiptStatus === "SUCCEEDED",
      confirmation_required: receiptStatus === "CHALLENGE",
      trace_id: traceId,
      event_id: event.event_id,
      source_agent: "energy-saving",
      task: clone(output),
      receipt: clone(receipt),
      message: receiptStatus === "CHALLENGE"
        ? "能源管家提交了候选动作，设备管家已暂停执行并等待用户确认。"
        : receiptStatus === "SUCCEEDED"
          ? "设备管家完成了候选动作并返回执行结果。"
          : "候选任务已进入设备管家校验流程。",
    };
  }

  return { evaluate };
}
