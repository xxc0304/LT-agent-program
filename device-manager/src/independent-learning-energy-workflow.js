import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { validateAgainstSchema } from "../../common-contracts/schema-validator.mjs";
import { createIndependentEnergyWorkflow } from "./independent-energy-workflow.js";

const EVENT_SCHEMA = JSON.parse(readFileSync(new URL("../../common-contracts/schemas/event.schema.json", import.meta.url), "utf8"));
const ALLOWED_BEHAVIORS = new Set([
  "reading",
  "writing",
  "listening",
  "raising_hand",
  "turning_around",
  "standing",
  "discussing",
  "leaving_desk",
  "away_from_desk",
  "no_occupancy",
]);
const OBSERVATION_KEYS = new Set([
  "observation_id",
  "area",
  "observed_at",
  "behavior",
  "presence",
  "confidence",
  "duration_ms",
  "needs_review",
  "evidence",
  "annotation_scope",
  "target_child_specified",
]);
const DEFAULT_MIN_CONFIDENCE = 0.8;
const DEFAULT_MIN_ABSENCE_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_MAX_OBSERVATION_AGE_MS = 2 * 60 * 1000;
const DEFAULT_MAX_CLOCK_SKEW_MS = 30 * 1000;
const RFC3339_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

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

function childIdempotencyKey(stage, parentKey) {
  return `${stage}:${createHash("sha256").update(parentKey).digest("hex").slice(0, 32)}`;
}

function validateObservation(observation) {
  if (!isRecord(observation)) return "observation 必须是 JSON 对象";
  const unexpected = Object.keys(observation).find((key) => !OBSERVATION_KEYS.has(key));
  if (unexpected) return `observation 含不允许字段：${unexpected}；不得传原始图片、视频、路径或认证信息`;
  for (const field of ["area", "observed_at", "behavior", "presence"]) {
    if (typeof observation[field] !== "string" || !observation[field].trim()) return `${field} 必须是非空字符串`;
  }
  if (!RFC3339_DATE_TIME.test(observation.observed_at) || !Number.isFinite(Date.parse(observation.observed_at))) {
    return "observed_at 必须是带时区的 RFC3339 时间字符串";
  }
  if (!ALLOWED_BEHAVIORS.has(observation.behavior)) return "behavior 不是当前学习行为契约支持的标签";
  if (!["at_desk", "away_from_desk", "unknown"].includes(observation.presence)) return "presence 必须是 at_desk、away_from_desk 或 unknown";
  if (!Number.isFinite(observation.confidence) || observation.confidence < 0 || observation.confidence > 1) {
    return "confidence 必须是 0 到 1 之间的数字";
  }
  if (!Number.isSafeInteger(observation.duration_ms) || observation.duration_ms < 0) return "duration_ms 必须是非负整数";
  if (typeof observation.needs_review !== "boolean") return "needs_review 必须是布尔值";
  if (observation.evidence !== undefined && (typeof observation.evidence !== "string" || observation.evidence.length > 500)) {
    return "evidence 必须是最多 500 字符的文本";
  }
  if (observation.annotation_scope !== undefined && !["individual", "classroom_scene"].includes(observation.annotation_scope)) {
    return "annotation_scope 必须是 individual 或 classroom_scene";
  }
  if (observation.target_child_specified !== undefined && typeof observation.target_child_specified !== "boolean") {
    return "target_child_specified 必须是布尔值";
  }
  if (observation.observation_id !== undefined
    && (typeof observation.observation_id !== "string" || !observation.observation_id.trim())) {
    return "observation_id 必须是非空字符串";
  }
  return null;
}

function assertLearningEventMatchesObservation(event, observation, traceId) {
  const errors = validateAgainstSchema(event, EVENT_SCHEMA);
  if (event.source_agent !== "learning-companion") errors.push("source_agent 必须为 learning-companion");
  if (event.event_type !== "learning_behavior") errors.push("event_type 必须为 learning_behavior");
  if (event.trace_id !== traceId) errors.push("trace_id 必须与本次工作流一致");
  if (event.occurred_at !== observation.observed_at) errors.push("occurred_at 必须沿用输入观测时间");
  if (event.privacy_level !== "restricted" || event.data_level !== "L3") errors.push("学习事件必须保留 restricted/L3 隐私级别");
  if (event.source?.type !== "learning_behavior_model" || event.source?.id !== "learning-companion") {
    errors.push("学习事件必须标明 learning-companion 视觉/行为适配来源");
  }
  const payload = event.payload;
  if (!isRecord(payload)) {
    errors.push("payload 必须是对象");
  } else {
    for (const field of ["area", "behavior", "presence", "duration_ms"]) {
      if (payload[field] !== observation[field]) errors.push(`payload.${field} 不得偏离输入观测`);
    }
    if (payload.annotation_scope !== observation.annotation_scope) errors.push("payload.annotation_scope 不得偏离输入观测");
    if (payload.target_child_specified !== observation.target_child_specified) errors.push("payload.target_child_specified 不得偏离输入观测");
  }
  if (typeof event.confidence !== "number" || event.confidence > observation.confidence) {
    errors.push("confidence 不得高于上游观测置信度");
  }
  if (typeof event.needs_review !== "boolean") errors.push("needs_review 必须是布尔值");
  if (observation.needs_review && event.needs_review === false) errors.push("学习 Agent 不得清除上游待复核标记");
  if (errors.length > 0) {
    const error = new Error(`学习伴学 Agent 输出未通过工作流校验：${errors.join("；")}`);
    error.code = "INVALID_LEARNING_EVENT";
    error.details = { errors };
    throw error;
  }
}

function eventReviewReasons(event, observation, { minConfidence, minAbsenceDurationMs }) {
  const reasons = [];
  const payload = event.payload;
  if (observation.annotation_scope === "classroom_scene" || payload.annotation_scope === "classroom_scene") {
    reasons.push("CLASSROOM_SCENE_NOT_TARGETED");
  }
  if (observation.target_child_specified !== true || payload.target_child_specified !== true) {
    reasons.push("TARGET_CHILD_NOT_SPECIFIED");
  }
  if (event.needs_review !== false || observation.needs_review) reasons.push("NEEDS_REVIEW");
  if (event.confidence < minConfidence) reasons.push("LOW_CONFIDENCE");
  if (payload.presence !== "away_from_desk") reasons.push("PRESENCE_NOT_CONFIRMED_AWAY");
  if (payload.duration_ms < minAbsenceDurationMs) reasons.push("ABSENCE_DURATION_TOO_SHORT");
  return reasons;
}

function summarizeEvent(event) {
  return {
    event_id: event.event_id,
    area: event.payload.area,
    behavior: event.payload.behavior,
    presence: event.payload.presence,
    confidence: event.confidence,
    duration_ms: event.payload.duration_ms,
    needs_review: event.needs_review,
  };
}

/**
 * Compose independent OpenClaw learning/energy Agents without trusting the
 * model to authenticate observations or approve device actions. A trusted
 * in-process adapter must attest the structured observation; chat/tool JSON
 * cannot provide that attestation.
 */
export function createIndependentLearningEnergyWorkflow({
  agentClient,
  executeEnergyTask,
  isTrustedObservation = () => false,
  clock = () => Date.now(),
  minConfidence = DEFAULT_MIN_CONFIDENCE,
  minAbsenceDurationMs = DEFAULT_MIN_ABSENCE_DURATION_MS,
  maxObservationAgeMs = DEFAULT_MAX_OBSERVATION_AGE_MS,
  maxClockSkewMs = DEFAULT_MAX_CLOCK_SKEW_MS,
  maxRememberedRequests = 200,
} = {}) {
  if (!agentClient || typeof agentClient.invoke !== "function") throw new Error("agentClient.invoke 必须是函数");
  if (typeof executeEnergyTask !== "function") throw new Error("executeEnergyTask 必须是函数");
  if (typeof isTrustedObservation !== "function") throw new Error("isTrustedObservation 必须是函数");
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) throw new Error("minConfidence 配置无效");
  if (!Number.isSafeInteger(minAbsenceDurationMs) || minAbsenceDurationMs < 0) throw new Error("minAbsenceDurationMs 配置无效");
  if (!Number.isSafeInteger(maxObservationAgeMs) || maxObservationAgeMs < 1) throw new Error("maxObservationAgeMs 配置无效");
  if (!Number.isSafeInteger(maxClockSkewMs) || maxClockSkewMs < 0) throw new Error("maxClockSkewMs 配置无效");
  if (!Number.isInteger(maxRememberedRequests) || maxRememberedRequests < 1) throw new Error("maxRememberedRequests 必须是正整数");

  const energyWorkflow = createIndependentEnergyWorkflow({ agentClient, executeEnergyTask, maxRememberedRequests });
  const requests = new Map();

  async function evaluate({ observation, traceId, idempotencyKey } = {}) {
    const observationError = validateObservation(observation);
    if (observationError) {
      const error = new Error(`输入 observation 无效：${observationError}`);
      error.code = "INVALID_LEARNING_OBSERVATION";
      throw error;
    }
    const normalizedTraceId = requireString(
      traceId ?? `trace-learning-energy-${observation.observation_id ?? randomUUID()}`,
      "trace_id",
    );
    const normalizedIdempotencyKey = requireString(
      idempotencyKey ?? `learning-energy:${observation.observation_id ?? normalizedTraceId}`,
      "idempotency_key",
    );
    const requestFingerprint = fingerprint({ observation, traceId: normalizedTraceId });
    const previous = requests.get(normalizedIdempotencyKey);
    if (previous) {
      if (previous.fingerprint !== requestFingerprint) {
        const error = new Error("同一 idempotency_key 不可用于不同的学习观测");
        error.code = "IDEMPOTENCY_KEY_CONFLICT";
        throw error;
      }
      return previous.promise.then(clone);
    }
    while (requests.size >= maxRememberedRequests) {
      const settledKey = [...requests.entries()].find(([, entry]) => entry.settled)?.[0];
      if (settledKey === undefined) {
        const error = new Error("学习/节能编排幂等缓存已满且所有请求仍在处理中；本次请求被拒绝");
        error.code = "IDEMPOTENCY_CACHE_FULL";
        throw error;
      }
      requests.delete(settledKey);
    }
    const promise = runWorkflow({
      observation: clone(observation),
      traceId: normalizedTraceId,
      idempotencyKey: normalizedIdempotencyKey,
    });
    const entry = { fingerprint: requestFingerprint, promise, settled: false };
    requests.set(normalizedIdempotencyKey, entry);
    void promise.then(() => { entry.settled = true; }, () => { entry.settled = true; });
    return promise.then(clone);
  }

  async function runWorkflow({ observation, traceId, idempotencyKey }) {
    let trusted;
    try {
      trusted = await isTrustedObservation(clone(observation));
    } catch {
      trusted = false;
    }
    if (trusted !== true) {
      return {
        success: false,
        status: "REJECTED",
        reason_code: "OBSERVATION_SOURCE_UNTRUSTED",
        execution_performed: false,
        trace_id: traceId,
        agents_involved: [],
        message: "输入观测未由受信任的本地视觉/传感器适配器认证；未调用业务 Agent，也未操作设备。",
      };
    }

    const now = clock();
    const observedAt = Date.parse(observation.observed_at);
    const ageMs = now - observedAt;
    if (!Number.isFinite(now) || ageMs > maxObservationAgeMs || ageMs < -maxClockSkewMs) {
      return {
        success: false,
        status: "REJECTED",
        reason_code: "OBSERVATION_STALE_OR_FUTURE",
        execution_performed: false,
        trace_id: traceId,
        agents_involved: [],
        message: "学习观测已过期或时间戳超出允许的时钟偏差；未调用业务 Agent，也未操作设备。",
      };
    }

    const learningResult = await agentClient.invoke({
      agentId: "learning-companion",
      traceId,
      idempotencyKey: childIdempotencyKey("learning", idempotencyKey),
      input: { observation },
    });
    const learningEvent = learningResult?.output;
    if (learningResult?.status !== "ok" || !isRecord(learningEvent)) {
      const error = new Error("独立学习伴学 Agent 未返回已校验的 Event");
      error.code = "INVALID_AGENT_RESULT";
      throw error;
    }
    assertLearningEventMatchesObservation(learningEvent, observation, traceId);

    const reviewReasons = eventReviewReasons(learningEvent, observation, { minConfidence, minAbsenceDurationMs });
    if (reviewReasons.length > 0) {
      return {
        success: true,
        status: "REVIEW_REQUIRED",
        reason_codes: reviewReasons,
        execution_performed: false,
        trace_id: traceId,
        event: summarizeEvent(learningEvent),
        agents_involved: ["learning-companion"],
        message: "学习伴学 Agent 已生成结构化事件，但事件未达到交给能源管家的确定性门槛；未调用能源管家，也未操作设备。",
      };
    }

    const energyResult = await energyWorkflow.evaluate({
      event: learningEvent,
      traceId,
      idempotencyKey: childIdempotencyKey("energy", idempotencyKey),
    });
    return {
      ...energyResult,
      trace_id: traceId,
      event: summarizeEvent(learningEvent),
      agents_involved: energyResult.outcome === "TASK_SUBMITTED"
        ? ["learning-companion", "energy-saving", "device-manager"]
        : ["learning-companion", "energy-saving"],
    };
  }

  return { evaluate };
}

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 必须是非空字符串`);
  return value.trim();
}
