import { Type } from "typebox";

import { createRoutineReminderRunner } from "../../agent-memory/src/routine-runner.js";
import { createRoutineDueEvaluator } from "../../agent-memory/src/routine-trigger.js";
import { RoutineNotificationInbox } from "./routine-notification-inbox.js";

const reminderLimitSchema = Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 }));

export const ROUTINE_NOTIFICATION_TOOL_DEFINITIONS = [
  {
    name: "check_household_routine_reminders",
    description: "按已确认作息检查当前是否到点，并将到期提醒写入本地收件箱。必须已有单独的提醒授权和本机 DEVICE_MANAGER_ROUTINE_SCHEDULE_ENABLED=true；只响应用户查看/检查提醒或本地调度器调用，不会推送消息或控制设备。",
    inputSchema: Type.Object({}, { additionalProperties: false }),
  },
  {
    name: "start_household_routine_reminders",
    description: "只有用户明确要求现在开始按已确认作息提醒时才调用。需要用户已开启提醒授权及本机 DEVICE_MANAGER_ROUTINE_SCHEDULE_ENABLED=true；启动后只周期检查并写入本地收件箱，不发送外部推送、不执行设备动作。",
    inputSchema: Type.Object({}, { additionalProperties: false }),
  },
  {
    name: "stop_household_routine_reminders",
    description: "停止本插件进程内的作息提醒周期检查；不会删除已排队的提醒或作息偏好。",
    inputSchema: Type.Object({}, { additionalProperties: false }),
  },
  {
    name: "get_household_routine_reminder_status",
    description: "查看本地作息提醒开关、运行状态和时区配置状态；不返回具体作息时间或提醒内容。",
    inputSchema: Type.Object({}, { additionalProperties: false }),
  },
  {
    name: "list_household_routine_reminders",
    description: "查看本地提醒收件箱。默认仅列待处理提醒；用户要求查看历史时才包含已确认记录。",
    inputSchema: Type.Object({
      include_acknowledged: Type.Optional(Type.Boolean({ default: false })),
      limit: reminderLimitSchema,
    }, { additionalProperties: false }),
  },
  {
    name: "acknowledge_household_routine_reminder",
    description: "仅在用户看见具体提醒并明确表示已知晓/可以标记完成后调用；只确认提醒已读，不改变偏好、不执行任何设备动作。",
    inputSchema: Type.Object({
      notification_id: Type.String({ minLength: 1 }),
      user_acknowledged: Type.Boolean({ description: "只有用户刚刚明确表示已知晓这条提醒时才能为 true。" }),
    }, { additionalProperties: false }),
  },
];

function failure(code, message) {
  return { success: false, status: "REJECTED", execution_performed: false, error: { code, message } };
}

function isValidTimeZone(timeZone) {
  if (typeof timeZone !== "string" || !timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Local routine reminder tools. Periodic checks are never started at plugin
 * load: startup is a separate user-facing action and additionally requires a
 * trusted local feature flag plus the persisted household consent.
 */
export function createHouseholdRoutineNotificationTools({
  store,
  inbox = new RoutineNotificationInbox(),
  timeZone = process.env.HOUSEHOLD_TIME_ZONE?.trim(),
  scheduleAuthorized = process.env.DEVICE_MANAGER_ROUTINE_SCHEDULE_ENABLED === "true",
  pollIntervalMs = 15_000,
  triggerWindowMs = 60_000,
  clock = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (!store || typeof store.getPreference !== "function" || typeof store.getRoutineReminderConsent !== "function") {
    throw new Error("作息提醒工具需要家庭记忆存储。 ");
  }
  if (!inbox || typeof inbox.enqueue !== "function" || typeof inbox.list !== "function" || typeof inbox.acknowledge !== "function") {
    throw new Error("作息提醒工具需要本地提醒收件箱。 ");
  }

  let runner = null;
  const timeZoneConfigured = typeof timeZone === "string" && timeZone.length > 0;
  const timeZoneValid = timeZoneConfigured && isValidTimeZone(timeZone);
  if (timeZoneValid) {
    const evaluator = createRoutineDueEvaluator({
      store,
      scheduleAuthorized: true,
      clock,
      triggerWindowMs,
    });
    runner = createRoutineReminderRunner({
      evaluator,
      time_zone: timeZone,
      scheduleAuthorized: scheduleAuthorized === true,
      authorizationProvider: () => store.getRoutineReminderConsent(),
      pollIntervalMs,
      onDueEvent: (event, { idempotencyKey }) => inbox.enqueue(event, { idempotencyKey }),
      setIntervalFn,
      clearIntervalFn,
    });
  }

  async function enrich(result) {
    if (!result?.success) return result;
    const pending = await inbox.list({ limit: 50 });
    return {
      ...result,
      pending_notifications: pending.success ? pending.notifications : [],
      ...(pending.success ? {} : { inbox_error: pending.error }),
      delivery_channel: "local_openclaw_inbox_only",
      external_push_sent: false,
      device_action_performed: false,
    };
  }

  return {
    async check_household_routine_reminders() {
      if (!runner) return timeZoneConfigured
        ? failure("INVALID_HOUSEHOLD_TIME_ZONE", "本机 HOUSEHOLD_TIME_ZONE 不是有效 IANA 时区；本次没有运行检查。 ")
        : failure("HOUSEHOLD_TIME_ZONE_REQUIRED", "请先在本机配置有效的 HOUSEHOLD_TIME_ZONE，例如 Asia/Shanghai；本次没有运行检查。 ");
      return enrich(await runner.poll());
    },
    async start_household_routine_reminders() {
      if (!runner) return timeZoneConfigured
        ? failure("INVALID_HOUSEHOLD_TIME_ZONE", "本机 HOUSEHOLD_TIME_ZONE 不是有效 IANA 时区；本次没有启动定时检查。 ")
        : failure("HOUSEHOLD_TIME_ZONE_REQUIRED", "请先在本机配置有效的 HOUSEHOLD_TIME_ZONE；本次没有启动定时检查。 ");
      return enrich(await runner.start());
    },
    stop_household_routine_reminders() {
      return runner?.stop() ?? { success: true, status: "NOT_RUNNING", execution_performed: false };
    },
    async get_household_routine_reminder_status() {
      const consent = await store.getRoutineReminderConsent();
      return {
        success: true,
        status: "STATUS",
        schedule_authorized: scheduleAuthorized === true,
        user_consent_enabled: consent?.enabled === true,
        time_zone_configured: timeZoneValid,
        runner: runner?.getStatus() ?? { running: false },
        storage: "local_application_data",
        external_push_configured: false,
        device_actions_allowed: false,
      };
    },
    list_household_routine_reminders: (args = {}) => inbox.list({
      include_acknowledged: args.include_acknowledged === true,
      limit: args.limit ?? 20,
    }),
    acknowledge_household_routine_reminder: (args = {}) => inbox.acknowledge(args),
  };
}

