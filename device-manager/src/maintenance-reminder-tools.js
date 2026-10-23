import { Type } from "typebox";

import { buildMaintenancePlan } from "./maintenance-planner.js";
import { MaintenanceReminderInbox } from "./maintenance-reminder-inbox.js";
import { MaintenanceReminderRunnerStateStore } from "./maintenance-reminder-runner-state.js";

const DEFAULT_POLL_INTERVAL_MS = 60 * 60_000;
const MAX_POLL_INTERVAL_MS = 24 * 60 * 60_000;

export const MAINTENANCE_REMINDER_TOOL_DEFINITIONS = Object.freeze([
  {
    name: "check_maintenance_reminders",
    description: "按已保存维护计划立即检查 DUE_SOON/DUE/OVERDUE 项目并写入本机维护提醒收件箱。只排队本地提醒；不发外部消息、不执行维护或设备动作。",
    inputSchema: Type.Object({ now: Type.Optional(Type.String()) }, { additionalProperties: false }),
  },
  {
    name: "start_maintenance_reminders",
    description: "仅在用户明确要求开始周期维护提醒时调用。需管理员已设置 DEVICE_MANAGER_MAINTENANCE_REMINDERS_ENABLED=true。默认只运行到本次 Gateway 进程结束；只有用户明确要求‘重启后继续/持续运行’时才将 resume_after_gateway_restart 设为 true。恢复仅重新检查维护计划并写本机收件箱，不发外部消息或执行设备动作。",
    inputSchema: Type.Object({ resume_after_gateway_restart: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  },
  {
    name: "stop_maintenance_reminders",
    description: "停止本插件进程内的周期维护计划检查；不删除已排队的提醒或维护记录。",
    inputSchema: Type.Object({}, { additionalProperties: false }),
  },
  {
    name: "get_maintenance_reminder_status",
    description: "查看本机维护周期检查的功能开关、运行状态和本地收件箱待处理数量；不返回维护历史全文。",
    inputSchema: Type.Object({}, { additionalProperties: false }),
  },
  {
    name: "list_maintenance_reminders",
    description: "分页列出本机维护提醒，默认显示最近 20 条待处理提醒；include_archived=true 可查询保留的归档完成历史。静态列表可用 offset/limit，列表可能变化时优先使用回执 next_cursor 继续。已读只代表用户看见提醒，不代表维护已完成。",
    inputSchema: Type.Object({
      include_acknowledged: Type.Optional(Type.Boolean()),
      include_snoozed: Type.Optional(Type.Boolean()),
      include_completed: Type.Optional(Type.Boolean()),
      include_archived: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 500 })),
      cursor: Type.Optional(Type.String({ minLength: 1 })),
    }, { additionalProperties: false }),
  },
  {
    name: "archive_completed_maintenance_reminders",
    description: "仅在向用户说明筛选规则并取得明确确认后调用。将 completed_at 不晚于 completed_before 的已完成维护提醒移入同一文件的归档区，释放活动收件箱容量；不删除记录、不归档待处理/已读/暂缓提醒。归档历史可用 list_maintenance_reminders(include_archived=true) 查询。",
    inputSchema: Type.Object({
      completed_before: Type.String({ minLength: 1 }),
      user_confirmed: Type.Boolean(),
    }, { additionalProperties: false }),
  },
  {
    name: "acknowledge_maintenance_reminder",
    description: "仅在用户看见具体维护提醒并明确表示已知晓后调用；只标记已读，不代表已执行维护。",
    inputSchema: Type.Object({
      notification_id: Type.String({ minLength: 1 }),
      user_acknowledged: Type.Boolean(),
    }, { additionalProperties: false }),
  },
  {
    name: "snooze_maintenance_reminder",
    description: "仅在用户明确要求稍后再提醒，并明确给出暂缓时长后调用；将该本地提醒暂缓 5 分钟到 30 天。时长到期后下次检查/查看时重新进入待处理。不会标记已读、维护完成或发送外部通知；维护状态升级为逾期时会提前重新打开提醒。",
    inputSchema: Type.Object({
      notification_id: Type.String({ minLength: 1 }),
      snooze_for_minutes: Type.Integer({ minimum: 5, maximum: 30 * 24 * 60 }),
      user_requested: Type.Boolean(),
    }, { additionalProperties: false }),
  },
]);

function failure(code, message) {
  return { success: false, status: "REJECTED", execution_performed: false, error: { code, message } };
}

export function createMaintenanceReminderTools({
  scheduleStore,
  inbox = new MaintenanceReminderInbox(),
  runnerStateStore = new MaintenanceReminderRunnerStateStore(),
  scheduleAuthorized = process.env.DEVICE_MANAGER_MAINTENANCE_REMINDERS_ENABLED === "true",
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  clock = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (!scheduleStore || typeof scheduleStore.listSchedules !== "function") {
    throw new Error("维护提醒工具需要维护日程存储");
  }
  if (!inbox || typeof inbox.upsertDueReminders !== "function"
    || typeof inbox.list !== "function" || typeof inbox.acknowledge !== "function"
    || typeof inbox.snooze !== "function" || typeof inbox.archiveCompletedBefore !== "function") {
    throw new Error("维护提醒工具需要本地收件箱");
  }
  if (!runnerStateStore || typeof runnerStateStore.get !== "function" || typeof runnerStateStore.setAutoResume !== "function") {
    throw new Error("维护提醒工具需要恢复状态存储");
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 60_000 || pollIntervalMs > MAX_POLL_INTERVAL_MS) {
    throw new Error("pollIntervalMs 必须是 1 分钟到 24 小时之间的整数毫秒数");
  }
  if (typeof clock !== "function" || typeof setIntervalFn !== "function" || typeof clearIntervalFn !== "function") {
    throw new Error("维护提醒工具需要有效的时钟和定时器");
  }

  let timer = null;
  let polling = false;

  async function checkOnce(now) {
    const nowDate = now === undefined ? new Date(clock()) : new Date(now);
    if (!Number.isFinite(nowDate.getTime())) return failure("INVALID_CHECK_TIME", "now 必须是有效 ISO 时间。");
    let schedules;
    try {
      schedules = await scheduleStore.listSchedules();
    } catch (error) {
      return failure("MAINTENANCE_SCHEDULE_READ_FAILED", error instanceof Error ? error.message : "读取维护计划失败");
    }
    let plan;
    try {
      plan = buildMaintenancePlan({ schedules, now: nowDate });
    } catch (error) {
      return failure("MAINTENANCE_PLAN_FAILED", error instanceof Error ? error.message : "生成维护计划失败");
    }
    const queued = await inbox.upsertDueReminders({
      plan_items: plan.items,
      schedules,
      observed_at: nowDate.toISOString(),
    });
    if (!queued.success) return { ...queued, execution_performed: false, plan_summary: plan.summary };
    const pending = await inbox.list({ limit: 50 });
    return {
      success: true,
      status: queued.created || queued.updated ? "REMINDERS_QUEUED" : "NO_NEW_REMINDERS",
      plan_summary: plan.summary,
      reminders_created: queued.created,
      reminders_updated: queued.updated,
      duplicate_checks_skipped: queued.skipped_as_duplicate,
      snoozed_reopened: queued.snoozed_reopened ?? 0,
      pending_notifications: pending.success ? pending.notifications : [],
      ...(pending.success ? {} : { inbox_error: pending.error }),
      delivery_channel: "local_openclaw_inbox_only",
      external_push_sent: false,
      maintenance_performed: false,
      device_action_performed: false,
    };
  }

  async function poll() {
    if (scheduleAuthorized !== true) {
      if (timer !== null) clearIntervalFn(timer);
      timer = null;
      return failure("LOCAL_SCHEDULE_DISABLED", "本机维护提醒功能开关未启用；已停止周期检查。 ");
    }
    if (polling) return { success: true, status: "POLL_ALREADY_RUNNING", execution_performed: false };
    polling = true;
    try {
      return await checkOnce();
    } finally {
      polling = false;
    }
  }

  async function startTimer() {
    if (timer !== null) return { success: true, status: "ALREADY_RUNNING", poll_interval_ms: pollIntervalMs };
    timer = setIntervalFn(() => { void poll(); }, pollIntervalMs);
    const initialPoll = await poll();
    return {
      success: true,
      status: "RUNNING",
      poll_interval_ms: pollIntervalMs,
      initial_poll: initialPoll,
      external_push_configured: false,
      maintenance_performed: false,
      device_action_performed: false,
      note: "只在本机维护提醒收件箱排队，不会发送外部通知或执行维护。",
    };
  }

  return {
    check_maintenance_reminders: ({ now } = {}) => checkOnce(now),
    async start_maintenance_reminders({ resume_after_gateway_restart = false } = {}) {
      if (scheduleAuthorized !== true) {
        return failure("LOCAL_SCHEDULE_DISABLED", "只有管理员在本机启用 DEVICE_MANAGER_MAINTENANCE_REMINDERS_ENABLED=true 后才能启动；当前没有启动定时器。 ");
      }
      if (typeof resume_after_gateway_restart !== "boolean") {
        return failure("INVALID_RESUME_PREFERENCE", "resume_after_gateway_restart 必须为布尔值。");
      }
      const saved = await runnerStateStore.setAutoResume(resume_after_gateway_restart);
      if (!saved.success) return failure(saved.error?.code ?? "RUNNER_STATE_WRITE_FAILED", saved.error?.message ?? "无法保存维护提醒恢复设置。 ");
      return { ...(await startTimer()), auto_resume_after_gateway_restart: resume_after_gateway_restart };
    },
    async resume_maintenance_reminders() {
      if (scheduleAuthorized !== true) {
        return failure("LOCAL_SCHEDULE_DISABLED", "管理员本机开关未启用；未恢复周期维护检查。 ");
      }
      const saved = await runnerStateStore.get();
      if (!saved.success) return failure(saved.error?.code ?? "RUNNER_STATE_READ_FAILED", saved.error?.message ?? "无法读取维护提醒恢复设置。 ");
      if (saved.auto_resume !== true) return { success: true, status: "NOT_CONFIGURED", execution_performed: false };
      return { ...(await startTimer()), auto_resume_after_gateway_restart: true, resumed_after_gateway_start: true };
    },
    async stop_maintenance_reminders({ clear_auto_resume = true } = {}) {
      const wasRunning = timer !== null;
      if (timer !== null) {
        clearIntervalFn(timer);
        timer = null;
      }
      if (clear_auto_resume) {
        const saved = await runnerStateStore.setAutoResume(false);
        if (!saved.success) {
          return failure(saved.error?.code ?? "RUNNER_STATE_WRITE_FAILED", `定时器已停止，但无法清除重启恢复设置：${saved.error?.message ?? "未知存储错误"}`);
        }
      }
      return { success: true, status: wasRunning ? "STOPPED" : "NOT_RUNNING", execution_performed: false, auto_resume_after_gateway_restart: clear_auto_resume ? false : undefined };
    },
    async get_maintenance_reminder_status() {
      const pending = await inbox.list({ limit: 50 });
      const saved = await runnerStateStore.get();
      return {
        success: true,
        status: "STATUS",
        schedule_authorized: scheduleAuthorized === true,
        runner: { running: timer !== null, poll_interval_ms: pollIntervalMs },
        auto_resume_after_gateway_restart: saved.success ? saved.auto_resume : null,
        runner_state_error: saved.success ? undefined : saved.error,
        pending_count: pending.success ? pending.notifications.length : null,
        inbox_error: pending.success ? undefined : pending.error,
        delivery_channel: "local_openclaw_inbox_only",
        external_push_configured: false,
        device_actions_allowed: false,
      };
    },
    list_maintenance_reminders: (args = {}) => inbox.list({
      include_acknowledged: args.include_acknowledged === true,
      include_snoozed: args.include_snoozed === true,
      include_completed: args.include_completed === true,
      include_archived: args.include_archived === true,
      limit: args.limit ?? 20,
      offset: args.offset ?? 0,
      cursor: args.cursor,
    }),
    acknowledge_maintenance_reminder: (args = {}) => inbox.acknowledge(args),
    snooze_maintenance_reminder: (args = {}) => inbox.snooze(args),
    archive_completed_maintenance_reminders: (args = {}) => inbox.archiveCompletedBefore(args),
  };
}

export const MAINTENANCE_REMINDER_DEFAULTS = Object.freeze({
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  maxPollIntervalMs: MAX_POLL_INTERVAL_MS,
  scheduleAuthorized: false,
  startsAtPluginLoad: false,
  autoResumeByDefault: false,
  externalPush: false,
  deviceActions: false,
});
