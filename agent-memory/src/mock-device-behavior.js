import { normalizeInferredNumericPreference } from "./numeric-preference.js";

const ACCEPTED_MOCK_SOURCES = new Set(["user_manual", "automation", "agent", "unknown"]);

function failure(code, message) {
  return { success: false, error: { code, message } };
}

function localDateFor(occurredAt, timeZone) {
  if (typeof occurredAt !== "string"
    || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(occurredAt)
    || !Number.isFinite(Date.parse(occurredAt))) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(occurredAt));
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return null;
  }
}

/**
 * Demo-only adapter for explicitly attributed Mock Home Assistant actions.
 * It deliberately rejects real HA state_changed summaries: those do not prove
 * whether a person, an automation, or an agent caused a state transition.
 */
export function createMockDeviceBehaviorObserver({ store } = {}) {
  if (!store
    || typeof store.getDeviceActionObservationConsent !== "function"
    || typeof store.proposeInferredCandidate !== "function") {
    throw new Error("Mock 设备行为观察器需要支持设备观察授权与候选写入的家庭记忆存储");
  }

  return {
    async observe(event = {}) {
      if (event.event_type !== "mock_device_action") {
        return failure("UNSUPPORTED_EVENT_TYPE", "只处理 MockHomeAssistant 的 mock_device_action 演示事件。");
      }
      if (event.origin !== "mock") {
        return failure("UNTRUSTED_EVENT_ORIGIN", "只接受显式标记为 Mock 的演示来源；真实 HA 事件不能通过此适配器学习。");
      }
      if (!ACCEPTED_MOCK_SOURCES.has(event.actor_source)) {
        return failure("INVALID_ACTOR_SOURCE", "actor_source 必须是 user_manual、automation、agent 或 unknown。");
      }
      if (event.actor_source !== "user_manual") {
        return {
          success: true,
          accepted: false,
          ignored_reason: "NON_MANUAL_OR_UNKNOWN_SOURCE",
          note: "自动化、Agent 和未知来源的变化不用于推断家庭成员偏好。",
        };
      }
      const actionSchema = event.domain === "climate" && event.action === "set_temperature"
        ? { memory_type: "comfort_temperature_c", field: "temperature_c", min: 16, max: 30, label: "空调温度" }
        : event.domain === "light" && event.action === "set_brightness"
          ? { memory_type: "comfort_brightness_pct", field: "brightness_pct", min: 1, max: 100, label: "灯光亮度" }
          : null;
      if (!actionSchema) {
        return failure("UNSUPPORTED_DEVICE_ACTION", "当前 Mock 学习演示只识别空调调温和灯光亮度设置。");
      }
      if (typeof event.event_id !== "string" || !event.event_id) {
        return failure("EVENT_ID_REQUIRED", "Mock 行为事件必须有稳定的 event_id。");
      }
      if (typeof event.device_id !== "string" || !new RegExp(`^${event.domain}\\.[a-z0-9_]+$`).test(event.device_id)) {
        return failure("INVALID_DEVICE_ID", "设备 ID 的实体域必须与事件 domain 一致。");
      }
      const value = event[actionSchema.field];
      if (!Number.isFinite(value) || value < actionSchema.min || value > actionSchema.max) {
        return failure("INVALID_DEVICE_VALUE", `${actionSchema.label}必须在 ${actionSchema.min}–${actionSchema.max} 之间。`);
      }
      if (event.room_id !== undefined && (typeof event.room_id !== "string" || !/^[a-z0-9_-]{1,40}$/.test(event.room_id))) {
        return failure("INVALID_ROOM_ID", "room_id 只能使用小写字母、数字、下划线和连字符。");
      }
      const observationDate = localDateFor(event.occurred_at, event.time_zone);
      if (!observationDate) {
        return failure("INVALID_EVENT_TIME", "Mock 事件必须带有效 ISO 时间和家庭 IANA 时区。");
      }

      const consent = await store.getDeviceActionObservationConsent();
      if (consent.enabled !== true) {
        return failure("DEVICE_OBSERVATION_CONSENT_REQUIRED", "设备操作观察授权默认关闭；未记录偏好候选。");
      }

      const result = await store.proposeInferredCandidate({
        memory_type: actionSchema.memory_type,
        value: normalizeInferredNumericPreference(actionSchema.memory_type, value),
        event_id: event.event_id,
        observation_date: observationDate,
        ...(event.room_id ? { room_id: event.room_id } : {}),
        subject_id: event.subject_id ?? "household",
        observation_scope: "device_action",
        confidence: 0.9,
        consent_to_observe: true,
      });
      return {
        ...result,
        accepted: result.success === true,
        observation_date: observationDate,
        learned_from: `mock_user_manual_${event.domain}_action`,
        confidence_basis: "演示事件明确标记为 Mock 用户手动操作；这不是模型识别准确率，也不代表真实 HA 来源已验证。",
      };
    },
  };
}
