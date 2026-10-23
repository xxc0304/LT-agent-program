const DEFAULT_POLL_INTERVAL_MS = 15_000;
const MAX_POLL_INTERVAL_MS = 60 * 60_000;

/**
 * Opt-in clock runner around createRoutineDueEvaluator.
 *
 * Delivery is at-least-once across process restarts: event_id and
 * idempotency_key are stable, so the injected sink must deduplicate them in
 * its durable boundary. This module itself never sends notifications or
 * performs device actions.
 */
export function createRoutineReminderRunner({
  evaluator,
  time_zone,
  subject_id = "household",
  scheduleAuthorized = false,
  authorizationProvider,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  onDueEvent,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (!evaluator || typeof evaluator.poll !== "function") {
    throw new Error("作息提醒运行器需要 due evaluator.poll()。");
  }
  if (typeof time_zone !== "string" || !time_zone) {
    throw new Error("作息提醒运行器需要家庭 IANA 时区。");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: time_zone });
  } catch {
    throw new Error("time_zone 必须是有效的家庭 IANA 时区。");
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1_000 || pollIntervalMs > MAX_POLL_INTERVAL_MS) {
    throw new Error("pollIntervalMs 必须是 1 秒到 1 小时之间的整数毫秒数。");
  }
  if (typeof onDueEvent !== "function") {
    throw new Error("作息提醒运行器需要明确注入 onDueEvent 接收器。");
  }
  if (authorizationProvider !== undefined && typeof authorizationProvider !== "function") {
    throw new Error("authorizationProvider 必须是读取持久作息提醒授权的函数。");
  }
  if (typeof setIntervalFn !== "function" || typeof clearIntervalFn !== "function") {
    throw new Error("必须提供有效的定时器函数。");
  }

  let timer = null;
  let polling = false;
  const deliveredKeys = new Set();

  async function checkAuthorization() {
    if (scheduleAuthorized !== true) return { enabled: false, reason: "LOCAL_SCHEDULE_DISABLED" };
    if (!authorizationProvider) return { enabled: true };
    try {
      const consent = await authorizationProvider();
      return consent?.success === false || consent?.enabled !== true
        ? { enabled: false, reason: "USER_CONSENT_DISABLED" }
        : { enabled: true };
    } catch {
      return { enabled: false, reason: "AUTHORIZATION_CHECK_FAILED" };
    }
  }

  function stopTimer() {
    if (timer === null) return false;
    clearIntervalFn(timer);
    timer = null;
    return true;
  }

  async function poll() {
    const authorization = await checkAuthorization();
    if (!authorization.enabled) {
      stopTimer();
      return {
        success: authorization.reason !== "AUTHORIZATION_CHECK_FAILED",
        status: authorization.reason === "AUTHORIZATION_CHECK_FAILED"
          ? "AUTHORIZATION_CHECK_FAILED"
          : "SCHEDULE_AUTHORIZATION_REQUIRED",
        reason: authorization.reason,
        events_considered: 0,
        events_delivered: 0,
        execution_performed: false,
      };
    }
    if (polling) {
      return {
        success: true,
        status: "POLL_ALREADY_RUNNING",
        events_considered: 0,
        events_delivered: 0,
        execution_performed: false,
      };
    }

    polling = true;
    try {
      let evaluation;
      try {
        evaluation = await evaluator.poll({ time_zone, subject_id });
      } catch (error) {
        return {
          success: false,
          status: "EVALUATION_FAILED",
          error: {
            code: "ROUTINE_EVALUATION_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
          events_considered: 0,
          events_delivered: 0,
          execution_performed: false,
        };
      }
      if (!evaluation?.success) {
        return {
          success: false,
          status: evaluation?.status ?? "EVALUATION_FAILED",
          error: evaluation?.error ?? { code: "ROUTINE_EVALUATION_FAILED" },
          events_considered: 0,
          events_delivered: 0,
          execution_performed: false,
        };
      }

      const events = Array.isArray(evaluation.events) ? evaluation.events : [];
      const delivered = [];
      const failures = [];
      let alreadyDelivered = 0;
      for (const event of events) {
        const idempotencyKey = event?.dedup_key;
        if (typeof idempotencyKey !== "string" || !idempotencyKey) {
          failures.push({ event_id: event?.event_id ?? null, code: "EVENT_IDEMPOTENCY_KEY_REQUIRED" });
          continue;
        }
        if (deliveredKeys.has(idempotencyKey)) {
          alreadyDelivered += 1;
          continue;
        }
        try {
          const receipt = await onDueEvent(structuredClone(event), {
            idempotencyKey,
            eventId: event.event_id,
            subjectId: subject_id,
          });
          if (receipt?.success === false) {
            failures.push({
              event_id: event.event_id,
              code: receipt.error?.code ?? "EVENT_SINK_REJECTED",
            });
            continue;
          }
          deliveredKeys.add(idempotencyKey);
          delivered.push(event.event_id);
        } catch (error) {
          failures.push({
            event_id: event.event_id,
            code: "EVENT_SINK_FAILED",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return {
        success: failures.length === 0,
        status: failures.length
          ? "DELIVERY_PARTIAL"
          : (delivered.length ? "EVENTS_DELIVERED" : (alreadyDelivered ? "EVENTS_ALREADY_DELIVERED" : evaluation.status)),
        events_considered: events.length,
        events_delivered: delivered.length,
        events_skipped_as_duplicate: alreadyDelivered,
        delivered_event_ids: delivered,
        failures,
        execution_performed: false,
        note: "事件交给了注入的接收器；运行器本身不发送通知，也不控制设备。",
      };
    } finally {
      polling = false;
    }
  }

  return {
    poll,
    async start() {
      const authorization = await checkAuthorization();
      if (!authorization.enabled) {
        stopTimer();
        return {
          success: authorization.reason !== "AUTHORIZATION_CHECK_FAILED",
          status: authorization.reason === "AUTHORIZATION_CHECK_FAILED"
            ? "AUTHORIZATION_CHECK_FAILED"
            : "SCHEDULE_AUTHORIZATION_REQUIRED",
          reason: authorization.reason,
          execution_performed: false,
          note: "需要可信本地功能开关和持久化用户授权均开启；当前没有启动定时器。",
        };
      }
      if (timer !== null) {
        return { success: true, status: "ALREADY_RUNNING", poll_interval_ms: pollIntervalMs };
      }
      timer = setIntervalFn(() => {
        void poll();
      }, pollIntervalMs);
      const initialPoll = await poll();
      return {
        success: true,
        status: "RUNNING",
        poll_interval_ms: pollIntervalMs,
        time_zone,
        initial_poll: initialPoll,
        note: "周期检查已启动；提醒交付由注入的事件接收器负责。",
      };
    },
    stop() {
      if (timer === null) return { success: true, status: "NOT_RUNNING" };
      clearIntervalFn(timer);
      timer = null;
      return { success: true, status: "STOPPED" };
    },
    getStatus() {
      return {
        running: timer !== null,
        schedule_authorized: scheduleAuthorized === true,
        user_consent_provider_configured: Boolean(authorizationProvider),
        poll_interval_ms: pollIntervalMs,
        time_zone,
        delivered_keys_in_process: deliveredKeys.size,
      };
    },
  };
}

export const ROUTINE_RUNNER_DEFAULTS = Object.freeze({
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  maxPollIntervalMs: MAX_POLL_INTERVAL_MS,
  scheduleAuthorized: false,
  deliverySemantics: "at_least_once_across_process_restarts",
});
