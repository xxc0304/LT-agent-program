import { normalizeInferredNumericPreference } from "./numeric-preference.js";

function ignored(reason, note) {
  return { success: true, accepted: false, ignored_reason: reason, note };
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

function validRoomId(value) {
  return typeof value === "string" && /^[a-z0-9_-]{1,40}$/.test(value);
}

/**
 * Learns only from the sanitized direct-user call_service events emitted by
 * HomeAssistantStateMonitor. It deliberately does not infer intent from
 * state_changed events. HA user IDs, device names, raw service data, and raw
 * event payloads are never written to household memory.
 */
export function createHomeAssistantDeviceActionObserver({ store, deviceInventory, timeZone } = {}) {
  if (!store
    || typeof store.getDeviceActionObservationConsent !== "function"
    || typeof store.proposeInferredCandidate !== "function") {
    throw new Error("HA 设备偏好观察器需要支持设备行为授权与候选写入的家庭记忆存储");
  }
  if (!deviceInventory || typeof deviceInventory.list !== "function") {
    throw new Error("HA 设备偏好观察器需要家庭设备清单，用于确认设备和房间范围");
  }

  return {
    async observe(event = {}) {
      if (event.event_type !== "ha_user_service_action"
        || event.trusted_source !== "ha_call_service_context") {
        return ignored("UNTRUSTED_EVENT_SHAPE", "只接受 HA 监测器生成的脱敏、已认证用户服务调用摘要。");
      }
      const consent = await store.getDeviceActionObservationConsent();
      if (consent.enabled !== true) {
        return ignored("DEVICE_OBSERVATION_CONSENT_REQUIRED", "设备操作观察授权未开启；没有写入候选。");
      }
      if (typeof timeZone !== "string" || !timeZone.trim()) {
        return ignored("HOUSEHOLD_TIME_ZONE_REQUIRED", "尚未配置家庭 IANA 时区；没有记录观察事件。");
      }
      try { new Intl.DateTimeFormat("en-US", { timeZone }); } catch {
        return ignored("INVALID_HOUSEHOLD_TIME_ZONE", "家庭时区不是有效 IANA 时区；没有记录观察事件。");
      }
      const observationDate = localDateFor(event.occurred_at, timeZone);
      if (!observationDate) {
        return ignored("INVALID_EVENT_TIME", "事件时间无效或无法转换到家庭时区；没有写入候选。");
      }
      if (typeof event.event_id !== "string" || !/^[a-f0-9]{64}$/.test(event.event_id)) {
        return ignored("INVALID_EVENT_ID", "事件 ID 不符合脱敏哈希格式；没有写入候选。");
      }
      if (typeof event.entity_id !== "string" || !/^(?:climate|light)\.[a-z0-9_]+$/.test(event.entity_id)) {
        return ignored("INVALID_ENTITY_ID", "事件不是支持的空调或灯具实体；没有写入候选。");
      }

      const mapping = {
        "climate.set_temperature": {
          memory_type: "comfort_temperature_c",
          min: 16,
          max: 30,
        },
        "light.set_brightness": {
          memory_type: "comfort_brightness_pct",
          min: 1,
          max: 100,
        },
      }[`${event.domain}.${event.action}`];
      if (!mapping) {
        return ignored("UNSUPPORTED_DEVICE_ACTION", "只学习明确设置的空调温度或灯光亮度。");
      }
      if (!Number.isFinite(event.value) || event.value < mapping.min || event.value > mapping.max) {
        return ignored("INVALID_DEVICE_VALUE", "设备参数超出偏好范围；没有写入候选。");
      }
      const preferenceValue = normalizeInferredNumericPreference(mapping.memory_type, event.value);

      const inventory = deviceInventory.list();
      const record = inventory?.success === true
        ? inventory.devices?.find((device) => device.device_id === event.entity_id)
        : null;
      if (!record
        || record.presence_status === "not_found"
        || record.approval_status !== "approved"
        || record.area_confirmed !== true
        || !validRoomId(record.area_id)) {
        return ignored("DEVICE_OR_ROOM_NOT_REVIEWED", "该设备尚未完成登记或房间核对；为避免把不同房间习惯混在一起，没有学习。");
      }
      if (record.domain !== event.domain) {
        return ignored("DEVICE_DOMAIN_MISMATCH", "事件实体类型与已登记设备不一致；没有写入候选。");
      }

      const result = await store.proposeInferredCandidate({
        memory_type: mapping.memory_type,
        value: preferenceValue,
        event_id: event.event_id,
        observation_date: observationDate,
        room_id: record.area_id,
        subject_id: "household",
        observation_scope: "device_action",
        confidence: 0.9,
        consent_to_observe: true,
      });
      return {
        ...result,
        accepted: result.success === true,
        observation_date: observationDate,
        room_id: record.area_id,
        learned_from: "ha_authenticated_direct_user_service_call",
        confidence_basis: "HA 事件含已登录用户上下文且没有父调用；候选仍需跨日重复和用户确认。",
        user_id_stored: false,
        device_id_stored: false,
        raw_event_stored: false,
      };
    },
  };
}
