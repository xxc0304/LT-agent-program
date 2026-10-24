import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MaintenanceScheduleStore, resolveMaintenanceSchedulePath } from "../src/maintenance-store.js";
import { MaintenanceReminderInbox, resolveMaintenanceReminderInboxPath } from "../src/maintenance-reminder-inbox.js";
import { MaintenanceReminderRunnerStateStore, resolveMaintenanceReminderRunnerStatePath } from "../src/maintenance-reminder-runner-state.js";
import {
  createMaintenanceReminderTools,
  MAINTENANCE_REMINDER_TOOL_DEFINITIONS,
} from "../src/maintenance-reminder-tools.js";
import { createEnergyOperationsTools } from "../src/energy-operations-tools.js";

const NOW = Date.parse("2026-10-18T02:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function dueItem(status = "DUE_SOON", nextDueAt = "2026-10-19T02:00:00.000Z") {
  return {
    schedule_id: "filter-main",
    device_id: "air.purifier.main",
    device_name: "主卧空气净化器",
    maintenance_type: "filter_replacement",
    maintenance_status: status,
    ...(nextDueAt ? { next_due_at: nextDueAt } : {}),
  };
}

function schedule(overrides = {}) {
  return {
    schedule_id: "filter-main",
    device_id: "air.purifier.main",
    device_name: "主卧空气净化器",
    maintenance_type: "filter_replacement",
    next_due_at: "2026-10-19T02:00:00.000Z",
    ...overrides,
  };
}

async function tempPaths(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lt-maintenance-reminders-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return {
    dir,
    inboxPath: path.join(dir, "state", "maintenance-reminders.json"),
    runnerStatePath: path.join(dir, "state", "maintenance-reminder-runner.json"),
    schedulePath: path.join(dir, "state", "maintenance-schedules.json"),
  };
}

test("维护提醒路径支持显式覆盖、OpenClaw 状态目录和默认目录", () => {
  assert.equal(resolveMaintenanceReminderInboxPath({
    DEVICE_MANAGER_MAINTENANCE_REMINDER_INBOX_PATH: "./my-reminders.json",
  }), path.resolve("./my-reminders.json"));
  assert.equal(resolveMaintenanceReminderInboxPath({ OPENCLAW_STATE_DIR: "./state" }),
    path.join(path.resolve("./state"), "device-manager", "maintenance-reminders.json"));
  assert.equal(resolveMaintenanceReminderInboxPath({}),
    path.join(os.homedir(), ".openclaw", "device-manager", "maintenance-reminders.json"));
  assert.equal(resolveMaintenanceReminderRunnerStatePath({ OPENCLAW_STATE_DIR: "./state" }),
    path.join(path.resolve("./state"), "device-manager", "maintenance-reminder-runner.json"));
  assert.equal(resolveMaintenanceSchedulePath({ OPENCLAW_STATE_DIR: "./state" }),
    path.join(path.resolve("./state"), "device-manager", "maintenance-schedules.json"));
});

test("提醒收件箱可持久化、跨实例去重，并在升级为逾期时重新打开已读提醒", async (t) => {
  const { inboxPath } = await tempPaths(t);
  const inbox = new MaintenanceReminderInbox({ filePath: inboxPath, clock: () => NOW });
  const first = await inbox.upsertDueReminders({
    plan_items: [dueItem()],
    schedules: [schedule()],
    observed_at: new Date(NOW).toISOString(),
  });
  assert.equal(first.created, 1);
  const listed = await inbox.list();
  assert.equal(listed.notifications.length, 1);
  const notificationId = listed.notifications[0].notification_id;
  assert.equal(listed.notifications[0].status, "pending");

  const duplicate = await new MaintenanceReminderInbox({ filePath: inboxPath, clock: () => NOW })
    .upsertDueReminders({ plan_items: [dueItem()], schedules: [schedule()] });
  assert.equal(duplicate.created, 0);
  assert.equal(duplicate.skipped_as_duplicate, 1);
  assert.equal((await inbox.acknowledge({ notification_id: notificationId, user_acknowledged: true })).status, "ACKNOWLEDGED");

  const escalated = await inbox.upsertDueReminders({
    plan_items: [dueItem("OVERDUE")],
    schedules: [schedule()],
  });
  assert.equal(escalated.updated, 1);
  const reopened = await inbox.list();
  assert.equal(reopened.notifications.length, 1);
  assert.equal(reopened.notifications[0].status, "pending");
  assert.equal(reopened.notifications[0].maintenance_status, "OVERDUE");
  assert.equal(reopened.notifications[0].notification_id, notificationId);
});

test("不同维护周期生成独立提醒；维护计划后续更新不会静默删除历史提醒快照", async (t) => {
  const { inboxPath } = await tempPaths(t);
  const inbox = new MaintenanceReminderInbox({ filePath: inboxPath, clock: () => NOW });
  await inbox.upsertDueReminders({ plan_items: [dueItem()], schedules: [schedule()] });
  await inbox.upsertDueReminders({
    plan_items: [dueItem("DUE_SOON", "2026-11-18T02:00:00.000Z")],
    schedules: [schedule({ last_completed_at: "2026-10-18T02:00:00.000Z", next_due_at: "2026-11-18T02:00:00.000Z" })],
  });
  const list = await inbox.list({ limit: 10 });
  assert.equal(list.notifications.length, 2);
  assert.notEqual(list.notifications[0].notification_id, list.notifications[1].notification_id);
});

test("归档必须显式确认，只归档截止时间前已完成的提醒并保留可查询历史", async (t) => {
  const { inboxPath } = await tempPaths(t);
  let now = NOW;
  const inbox = new MaintenanceReminderInbox({ filePath: inboxPath, clock: () => now });
  const ids = ["old-completed", "recent-completed", "pending", "acknowledged", "snoozed"];
  const schedules = ids.map((id) => schedule({
    schedule_id: id,
    device_id: `sensor.${id}`,
    device_name: id,
  }));
  const planItems = ids.map((id, index) => ({
    ...dueItem("DUE_SOON", new Date(NOW + (index + 1) * DAY_MS).toISOString()),
    schedule_id: id,
    device_id: `sensor.${id}`,
  }));
  await inbox.upsertDueReminders({ plan_items: planItems, schedules });
  const all = await inbox.list({ limit: 10 });
  const bySchedule = new Map(all.notifications.map((item) => [item.schedule_id, item.notification_id]));
  await inbox.completeForSchedule({ schedule_id: "old-completed", completed_at: new Date(NOW + 60_000).toISOString() });
  await inbox.completeForSchedule({ schedule_id: "recent-completed", completed_at: new Date(NOW + 120_000).toISOString() });
  await inbox.acknowledge({ notification_id: bySchedule.get("acknowledged"), user_acknowledged: true });
  await inbox.snooze({ notification_id: bySchedule.get("snoozed"), snooze_for_minutes: 10, user_requested: true });

  const cutoff = new Date(NOW + 60_000).toISOString();
  assert.equal((await inbox.archiveCompletedBefore({ completed_before: cutoff })).error.code, "USER_ARCHIVE_CONFIRMATION_REQUIRED");
  assert.equal((await inbox.archiveCompletedBefore({ completed_before: "not-a-date", user_confirmed: true })).error.code, "INVALID_ARCHIVE_CUTOFF");
  assert.equal((await inbox.archiveCompletedBefore({ completed_before: cutoff, user_confirmed: true })).archived_count, 1);

  const activeCompleted = await inbox.list({ include_completed: true, include_acknowledged: true, include_snoozed: true, limit: 10 });
  assert.equal(activeCompleted.total_count, 4);
  assert.equal(activeCompleted.notifications.some((item) => item.schedule_id === "old-completed"), false);
  assert.equal(activeCompleted.notifications.find((item) => item.schedule_id === "recent-completed")?.status, "completed");
  assert.equal(activeCompleted.notifications.find((item) => item.schedule_id === "pending")?.status, "pending");
  assert.equal(activeCompleted.notifications.find((item) => item.schedule_id === "acknowledged")?.status, "acknowledged");
  assert.equal(activeCompleted.notifications.find((item) => item.schedule_id === "snoozed")?.status, "snoozed");

  const archived = await inbox.list({ include_archived: true, limit: 10 });
  assert.equal(archived.notifications.find((item) => item.schedule_id === "old-completed")?.archived, true);
  assert.equal(archived.notifications.find((item) => item.schedule_id === "old-completed")?.completed_at, cutoff);
  assert.ok(archived.notifications.find((item) => item.schedule_id === "old-completed")?.archived_at);
  assert.equal((await inbox.upsertDueReminders({ plan_items: [planItems[0]], schedules: [schedules[0]] })).skipped_as_duplicate, 1);
  const persisted = JSON.parse(await fs.readFile(inboxPath, "utf8"));
  assert.equal(persisted.schema_version, "device-manager.maintenance-reminder-inbox/0.4");
  assert.equal(persisted.archived_notifications.length, 1);
  assert.equal(persisted.notifications.length, 4);
});

test("归档已完成提醒可以释放 500 条活动容量且不会删除历史", async (t) => {
  const { inboxPath } = await tempPaths(t);
  const inbox = new MaintenanceReminderInbox({ filePath: inboxPath, clock: () => NOW });
  const schedules = Array.from({ length: 500 }, (_, index) => schedule({
    schedule_id: `schedule-${index}`,
    device_id: `sensor.device-${index}`,
  }));
  const planItems = schedules.map((entry, index) => ({
    ...dueItem("DUE_SOON", new Date(NOW + (index + 1) * DAY_MS).toISOString()),
    schedule_id: entry.schedule_id,
    device_id: entry.device_id,
  }));
  const initial = await inbox.upsertDueReminders({ plan_items: planItems, schedules });
  assert.equal(initial.created, 500);
  const completed = await inbox.completeForSchedule({ schedule_id: "schedule-0", completed_at: new Date(NOW + 60_000).toISOString() });
  assert.equal(completed.resolved_count, 1);

  const extraSchedule = schedule({ schedule_id: "schedule-extra", device_id: "sensor.extra" });
  const extraItem = { ...dueItem("DUE_SOON", new Date(NOW + 501 * DAY_MS).toISOString()), schedule_id: extraSchedule.schedule_id, device_id: extraSchedule.device_id };
  assert.equal((await inbox.upsertDueReminders({ plan_items: [extraItem], schedules: [extraSchedule] })).error.code, "INBOX_CAPACITY_REACHED");
  const archived = await inbox.archiveCompletedBefore({ completed_before: new Date(NOW + 60_000).toISOString(), user_confirmed: true });
  assert.equal(archived.archived_count, 1);
  assert.equal(archived.active_count, 499);
  assert.equal((await inbox.upsertDueReminders({ plan_items: [extraItem], schedules: [extraSchedule] })).created, 1);
  assert.equal((await inbox.list({ include_archived: true, include_completed: true, limit: 50 })).total_count, 501);
});

test("提醒列表可分页遍历，按最新优先排序且相邻页不漏项、不重复", async (t) => {
  const { inboxPath } = await tempPaths(t);
  let now = NOW;
  const inbox = new MaintenanceReminderInbox({ filePath: inboxPath, clock: () => now });
  const dueDates = [1, 2, 3, 4, 5].map((days) => new Date(NOW + days * DAY_MS).toISOString());
  for (const dueDate of dueDates) {
    await inbox.upsertDueReminders({
      plan_items: [dueItem("DUE_SOON", dueDate)],
      schedules: [schedule()],
      observed_at: new Date(now).toISOString(),
    });
    now += 1000;
  }

  const firstPage = await inbox.list({ limit: 2 });
  const secondPage = await inbox.list({ limit: 2, offset: firstPage.next_offset });
  const thirdPage = await inbox.list({ limit: 2, offset: secondPage.next_offset });
  const allIds = [...firstPage.notifications, ...secondPage.notifications, ...thirdPage.notifications]
    .map((item) => item.notification_id);
  assert.equal(firstPage.total_count, 5);
  assert.deepEqual([firstPage.notifications.length, secondPage.notifications.length, thirdPage.notifications.length], [2, 2, 1]);
  assert.equal(firstPage.next_offset, 2);
  assert.equal(secondPage.next_offset, 4);
  assert.equal(thirdPage.next_offset, null);
  assert.ok(firstPage.next_cursor);
  assert.ok(secondPage.next_cursor);
  assert.equal(thirdPage.next_cursor, null);
  assert.equal(new Set(allIds).size, 5);
  assert.deepEqual(firstPage.notifications.map((item) => item.next_due_at), dueDates.slice().reverse().slice(0, 2));
  assert.equal((await inbox.list({ limit: 2, offset: 5 })).notifications.length, 0);
  assert.equal((await inbox.list({ offset: 501 })).error.code, "INVALID_LIST_OPTIONS");

  const cursorFirst = await inbox.list({ limit: 2 });
  const firstCursorIds = cursorFirst.notifications.map((item) => item.notification_id);
  const anchorId = cursorFirst.notifications.at(-1).notification_id;
  await inbox.acknowledge({ notification_id: anchorId, user_acknowledged: true });
  now += 1000;
  const newestDue = new Date(NOW + 6 * DAY_MS).toISOString();
  await inbox.upsertDueReminders({
    plan_items: [dueItem("DUE_SOON", newestDue)],
    schedules: [schedule()],
    observed_at: new Date(now).toISOString(),
  });
  const cursorSecond = await inbox.list({ limit: 2, cursor: cursorFirst.next_cursor });
  const secondCursorIds = cursorSecond.notifications.map((item) => item.notification_id);
  assert.equal(cursorSecond.total_count, 5);
  assert.equal(cursorSecond.notifications.length, 2);
  assert.equal(firstCursorIds.some((id) => secondCursorIds.includes(id)), false);
  assert.equal(cursorSecond.notifications.some((item) => item.next_due_at === newestDue), false);
  assert.ok(cursorSecond.next_cursor);
  const cursorThird = await inbox.list({ limit: 2, cursor: cursorSecond.next_cursor });
  assert.equal(cursorThird.notifications.length, 1);
  assert.equal(cursorThird.next_cursor, null);
  assert.equal(new Set([...firstCursorIds, ...secondCursorIds, ...cursorThird.notifications.map((item) => item.notification_id)]).size, 5);
  assert.equal((await inbox.list({ limit: 2, offset: 1, cursor: cursorFirst.next_cursor })).error.code, "INVALID_LIST_OPTIONS");
  assert.equal((await inbox.list({ cursor: "maintenance-missing" })).error.code, "INVALID_LIST_OPTIONS");
  assert.equal((await inbox.list({ cursor: "maintenance-000000000000000000000000" })).error.code, "INVALID_LIST_CURSOR");
});

test("分页游标锚点被归档后仍可继续读取更早的活动提醒", async (t) => {
  const { inboxPath } = await tempPaths(t);
  let now = NOW;
  const inbox = new MaintenanceReminderInbox({ filePath: inboxPath, clock: () => now });
  const schedules = ["cursor-old", "cursor-anchor", "cursor-new"].map((id) => schedule({ schedule_id: id, device_id: `sensor.${id}` }));
  const planItems = schedules.map((entry, index) => ({
    ...dueItem("DUE_SOON", new Date(NOW + (index + 1) * DAY_MS).toISOString()),
    schedule_id: entry.schedule_id,
    device_id: entry.device_id,
  }));
  for (let index = 0; index < planItems.length; index += 1) {
    await inbox.upsertDueReminders({ plan_items: [planItems[index]], schedules: [schedules[index]], observed_at: new Date(now).toISOString() });
    now += 1000;
  }
  const firstPage = await inbox.list({ limit: 2 });
  const anchor = firstPage.notifications.at(-1);
  assert.equal(anchor.schedule_id, "cursor-anchor");
  await inbox.completeForSchedule({ schedule_id: anchor.schedule_id, completed_at: new Date(NOW + 60_000).toISOString() });
  await inbox.archiveCompletedBefore({ completed_before: new Date(NOW + 60_000).toISOString(), user_confirmed: true });

  const continuation = await inbox.list({ limit: 2, cursor: firstPage.next_cursor });
  assert.equal(continuation.success, true);
  assert.deepEqual(continuation.notifications.map((item) => item.schedule_id), ["cursor-old"]);
  assert.equal(continuation.notifications[0].archived, false);
  assert.equal(continuation.next_cursor, null);
});

test("未确认已读时拒绝确认，明确已读也不记录维护完成", async (t) => {
  const { inboxPath } = await tempPaths(t);
  const inbox = new MaintenanceReminderInbox({ filePath: inboxPath, clock: () => NOW });
  await inbox.upsertDueReminders({ plan_items: [dueItem()], schedules: [schedule()] });
  const [{ notification_id: notificationId }] = (await inbox.list()).notifications;
  assert.equal((await inbox.acknowledge({ notification_id: notificationId })).error.code, "USER_ACKNOWLEDGEMENT_REQUIRED");
  const acknowledged = await inbox.acknowledge({ notification_id: notificationId, user_acknowledged: true });
  assert.equal(acknowledged.status, "ACKNOWLEDGED");
  assert.equal(acknowledged.maintenance_completed, false);
  assert.equal((await inbox.list()).notifications.length, 0);
});

test("用户明确选择时长后可暂缓提醒；到期重新进入待处理且不等于已读或维护完成", async (t) => {
  const { inboxPath } = await tempPaths(t);
  let now = NOW;
  const inbox = new MaintenanceReminderInbox({ filePath: inboxPath, clock: () => now });
  await inbox.upsertDueReminders({ plan_items: [dueItem()], schedules: [schedule()] });
  const [{ notification_id: notificationId }] = (await inbox.list()).notifications;

  assert.equal((await inbox.snooze({ notification_id: notificationId, snooze_for_minutes: 10 })).error.code, "USER_SNOOZE_REQUEST_REQUIRED");
  assert.equal((await inbox.snooze({ notification_id: notificationId, snooze_for_minutes: 4, user_requested: true })).error.code, "INVALID_SNOOZE_DURATION");
  const snoozed = await inbox.snooze({ notification_id: notificationId, snooze_for_minutes: 10, user_requested: true });
  assert.equal(snoozed.status, "SNOOZED");
  assert.equal(snoozed.snoozed_until, new Date(NOW + 10 * 60_000).toISOString());
  assert.equal(snoozed.maintenance_completed, false);
  assert.equal(snoozed.notification_delivered, false);
  assert.equal((await inbox.list()).notifications.length, 0);
  assert.equal((await inbox.list({ include_snoozed: true })).notifications[0].status, "snoozed");

  now += 9 * 60_000;
  assert.equal((await inbox.list()).notifications.length, 0);
  now += 60_000;
  const reopened = await inbox.list();
  assert.equal(reopened.notifications.length, 1);
  assert.equal(reopened.notifications[0].status, "pending");
  assert.equal(reopened.notifications[0].snoozed_until, null);
  assert.equal(reopened.notifications[0].acknowledged_at, null);
  const stored = JSON.parse(await fs.readFile(inboxPath, "utf8"));
  assert.equal(stored.schema_version, "device-manager.maintenance-reminder-inbox/0.4");
});

test("提醒暂缓期间升级到逾期会立即重新打开待处理提醒", async (t) => {
  const { inboxPath } = await tempPaths(t);
  const inbox = new MaintenanceReminderInbox({ filePath: inboxPath, clock: () => NOW });
  await inbox.upsertDueReminders({ plan_items: [dueItem()], schedules: [schedule()] });
  const [{ notification_id: notificationId }] = (await inbox.list()).notifications;
  await inbox.snooze({ notification_id: notificationId, snooze_for_minutes: 60, user_requested: true });

  const escalated = await inbox.upsertDueReminders({
    plan_items: [dueItem("OVERDUE")],
    schedules: [schedule()],
  });
  assert.equal(escalated.updated, 1);
  const pending = await inbox.list();
  assert.equal(pending.notifications.length, 1);
  assert.equal(pending.notifications[0].notification_id, notificationId);
  assert.equal(pending.notifications[0].maintenance_status, "OVERDUE");
  assert.equal(pending.notifications[0].status, "pending");
});

test("维护完成会关闭同计划已创建的待处理、已读和暂缓提醒并保留历史", async (t) => {
  const { inboxPath } = await tempPaths(t);
  let now = NOW;
  const inbox = new MaintenanceReminderInbox({ filePath: inboxPath, clock: () => now });
  const cycleItems = [
    dueItem("DUE_SOON", "2026-10-19T02:00:00.000Z"),
    dueItem("DUE_SOON", "2026-11-19T02:00:00.000Z"),
    dueItem("DUE_SOON", "2026-12-19T02:00:00.000Z"),
  ];
  await inbox.upsertDueReminders({ plan_items: cycleItems, schedules: [schedule()] });
  const initial = await inbox.list({ limit: 10 });
  assert.equal(initial.notifications.length, 3);
  await inbox.acknowledge({ notification_id: initial.notifications[0].notification_id, user_acknowledged: true });
  await inbox.snooze({ notification_id: initial.notifications[1].notification_id, snooze_for_minutes: 10, user_requested: true });

  const completedAt = new Date(now + 60_000).toISOString();
  const result = await inbox.completeForSchedule({ schedule_id: "filter-main", completed_at: completedAt });
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.resolved_count, 3);
  assert.equal((await inbox.list()).notifications.length, 0);
  const history = await inbox.list({ include_completed: true, limit: 10 });
  assert.equal(history.notifications.length, 3);
  assert.ok(history.notifications.every((item) => item.status === "completed" && item.completed_at === completedAt));
  assert.equal(history.notifications.filter((item) => item.acknowledged_at !== null).length, 1);
  assert.ok(history.notifications.every((item) => item.snoozed_until === null));
  assert.equal((await inbox.snooze({
    notification_id: history.notifications[0].notification_id,
    snooze_for_minutes: 5,
    user_requested: true,
  })).error.code, "REMINDER_ALREADY_COMPLETED");
  assert.equal((await inbox.acknowledge({
    notification_id: history.notifications[0].notification_id,
    user_acknowledged: true,
  })).error.code, "REMINDER_ALREADY_COMPLETED");
  assert.equal((await inbox.upsertDueReminders({ plan_items: cycleItems, schedules: [schedule()] })).skipped_as_duplicate, 3);
  assert.equal((await inbox.list()).notifications.length, 0);
});

test("补录完成时间不会关闭在该完成时间之后才创建的提醒", async (t) => {
  const { inboxPath } = await tempPaths(t);
  let now = NOW;
  const inbox = new MaintenanceReminderInbox({ filePath: inboxPath, clock: () => now });
  await inbox.upsertDueReminders({ plan_items: [dueItem()], schedules: [schedule()] });
  now += 10 * 60_000;
  await inbox.upsertDueReminders({
    plan_items: [dueItem("DUE_SOON", "2026-10-20T02:00:00.000Z")],
    schedules: [schedule()],
  });

  const result = await inbox.completeForSchedule({
    schedule_id: "filter-main",
    completed_at: new Date(NOW + 5 * 60_000).toISOString(),
  });
  assert.equal(result.resolved_count, 1);
  const pending = await inbox.list({ limit: 10 });
  assert.equal(pending.notifications.length, 1);
  assert.equal(pending.notifications[0].status, "pending");
});

test("记录维护完成后，下一周期按新到期日生成独立提醒并保留旧周期历史", async (t) => {
  const { inboxPath, schedulePath } = await tempPaths(t);
  let now = NOW;
  const clock = () => now;
  const inbox = new MaintenanceReminderInbox({ filePath: inboxPath, clock });
  const scheduleStore = new MaintenanceScheduleStore({ filePath: schedulePath, clock });
  const reminders = createMaintenanceReminderTools({
    scheduleStore,
    inbox,
    clock,
    scheduleAuthorized: false,
  });
  const energy = createEnergyOperationsTools({ maintenanceStore: scheduleStore, reminderInbox: inbox, clock });
  const intervalDays = 30;
  await scheduleStore.upsertSchedule(schedule({
    interval_days: intervalDays,
    next_due_at: new Date(NOW + DAY_MS).toISOString(),
    usage_since_service: 145,
    usage_limit: 500,
    usage_unit: "hours",
  }));

  const initialCheck = await reminders.check_maintenance_reminders({ now: new Date(now).toISOString() });
  const oldReminder = initialCheck.pending_notifications[0];
  assert.equal(initialCheck.reminders_created, 1);
  assert.ok(oldReminder);

  now += 2 * DAY_MS;
  const completion = await energy.record_device_maintenance_completed({
    schedule_id: "filter-main",
    user_confirmed: true,
  });
  assert.equal(completion.success, true);
  assert.equal(completion.reminder_resolution.resolved_count, 1);
  assert.equal(completion.schedule.usage_since_service, 0);
  const expectedNextDue = new Date(now + intervalDays * DAY_MS).toISOString();
  assert.equal(completion.schedule.next_due_at, expectedNextDue);
  assert.equal((await reminders.list_maintenance_reminders()).notifications.length, 0);

  now += (intervalDays - 7) * DAY_MS;
  const nextCycleCheck = await reminders.check_maintenance_reminders({ now: new Date(now).toISOString() });
  assert.equal(nextCycleCheck.reminders_created, 1);
  const pending = await reminders.list_maintenance_reminders();
  assert.equal(pending.notifications.length, 1);
  assert.equal(pending.notifications[0].maintenance_status, "DUE_SOON");
  assert.equal(pending.notifications[0].next_due_at, expectedNextDue);
  assert.notEqual(pending.notifications[0].notification_id, oldReminder.notification_id);

  const history = await reminders.list_maintenance_reminders({ include_completed: true, limit: 10 });
  assert.equal(history.notifications.filter((item) => item.status === "completed").length, 1);
  assert.equal(history.notifications.find((item) => item.status === "completed").notification_id, oldReminder.notification_id);
  assert.equal(history.notifications.find((item) => item.status === "pending").notification_id, pending.notifications[0].notification_id);
});

test("旧 0.1/0.2/0.3 收件箱可安全读取，写入时升级为 0.4；未知版本仍失败关闭", async (t) => {
  const { inboxPath } = await tempPaths(t);
  const inbox = new MaintenanceReminderInbox({ filePath: inboxPath, clock: () => NOW });
  await inbox.upsertDueReminders({ plan_items: [dueItem()], schedules: [schedule()] });
  const stored = JSON.parse(await fs.readFile(inboxPath, "utf8"));
  for (const version of ["device-manager.maintenance-reminder-inbox/0.1", "device-manager.maintenance-reminder-inbox/0.2", "device-manager.maintenance-reminder-inbox/0.3"]) {
    const legacy = structuredClone(stored);
    legacy.schema_version = version;
    delete legacy.notifications[0].completed_at;
    if (version.endsWith("/0.1")) delete legacy.notifications[0].snoozed_until;
    await fs.writeFile(inboxPath, JSON.stringify(legacy), "utf8");
    const listed = await inbox.list();
    assert.equal(listed.notifications.length, 1);
    const [{ notification_id: notificationId }] = listed.notifications;
    await inbox.snooze({ notification_id: notificationId, snooze_for_minutes: 5, user_requested: true });
    const upgraded = JSON.parse(await fs.readFile(inboxPath, "utf8"));
    assert.equal(upgraded.schema_version, "device-manager.maintenance-reminder-inbox/0.4");
    assert.deepEqual(upgraded.archived_notifications, []);
    assert.equal(upgraded.notifications[0].status, "snoozed");
  }
});

test("损坏或未知版本的收件箱 fail-closed 且保留原文件", async (t) => {
  const { inboxPath } = await tempPaths(t);
  await fs.mkdir(path.dirname(inboxPath), { recursive: true });
  const inbox = new MaintenanceReminderInbox({ filePath: inboxPath, clock: () => NOW });
  for (const contents of ["{broken", JSON.stringify({ schema_version: "device-manager.maintenance-reminder-inbox/0.9", notifications: [] })]) {
    await fs.writeFile(inboxPath, contents, "utf8");
    const result = await inbox.upsertDueReminders({ plan_items: [dueItem()], schedules: [schedule()] });
    assert.equal(result.success, false);
    assert.match(result.error.message, /JSON|版本不受支持/);
    assert.equal(await fs.readFile(inboxPath, "utf8"), contents);
  }
});

test("周期提醒默认关闭；显式本机开关和 start 调用后才启动，stop 可关闭并清除恢复意图", async (t) => {
  const { inboxPath, runnerStatePath, schedulePath } = await tempPaths(t);
  const store = new MaintenanceScheduleStore({ filePath: schedulePath, clock: () => NOW });
  await store.upsertSchedule(schedule());
  const inbox = new MaintenanceReminderInbox({ filePath: inboxPath, clock: () => NOW });
  const runnerStateStore = new MaintenanceReminderRunnerStateStore({ filePath: runnerStatePath, clock: () => NOW });
  let timerCallback;
  let cleared = false;
  const disabled = createMaintenanceReminderTools({
    scheduleStore: store,
    inbox,
    runnerStateStore,
    clock: () => NOW,
    setIntervalFn(callback) { timerCallback = callback; return "disabled-timer"; },
    clearIntervalFn() { cleared = true; },
  });
  const blocked = await disabled.start_maintenance_reminders();
  assert.equal(blocked.error.code, "LOCAL_SCHEDULE_DISABLED");
  assert.equal(timerCallback, undefined);

  const enabled = createMaintenanceReminderTools({
    scheduleStore: store,
    inbox,
    runnerStateStore,
    scheduleAuthorized: true,
    pollIntervalMs: 60_000,
    clock: () => NOW,
    setIntervalFn(callback, interval) { timerCallback = callback; assert.equal(interval, 60_000); return "enabled-timer"; },
    clearIntervalFn(timer) { assert.equal(timer, "enabled-timer"); cleared = true; },
  });
  const started = await enabled.start_maintenance_reminders({ resume_after_gateway_restart: true });
  assert.equal(started.status, "RUNNING");
  assert.equal(started.auto_resume_after_gateway_restart, true);
  assert.equal(started.initial_poll.reminders_created, 1);
  assert.equal((await enabled.get_maintenance_reminder_status()).runner.running, true);
  assert.equal(typeof timerCallback, "function");
  assert.equal((await enabled.stop_maintenance_reminders()).status, "STOPPED");
  assert.equal((await runnerStateStore.get()).auto_resume, false);
  assert.equal(cleared, true);
});

test("持久恢复只在用户明确选择、管理员开关仍开启且 Gateway 启动服务运行时发生", async (t) => {
  const { inboxPath, runnerStatePath, schedulePath } = await tempPaths(t);
  const store = new MaintenanceScheduleStore({ filePath: schedulePath, clock: () => NOW });
  await store.upsertSchedule(schedule());
  const inbox = new MaintenanceReminderInbox({ filePath: inboxPath, clock: () => NOW });
  const runnerStateStore = new MaintenanceReminderRunnerStateStore({ filePath: runnerStatePath, clock: () => NOW });
  let firstTimer;
  const firstProcess = createMaintenanceReminderTools({
    scheduleStore: store,
    inbox,
    runnerStateStore,
    scheduleAuthorized: true,
    clock: () => NOW,
    setIntervalFn(callback) { firstTimer = callback; return "first-process"; },
    clearIntervalFn() {},
  });
  await firstProcess.start_maintenance_reminders({ resume_after_gateway_restart: true });
  assert.equal(typeof firstTimer, "function");

  let restartedTimer;
  const restartedProcess = createMaintenanceReminderTools({
    scheduleStore: store,
    inbox: new MaintenanceReminderInbox({ filePath: inboxPath, clock: () => NOW }),
    runnerStateStore: new MaintenanceReminderRunnerStateStore({ filePath: runnerStatePath, clock: () => NOW }),
    scheduleAuthorized: true,
    clock: () => NOW,
    setIntervalFn(callback) { restartedTimer = callback; return "restarted-process"; },
    clearIntervalFn() {},
  });
  const resumed = await restartedProcess.resume_maintenance_reminders();
  assert.equal(resumed.status, "RUNNING");
  assert.equal(resumed.resumed_after_gateway_start, true);
  assert.equal(typeof restartedTimer, "function");
  assert.equal(resumed.initial_poll.duplicate_checks_skipped, 1);

  const disabledProcess = createMaintenanceReminderTools({
    scheduleStore: store,
    inbox,
    runnerStateStore: new MaintenanceReminderRunnerStateStore({ filePath: runnerStatePath, clock: () => NOW }),
    scheduleAuthorized: false,
    clock: () => NOW,
    setIntervalFn() { assert.fail("管理员开关关闭时不得恢复定时器"); },
    clearIntervalFn() {},
  });
  assert.equal((await disabledProcess.resume_maintenance_reminders()).error.code, "LOCAL_SCHEDULE_DISABLED");
});

test("恢复状态损坏时 fail-closed 且不覆盖原文件", async (t) => {
  const { runnerStatePath, schedulePath, inboxPath } = await tempPaths(t);
  await fs.mkdir(path.dirname(runnerStatePath), { recursive: true });
  const original = "{not-json";
  await fs.writeFile(runnerStatePath, original, "utf8");
  const tools = createMaintenanceReminderTools({
    scheduleStore: new MaintenanceScheduleStore({ filePath: schedulePath, clock: () => NOW }),
    inbox: new MaintenanceReminderInbox({ filePath: inboxPath, clock: () => NOW }),
    runnerStateStore: new MaintenanceReminderRunnerStateStore({ filePath: runnerStatePath, clock: () => NOW }),
    scheduleAuthorized: true,
    clock: () => NOW,
    setIntervalFn() { assert.fail("恢复状态损坏时不得启动定时器"); },
    clearIntervalFn() {},
  });
  assert.equal((await tools.resume_maintenance_reminders()).error.code, "RUNNER_STATE_READ_FAILED");
  assert.equal((await tools.start_maintenance_reminders({ resume_after_gateway_restart: true })).error.code, "RUNNER_STATE_READ_FAILED");
  assert.equal(await fs.readFile(runnerStatePath, "utf8"), original);
});

test("单次检查基于已保存计划生成提醒，并且不会执行设备动作", async (t) => {
  const { inboxPath, runnerStatePath, schedulePath } = await tempPaths(t);
  const store = new MaintenanceScheduleStore({ filePath: schedulePath, clock: () => NOW });
  await store.upsertSchedule(schedule());
  const tools = createMaintenanceReminderTools({
    scheduleStore: store,
    inbox: new MaintenanceReminderInbox({ filePath: inboxPath, clock: () => NOW }),
    runnerStateStore: new MaintenanceReminderRunnerStateStore({ filePath: runnerStatePath, clock: () => NOW }),
    clock: () => NOW,
  });
  const checked = await tools.check_maintenance_reminders();
  assert.equal(checked.status, "REMINDERS_QUEUED");
  assert.equal(checked.reminders_created, 1);
  assert.equal(checked.external_push_sent, false);
  assert.equal(checked.maintenance_performed, false);
  assert.equal(checked.device_action_performed, false);
  assert.equal((await tools.list_maintenance_reminders()).notifications.length, 1);
});

test("OpenClaw 插件注册维护提醒工具，但加载插件不会自动启动或创建收件箱", async (t) => {
  const { dir } = await tempPaths(t);
  const previous = {
    state: process.env.OPENCLAW_STATE_DIR,
    schedule: process.env.DEVICE_MANAGER_MAINTENANCE_SCHEDULE_PATH,
    inbox: process.env.DEVICE_MANAGER_MAINTENANCE_REMINDER_INBOX_PATH,
    enabled: process.env.DEVICE_MANAGER_MAINTENANCE_REMINDERS_ENABLED,
  };
  process.env.OPENCLAW_STATE_DIR = path.join(dir, "isolated-openclaw-state");
  process.env.DEVICE_MANAGER_MAINTENANCE_SCHEDULE_PATH = path.join(dir, "maintenance.json");
  process.env.DEVICE_MANAGER_MAINTENANCE_REMINDER_INBOX_PATH = path.join(dir, "reminders.json");
  delete process.env.DEVICE_MANAGER_MAINTENANCE_REMINDERS_ENABLED;
  t.after(async () => {
    if (previous.state === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previous.state;
    if (previous.schedule === undefined) delete process.env.DEVICE_MANAGER_MAINTENANCE_SCHEDULE_PATH;
    else process.env.DEVICE_MANAGER_MAINTENANCE_SCHEDULE_PATH = previous.schedule;
    if (previous.inbox === undefined) delete process.env.DEVICE_MANAGER_MAINTENANCE_REMINDER_INBOX_PATH;
    else process.env.DEVICE_MANAGER_MAINTENANCE_REMINDER_INBOX_PATH = previous.inbox;
    if (previous.enabled === undefined) delete process.env.DEVICE_MANAGER_MAINTENANCE_REMINDERS_ENABLED;
    else process.env.DEVICE_MANAGER_MAINTENANCE_REMINDERS_ENABLED = previous.enabled;
    await fs.rm(dir, { recursive: true, force: true });
  });

  const { default: plugin } = await import(`../src/openclaw-plugin.js?maintenance-reminders=${Date.now()}-${Math.random()}`);
  const registered = new Map();
  const services = new Map();
  plugin.register({
    pluginConfig: {},
    registerTool(tool) { registered.set(tool.name, tool); },
    registerService(service) { services.set(service.id, service); },
  });
  assert.ok(services.has("device-manager-maintenance-reminders"));
  const serviceContext = { logger: { info() {}, warn() {} } };
  await services.get("device-manager-maintenance-reminders").start(serviceContext);
  for (const name of [
    "check_maintenance_reminders",
    "start_maintenance_reminders",
    "stop_maintenance_reminders",
    "get_maintenance_reminder_status",
    "list_maintenance_reminders",
    "archive_completed_maintenance_reminders",
    "acknowledge_maintenance_reminder",
    "snooze_maintenance_reminder",
  ]) assert.ok(registered.has(name), `缺少 OpenClaw 工具 ${name}`);

  const listSchema = MAINTENANCE_REMINDER_TOOL_DEFINITIONS
    .find((tool) => tool.name === "list_maintenance_reminders")?.inputSchema;
  assert.equal(listSchema?.properties?.include_snoozed?.type, "boolean");
  assert.equal(listSchema?.properties?.include_completed?.type, "boolean");
  assert.equal(listSchema?.properties?.include_archived?.type, "boolean");
  assert.deepEqual([listSchema?.properties?.offset?.minimum, listSchema?.properties?.offset?.maximum], [0, 500]);
  assert.equal(listSchema?.properties?.cursor?.type, "string");

  const status = await registered.get("get_maintenance_reminder_status").execute("status", {}, undefined, undefined);
  const parsed = JSON.parse(status.content.find((block) => block.type === "text").text);
  assert.equal(parsed.schedule_authorized, false);
  assert.equal(parsed.runner.running, false);
  assert.equal(parsed.auto_resume_after_gateway_restart, false);
  assert.equal(JSON.stringify(parsed).includes(dir), false);
  assert.equal(await fs.stat(path.join(dir, "reminders.json")).then(() => true).catch(() => false), false);
});

test("OpenClaw 后台服务只恢复已授权的周期检查，Gateway 停止钩子保留用户授权", async (t) => {
  const { dir } = await tempPaths(t);
  const envNames = [
    "OPENCLAW_STATE_DIR",
    "DEVICE_MANAGER_MAINTENANCE_SCHEDULE_PATH",
    "DEVICE_MANAGER_MAINTENANCE_REMINDER_INBOX_PATH",
    "DEVICE_MANAGER_MAINTENANCE_REMINDER_RUNNER_STATE_PATH",
    "DEVICE_MANAGER_MAINTENANCE_REMINDERS_ENABLED",
  ];
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  const stateDir = path.join(dir, "gateway-state");
  const runnerStatePath = path.join(stateDir, "device-manager", "maintenance-reminder-runner.json");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.DEVICE_MANAGER_MAINTENANCE_SCHEDULE_PATH = path.join(stateDir, "device-manager", "maintenance-schedules.json");
  process.env.DEVICE_MANAGER_MAINTENANCE_REMINDER_INBOX_PATH = path.join(stateDir, "device-manager", "maintenance-reminders.json");
  process.env.DEVICE_MANAGER_MAINTENANCE_REMINDER_RUNNER_STATE_PATH = runnerStatePath;
  process.env.DEVICE_MANAGER_MAINTENANCE_REMINDERS_ENABLED = "true";
  const runnerStateStore = new MaintenanceReminderRunnerStateStore({ filePath: runnerStatePath, clock: () => NOW });
  await runnerStateStore.setAutoResume(true);
  const serviceContext = { logger: { info() {}, warn() {} } };
  let service;
  t.after(async () => {
    if (service) await service.stop(serviceContext);
    for (const name of envNames) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  const { default: plugin } = await import(`../src/openclaw-plugin.js?maintenance-reminder-service=${Date.now()}-${Math.random()}`);
  const registered = new Map();
  plugin.register({
    pluginConfig: {},
    registerTool(tool) { registered.set(tool.name, tool); },
    registerService(registeredService) { service = registeredService; },
  });
  assert.equal(service?.id, "device-manager-maintenance-reminders");
  await service.start(serviceContext);
  const statusResult = await registered.get("get_maintenance_reminder_status").execute("status", {}, undefined, undefined);
  const status = JSON.parse(statusResult.content.find((block) => block.type === "text").text);
  assert.equal(status.runner.running, true);
  assert.equal(status.auto_resume_after_gateway_restart, true);

  await service.stop(serviceContext);
  assert.equal((await runnerStateStore.get()).auto_resume, true);
});
