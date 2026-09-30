const CONTRACT_VERSION = "0.1";
const ROUTINE_TYPES = Object.freeze(["sleep_time", "wake_time"]);
const DEFAULT_TRIGGER_WINDOW_MS = 60_000;

function failure(code, message) {
  return { success: false, status: "REJECTED", error: { code, message }, events: [] };
}

function localClockParts(timestampMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
  }).formatToParts(new Date(timestampMs));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const localDate = `${values.year}-${values.month}-${values.day}`;
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  const second = Number(values.second);
  const millisecond = Number(values.fractionalSecond ?? 0);
  const weekday = values.weekday;
  const dayType = ["Sat", "Sun"].includes(weekday) ? "weekend" : "weekday";
  return {
    localDate,
    dayType,
    timeOfDayMs: ((hour * 60 + minute) * 60 + second) * 1000 + millisecond,
  };
}

function instantForLocalTime(localDate, targetTimeMs, timeZone) {
  const [year, month, day] = localDate.split("-").map(Number);
  const targetWallMs = Date.UTC(year, month - 1, day) + targetTimeMs;
  let guess = targetWallMs;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const local = localClockParts(guess, timeZone);
    const [localYear, localMonth, localDay] = local.localDate.split("-").map(Number);
    const representedWallMs = Date.UTC(localYear, localMonth - 1, localDay) + local.timeOfDayMs;
    const correction = targetWallMs - representedWallMs;
    if (correction === 0) return guess;
    guess += correction;
  }
  const resolved = localClockParts(guess, timeZone);
  if (resolved.localDate !== localDate || resolved.timeOfDayMs !== targetTimeMs) return null;
  return guess;
}

function safeIdPart(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

/**
 * Deterministic local-time due-event evaluator for an external scheduler.
 * It is disabled by default and only emits an Event object; it never sends a
 * notification, creates a timer, or controls a device itself.
 */
export function createRoutineDueEvaluator({
  store,
  scheduleAuthorized = false,
  clock = () => Date.now(),
  triggerWindowMs = DEFAULT_TRIGGER_WINDOW_MS,
} = {}) {
  if (!store || typeof store.getPreference !== "function") {
    throw new Error("routine due evaluator 需要支持已确认偏好查询的家庭记忆存储");
  }
  if (!Number.isInteger(triggerWindowMs) || triggerWindowMs < 0 || triggerWindowMs > 5 * 60_000) {
    throw new Error("triggerWindowMs 必须是 0 到 5 分钟之间的整数毫秒数");
  }

  return {
    async poll({ time_zone, subject_id = "household" } = {}) {
      if (typeof time_zone !== "string" || !time_zone) {
        return failure("TIME_ZONE_REQUIRED", "检查作息提醒时必须提供家庭 IANA 时区。");
      }
      const nowMs = clock();
      let local;
      try {
        local = localClockParts(nowMs, time_zone);
      } catch {
        return failure("INVALID_TIME_ZONE", "time_zone 必须是有效的 IANA 时区名称。");
      }
      if (scheduleAuthorized !== true) {
        return {
          success: true,
          status: "SCHEDULE_AUTHORIZATION_REQUIRED",
          execution_performed: false,
          events: [],
          note: "只确认到期状态；真正安排提醒仍需单独授权。",
        };
      }

      const events = [];
      for (const routineType of ROUTINE_TYPES) {
        const preference = await store.getPreference({
          memory_type: routineType,
          time_zone,
          day_type: local.dayType,
          subject_id,
        });
        if (!preference || !/^\d{2}:\d{2}$/.test(preference.value)) continue;
        const [hour, minute] = preference.value.split(":").map(Number);
        const targetTimeMs = (hour * 60 + minute) * 60_000;
        const elapsedMs = local.timeOfDayMs - targetTimeMs;
        if (elapsedMs < 0 || elapsedMs > triggerWindowMs) continue;
        const scheduledAtMs = instantForLocalTime(local.localDate, targetTimeMs, time_zone);
        if (scheduledAtMs === null) continue;

        const idempotencyKey = `routine-reminder:${preference.memory_id}:${local.localDate}`;
        events.push({
          schema_version: CONTRACT_VERSION,
          event_id: `evt-${safeIdPart(idempotencyKey)}`,
          source_agent: "household-memory",
          event_type: "routine_due",
          occurred_at: new Date(scheduledAtMs).toISOString(),
          privacy_level: "family",
          data_level: "L0",
          trace_id: `trace-${safeIdPart(idempotencyKey)}`,
          dedup_key: idempotencyKey,
          payload: {
            routine_type: routineType,
            local_date: local.localDate,
            local_time: preference.value,
            day_type: local.dayType,
            time_zone,
            preference_memory_id: preference.memory_id,
            proposed_action: "notify_user",
            requires_user_confirmation_before_device_action: true,
          },
        });
      }

      return {
        success: true,
        status: events.length ? "DUE_EVENT_READY" : "NOT_DUE",
        execution_performed: false,
        events,
        note: "到期事件仅作为调度输入返回；调用方负责幂等去重和通知授权，记忆服务不发送通知或控制设备。",
      };
    },
  };
}

export const ROUTINE_DUE_DEFAULTS = Object.freeze({
  triggerWindowMs: DEFAULT_TRIGGER_WINDOW_MS,
  maxTriggerWindowMs: 5 * 60_000,
  scheduleAuthorized: false,
});
