const DEFAULT_MAX_AGE_MS = 60_000;
const LEARNING_AGENT_ID = "learning-companion";

function normalizeArea(value) {
  if (typeof value !== "string") return null;
  const aliases = {
    "客厅": "living_room",
    "卧室": "bedroom",
    "书桌": "desk",
    "学习区": "study_area",
  };
  return aliases[value] ?? value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function failure(code, message) {
  return { success: false, error: { code, message } };
}

/** Validate a previously received independent HA occupancy event. */
export function validateIndependentOccupancyConfirmation({
  learningEvent,
  confirmation,
  now = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  maxFutureSkewMs = 60_000,
  trustedSourceAgents = [],
} = {}) {
  if (!learningEvent || learningEvent.event_type !== "learning_behavior") {
    return failure("INVALID_LEARNING_EVENT", "占用佐证只适用于 learning_behavior 事件。");
  }
  if (learningEvent.payload?.annotation_scope === "classroom_scene"
    || learningEvent.payload?.target_child_specified === false) {
    return failure("CLASSROOM_SCENE_NOT_TARGETED", "课堂整体场景不能作为家庭目标儿童离位控制信号。");
  }
  if (!confirmation || typeof confirmation !== "object" || Array.isArray(confirmation)) {
    return failure("INDEPENDENT_OCCUPANCY_CONFIRMATION_REQUIRED", "视觉离位信号需要独立占用传感器佐证。");
  }
  if (typeof confirmation.event_id !== "string" || !confirmation.event_id
    || typeof confirmation.source_agent !== "string" || !confirmation.source_agent
    || confirmation.event_id === learningEvent.event_id
    || confirmation.source_agent === LEARNING_AGENT_ID
    || confirmation.source_agent === learningEvent.source_agent) {
    return failure("INVALID_OCCUPANCY_CONFIRMATION", "占用佐证必须来自不同于学习伴学 Agent 的独立事件。");
  }
  if (!Array.isArray(trustedSourceAgents) || !trustedSourceAgents.includes(confirmation.source_agent)) {
    return failure("UNTRUSTED_OCCUPANCY_SOURCE", "占用佐证来源未列入可信 Home Assistant 适配器白名单。");
  }
  if (confirmation.occupied !== false) {
    return failure("OCCUPANCY_NOT_CONFIRMED_ABSENT", "独立传感器没有明确报告该区域无人。");
  }

  const learningArea = normalizeArea(learningEvent.payload?.area);
  const confirmationArea = normalizeArea(confirmation.area);
  if (!learningArea || !confirmationArea || learningArea !== confirmationArea) {
    return failure("OCCUPANCY_AREA_MISMATCH", "视觉离位信号与占用佐证必须对应同一区域。");
  }

  const observedAt = Date.parse(confirmation.occurred_at);
  const learningAt = Date.parse(learningEvent.occurred_at);
  if (!Number.isFinite(observedAt) || !Number.isFinite(learningAt)) {
    return failure("INVALID_OCCUPANCY_CONFIRMATION_TIME", "占用佐证和学习事件都必须包含有效时间。");
  }
  const ageMs = now - observedAt;
  if (ageMs > maxAgeMs) {
    return failure("STALE_OCCUPANCY_CONFIRMATION", "占用佐证已过期；请先读取新的传感器状态。");
  }
  if (ageMs < -maxFutureSkewMs) {
    return failure("FUTURE_OCCUPANCY_CONFIRMATION", "占用佐证时间超出允许的时钟偏差。");
  }
  if (Math.abs(learningAt - observedAt) > maxAgeMs) {
    return failure("OCCUPANCY_CONFIRMATION_NOT_CONCURRENT", "占用佐证与视觉离位结论时间相隔过久。");
  }

  return { success: true };
}
