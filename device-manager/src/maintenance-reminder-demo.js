import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MaintenanceReminderInbox } from "./maintenance-reminder-inbox.js";
import { MaintenanceReminderRunnerStateStore } from "./maintenance-reminder-runner-state.js";
import { MaintenanceScheduleStore } from "./maintenance-store.js";
import { createMaintenanceReminderTools } from "./maintenance-reminder-tools.js";
import { createEnergyOperationsTools } from "./energy-operations-tools.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const BASE_TIME = Date.parse("2026-10-18T10:00:00.000Z");
const SCHEDULE_ID = "mock-air-filter";

function childEnvironment() {
  const env = {};
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path");
  for (const key of [pathKey, "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    if (key && process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function runPhase(phase, stateDir, nowMs) {
  const child = spawnSync(process.execPath, [SCRIPT_PATH, "--worker", phase, stateDir, String(nowMs)], {
    encoding: "utf8",
    windowsHide: true,
    env: childEnvironment(),
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(`维护提醒演示阶段 ${phase} 失败，退出码 ${child.status}: ${child.stderr.trim()}`);
  }
  try {
    return JSON.parse(child.stdout);
  } catch {
    throw new Error(`维护提醒演示阶段 ${phase} 未返回有效 JSON。`);
  }
}

function makeTools(stateDir, nowMs) {
  const statePath = path.join(stateDir, "device-manager");
  const clock = () => nowMs;
  const scheduleStore = new MaintenanceScheduleStore({
    filePath: path.join(statePath, "maintenance-schedules.json"),
    clock,
  });
  const inbox = new MaintenanceReminderInbox({
    filePath: path.join(statePath, "maintenance-reminders.json"),
    clock,
  });
  const tools = createMaintenanceReminderTools({
    scheduleStore,
    inbox,
    runnerStateStore: new MaintenanceReminderRunnerStateStore({
      filePath: path.join(statePath, "maintenance-reminder-runner.json"),
      clock,
    }),
    clock,
    scheduleAuthorized: false,
  });
  return {
    tools,
    scheduleStore,
    energyOperations: createEnergyOperationsTools({ maintenanceStore: scheduleStore, reminderInbox: inbox, clock }),
  };
}

async function executeWorker(phase, stateDir, nowMs) {
  const { tools, scheduleStore, energyOperations } = makeTools(stateDir, nowMs);
  if (phase === "seed") {
    const seeded = await scheduleStore.upsertSchedule({
      schedule_id: SCHEDULE_ID,
      device_id: "air.purifier.study",
      device_name: "书房空气净化器（Mock）",
      maintenance_type: "filter_replacement",
      next_due_at: new Date(BASE_TIME + 2 * DAY_MS).toISOString(),
      interval_days: 30,
    });
    if (!seeded.success) throw new Error("无法建立合成维护计划。");
    const check = await tools.check_maintenance_reminders();
    if (!check.success || check.reminders_created !== 1) throw new Error("未能创建预期的近期维护提醒。");
    const [reminder] = check.pending_notifications;
    return {
      phase,
      status: reminder?.maintenance_status,
      notification_id: reminder?.notification_id,
      reminders_created: check.reminders_created,
      periodic_runner_started: false,
    };
  }

  if (phase === "restart-check") {
    const check = await tools.check_maintenance_reminders();
    const list = await tools.list_maintenance_reminders();
    if (!check.success || check.reminders_created !== 0 || list.notifications.length !== 1) {
      throw new Error("新 Node.js 进程未能读回并去重现有提醒。");
    }
    return {
      phase,
      reminders_created: check.reminders_created,
      duplicate_checks_skipped: check.duplicate_checks_skipped,
      pending_count: list.notifications.length,
      status: list.notifications[0]?.maintenance_status,
      notification_id: list.notifications[0]?.notification_id,
      process_restarted: true,
    };
  }

  if (phase === "snooze") {
    const [reminder] = (await tools.list_maintenance_reminders()).notifications;
    if (!reminder) throw new Error("无法找到用于暂缓演示的提醒。");
    const snoozed = await tools.snooze_maintenance_reminder({
      notification_id: reminder.notification_id,
      snooze_for_minutes: 10,
      user_requested: true,
    });
    if (!snoozed.success) throw new Error("无法暂缓合成维护提醒。");
    return {
      phase,
      status: snoozed.status,
      notification_id: snoozed.notification_id,
      snoozed_until: snoozed.snoozed_until,
      maintenance_completed: snoozed.maintenance_completed,
      user_interaction_performed: false,
    };
  }

  if (phase === "snooze-expired") {
    const checked = await tools.check_maintenance_reminders();
    const [reminder] = (await tools.list_maintenance_reminders()).notifications;
    if (!checked.success || !reminder) throw new Error("暂缓到期后提醒未重新进入待处理。");
    return {
      phase,
      status: reminder.status,
      notification_id: reminder.notification_id,
      snoozed_reopened: checked.snoozed_reopened,
      maintenance_completed: false,
    };
  }

  if (phase === "acknowledge") {
    const list = await tools.list_maintenance_reminders();
    const reminder = list.notifications[0];
    if (!reminder) throw new Error("没有可确认已读的演示提醒。");
    const result = await tools.acknowledge_maintenance_reminder({
      notification_id: reminder.notification_id,
      user_acknowledged: true,
    });
    if (!result.success || result.maintenance_completed !== false) throw new Error("已读确认边界不符合预期。");
    return {
      phase,
      status: result.status,
      maintenance_completed: result.maintenance_completed,
      acknowledgment_source: "synthetic_demo_fixture",
      user_interaction_performed: false,
      pending_count_after_acknowledgment: (await tools.list_maintenance_reminders()).notifications.length,
    };
  }

  if (phase === "overdue-check") {
    const check = await tools.check_maintenance_reminders();
    const [reminder] = check.pending_notifications;
    if (!check.success || check.reminders_updated !== 1 || reminder?.maintenance_status !== "OVERDUE") {
      throw new Error("逾期升级未能更新并重新打开同一提醒。");
    }
    return {
      phase,
      reminders_updated: check.reminders_updated,
      status: reminder.maintenance_status,
      notification_id: reminder.notification_id,
      reopened_after_escalation: reminder.status === "pending",
    };
  }

  if (phase === "maintenance-completed") {
    const completed = await energyOperations.record_device_maintenance_completed({
      schedule_id: SCHEDULE_ID,
      user_confirmed: true,
    });
    const pending = await tools.list_maintenance_reminders();
    const history = await tools.list_maintenance_reminders({ include_completed: true });
    if (!completed.success || completed.reminder_resolution?.resolved_count !== 1
      || pending.notifications.length !== 0 || history.notifications[0]?.status !== "completed") {
      throw new Error("显式维护完成后未能关闭同周期提醒并保留完成历史。");
    }
    return {
      phase,
      completion_recorded: completed.completion_recorded,
      reminders_resolved: completed.reminder_resolution.resolved_count,
      pending_count: pending.notifications.length,
      completed_history_count: history.notifications.length,
      physical_maintenance_performed_by_agent: completed.physical_maintenance_performed_by_agent,
      completion_source: "synthetic_demo_fixture",
      user_interaction_performed: false,
      next_due_at: completed.schedule.next_due_at,
    };
  }

  if (phase === "next-cycle-check") {
    const check = await tools.check_maintenance_reminders();
    const pending = await tools.list_maintenance_reminders();
    const history = await tools.list_maintenance_reminders({ include_completed: true, limit: 10 });
    const schedules = await scheduleStore.listSchedules();
    const currentSchedule = schedules.find((item) => item.schedule_id === SCHEDULE_ID);
    const completed = history.notifications.find((item) => item.status === "completed");
    const nextReminder = pending.notifications[0];
    if (!check.success || check.reminders_created !== 1 || !currentSchedule || !completed || !nextReminder
      || nextReminder.notification_id === completed.notification_id
      || nextReminder.next_due_at !== currentSchedule.next_due_at) {
      throw new Error("下一维护周期未生成独立提醒，或旧周期完成历史未保留。");
    }
    return {
      phase,
      reminders_created: check.reminders_created,
      status: nextReminder.maintenance_status,
      pending_count: pending.notifications.length,
      notification_id: nextReminder.notification_id,
      previous_cycle_notification_id: completed.notification_id,
      next_due_at: nextReminder.next_due_at,
      completed_history_count: history.notifications.filter((item) => item.status === "completed").length,
      previous_cycle_preserved: true,
    };
  }

  if (phase === "archive-completed") {
    const cutoff = new Date(BASE_TIME + 3 * DAY_MS).toISOString();
    const archived = await tools.archive_completed_maintenance_reminders({
      completed_before: cutoff,
      user_confirmed: true,
    });
    const pending = await tools.list_maintenance_reminders();
    const history = await tools.list_maintenance_reminders({ include_archived: true, limit: 10 });
    const archivedItem = history.notifications.find((item) => item.archived === true);
    if (!archived.success || archived.archived_count !== 1 || pending.notifications.length !== 1
      || !archivedItem || archivedItem.schedule_id !== SCHEDULE_ID) {
      throw new Error("已完成旧周期归档失败，或影响了下一周期待处理提醒。");
    }
    return {
      phase,
      archived_count: archived.archived_count,
      active_pending_count: pending.notifications.length,
      archive_history_count: history.notifications.filter((item) => item.archived).length,
      archived_notification_id: archivedItem.notification_id,
      notifications_deleted: archived.notifications_deleted,
      user_interaction_performed: false,
      confirmation_source: "synthetic_demo_fixture",
    };
  }

  throw new Error(`未知演示阶段：${phase}`);
}

export async function runMaintenanceReminderDemo() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lt-maintenance-reminder-demo-"));
  try {
    const initial = runPhase("seed", tempDir, BASE_TIME);
    const restarted = runPhase("restart-check", tempDir, BASE_TIME);
    const snoozed = runPhase("snooze", tempDir, BASE_TIME);
    const snoozeExpired = runPhase("snooze-expired", tempDir, BASE_TIME + 10 * 60_000);
    const acknowledged = runPhase("acknowledge", tempDir, BASE_TIME + 10 * 60_000);
    const overdue = runPhase("overdue-check", tempDir, BASE_TIME + 3 * DAY_MS);
    const maintenanceCompleted = runPhase("maintenance-completed", tempDir, BASE_TIME + 3 * DAY_MS);
    const nextCycle = runPhase("next-cycle-check", tempDir, BASE_TIME + (3 + 30 - 7) * DAY_MS);
    const archived = runPhase("archive-completed", tempDir, BASE_TIME + (3 + 30 - 7) * DAY_MS);
    if ([restarted, snoozed, snoozeExpired, overdue].some((phase) => initial.notification_id !== phase.notification_id)) {
      throw new Error("同一维护周期的提醒 ID 未保持稳定。");
    }
    if (nextCycle.notification_id === initial.notification_id
      || nextCycle.previous_cycle_notification_id !== initial.notification_id) {
      throw new Error("下一周期必须创建独立提醒并保留旧周期 ID。");
    }
    if (archived.archived_notification_id !== initial.notification_id) {
      throw new Error("归档演示必须保留并核对旧周期提醒 ID。");
    }
    return {
      demo: "maintenance-reminder-inbox",
      evidence: "synthetic_schedule_and_local_temporary_files",
      phases: {
        initial,
        restarted,
        snoozed,
        snooze_expired: snoozeExpired,
        acknowledged,
        overdue,
        maintenance_completed: maintenanceCompleted,
        next_cycle: nextCycle,
        archived,
      },
      guardrails: {
        real_openclaw_gateway_used: false,
        real_home_assistant_used: false,
        model_api_called: false,
        external_notification_sent: false,
        periodic_timer_started: false,
        device_action_performed: false,
        physical_maintenance_performed: false,
        temporary_state_removed: true,
      },
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function runWorkerCli() {
  try {
    const [, , , phase, stateDir, nowMsText] = process.argv;
    const stateDirResolved = path.resolve(stateDir);
    const nowMs = Number(nowMsText);
    if (!Number.isFinite(nowMs)) throw new Error("演示时钟无效。");
    process.stdout.write(`${JSON.stringify(await executeWorker(phase, stateDirResolved, nowMs))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[2] === "--worker") {
  void runWorkerCli();
} else if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  void runMaintenanceReminderDemo()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
