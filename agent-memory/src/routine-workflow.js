const ROUTINE_MEMORY_TYPES = new Set(["sleep_time", "wake_time"]);

function failure(code, message) {
  return { success: false, error: { code, message } };
}

function validateTimeZone(timeZone) {
  if (typeof timeZone !== "string" || !timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function localDateFor(occurredAt, timeZone) {
  if (typeof occurredAt !== "string"
    || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(occurredAt)
    || !Number.isFinite(Date.parse(occurredAt))) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(occurredAt));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dayTypeFor(localDate) {
  const day = new Date(`${localDate}T12:00:00.000Z`).getUTCDay();
  return day === 0 || day === 6 ? "weekend" : "weekday";
}

function bucketTimeToQuarterHour(value) {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hour, minute] = value.split(":").map(Number);
  const roundedMinutes = (Math.round((hour * 60 + minute) / 15) * 15) % (24 * 60);
  return `${String(Math.floor(roundedMinutes / 60)).padStart(2, "0")}:${String(roundedMinutes % 60).padStart(2, "0")}`;
}

/**
 * Converts authorized, structured routine signals into local-memory candidates.
 * It does not infer a bedtime from images, device state, or raw conversation,
 * and its preview operation never creates a timer or controls a device.
 */
export function createRoutineMemoryWorkflow({ store } = {}) {
  if (!store
    || typeof store.proposeInferredCandidate !== "function"
    || typeof store.confirmCandidate !== "function"
    || typeof store.getPreference !== "function") {
    throw new Error("routine workflow 需要支持候选、确认和查询的家庭记忆存储");
  }

  return {
    async observe(event = {}) {
      if (event.event_type !== "routine_observation") {
        return failure("UNSUPPORTED_EVENT_TYPE", "只处理结构化 routine_observation 事件。");
      }
      if (event.consent_to_observe !== true) {
        return failure("MEMORY_CONSENT_REQUIRED", "观察和记录作息前必须取得用户明确同意。");
      }
      if (typeof event.event_id !== "string" || !event.event_id) {
        return failure("EVENT_ID_REQUIRED", "作息观察必须包含事件 ID。");
      }
      if (!ROUTINE_MEMORY_TYPES.has(event.routine_type)) {
        return failure("UNSUPPORTED_ROUTINE_TYPE", "只处理 sleep_time 或 wake_time 结构化观察。");
      }
      if (!validateTimeZone(event.time_zone)) {
        return failure("INVALID_TIME_ZONE", "事件必须提供有效的家庭 IANA 时区。");
      }
      const observationDate = localDateFor(event.occurred_at, event.time_zone);
      if (!observationDate) {
        return failure("INVALID_OCCURRED_AT", "事件必须提供含时区偏移的有效 occurred_at 时间。");
      }
      const routineTime = bucketTimeToQuarterHour(event.observed_time);
      if (!routineTime) {
        return failure("INVALID_LOCAL_TIME", "observed_time 必须是 24 小时制 HH:mm。");
      }

      const result = await store.proposeInferredCandidate({
        memory_type: event.routine_type,
        value: routineTime,
        event_id: event.event_id,
        observation_date: observationDate,
        time_zone: event.time_zone,
        day_type: dayTypeFor(observationDate),
        subject_id: event.subject_id ?? "household",
        confidence: event.confidence,
        consent_to_observe: true,
      });
      return { ...result, observation_date: observationDate, observed_time_bucket: routineTime };
    },

    confirm(memoryId, { user_confirmed = false } = {}) {
      return store.confirmCandidate(memoryId, { user_confirmed });
    },

    async previewRoutine({ routine_type, time_zone, day_type, subject_id = "household" } = {}) {
      if (!ROUTINE_MEMORY_TYPES.has(routine_type)) {
        return failure("UNSUPPORTED_ROUTINE_TYPE", "只支持 sleep_time 或 wake_time 作息建议。");
      }
      if (!validateTimeZone(time_zone)) {
        return failure("INVALID_TIME_ZONE", "预览作息前必须提供有效的家庭 IANA 时区。");
      }
      if (day_type !== undefined && !["weekday", "weekend"].includes(day_type)) {
        return failure("INVALID_DAY_TYPE", "day_type 只能是 weekday 或 weekend。");
      }
      const preference = await store.getPreference({
        memory_type: routine_type,
        time_zone,
        ...(day_type ? { day_type } : {}),
        subject_id,
      });
      if (!preference) {
        return {
          success: true,
          status: "NO_CONFIRMED_PREFERENCE",
          execution_performed: false,
          automation_enabled: false,
          suggestion: null,
        };
      }
      return {
        success: true,
        status: "PREVIEW_ONLY",
        execution_performed: false,
        automation_enabled: false,
        suggestion: {
          event_type: "routine_due",
          routine_type,
          local_time: preference.value,
          day_type: preference.scope.day_type ?? "all",
          time_zone,
          proposed_action: "notify_user",
          requires_separate_user_authorization_to_schedule: true,
        },
        note: "这是作息提醒建议；尚未创建定时器，也没有执行任何设备动作。",
      };
    },
  };
}
