import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PreferenceMemoryStore } from "../../agent-memory/src/memory-store.js";
import { RoutineNotificationInbox } from "../src/routine-notification-inbox.js";
import { createHouseholdRoutineNotificationTools } from "../src/routine-notification-tools.js";

async function setup(t, { now = Date.parse("2026-10-19T14:30:30.000Z"), ...options } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-routine-notification-tools-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const clock = () => now;
  const memoryPath = path.join(directory, "memory.json");
  const inboxPath = path.join(directory, "inbox.json");
  const store = new PreferenceMemoryStore({ filePath: memoryPath, clock });
  const inbox = new RoutineNotificationInbox({ filePath: inboxPath, clock });
  return {
    directory,
    clock,
    store,
    inbox,
    tools: (overrides = {}) => createHouseholdRoutineNotificationTools({
      store,
      inbox,
      timeZone: "Asia/Shanghai",
      scheduleAuthorized: true,
      clock,
      ...options,
      ...overrides,
    }),
  };
}

test("缺少时区、主机功能开关或用户授权时不检查/不启动，也不创建 timer", async (t) => {
  const { store, inbox } = await setup(t);
  let timerCalls = 0;
  const noTimeZone = createHouseholdRoutineNotificationTools({
    store,
    inbox,
    timeZone: "",
    scheduleAuthorized: true,
    setIntervalFn: () => { timerCalls += 1; return 1; },
  });
  assert.equal((await noTimeZone.check_household_routine_reminders()).error.code, "HOUSEHOLD_TIME_ZONE_REQUIRED");

  const badTimeZone = createHouseholdRoutineNotificationTools({
    store,
    inbox,
    timeZone: "Invalid/Zone",
    scheduleAuthorized: true,
  });
  assert.equal((await badTimeZone.check_household_routine_reminders()).error.code, "INVALID_HOUSEHOLD_TIME_ZONE");
  assert.equal((await badTimeZone.get_household_routine_reminder_status()).time_zone_configured, false);

  const noHostAuthorization = createHouseholdRoutineNotificationTools({
    store,
    inbox,
    timeZone: "Asia/Shanghai",
    scheduleAuthorized: false,
    setIntervalFn: () => { timerCalls += 1; return 1; },
  });
  assert.equal((await noHostAuthorization.start_household_routine_reminders()).status, "SCHEDULE_AUTHORIZATION_REQUIRED");
  assert.equal(timerCalls, 0);

  const noUserConsent = createHouseholdRoutineNotificationTools({
    store,
    inbox,
    timeZone: "Asia/Shanghai",
    scheduleAuthorized: true,
    setIntervalFn: () => { timerCalls += 1; return 1; },
  });
  assert.equal((await noUserConsent.start_household_routine_reminders()).status, "SCHEDULE_AUTHORIZATION_REQUIRED");
  assert.equal(timerCalls, 0);
});

test("确认偏好和授权 → 到期评估 → 收件箱持久化 → OpenClaw 风格工具列出、确认", async (t) => {
  const { store, inbox, tools } = await setup(t);
  await store.saveExplicitPreference({
    memory_type: "sleep_time",
    value: "22:30",
    time_zone: "Asia/Shanghai",
    day_type: "weekday",
    user_explicit_request: true,
  });
  await store.setRoutineReminderConsent({ enabled: true, user_explicit_confirmation: true });

  let intervalCallback;
  let cleared = false;
  const notificationTools = tools({
    pollIntervalMs: 10_000,
    setIntervalFn: (callback, interval) => {
      intervalCallback = callback;
      assert.equal(interval, 10_000);
      return "routine-timer";
    },
    clearIntervalFn: (timer) => { assert.equal(timer, "routine-timer"); cleared = true; },
  });

  assert.equal((await notificationTools.get_household_routine_reminder_status()).runner.running, false,
    "创建工具或 OpenClaw 插件时不得自动启动定时器");
  const checked = await notificationTools.check_household_routine_reminders();
  assert.equal(checked.status, "EVENTS_DELIVERED");
  assert.equal(checked.pending_notifications.length, 1);
  assert.match(checked.pending_notifications[0].message, /22:30/);
  assert.equal(checked.device_action_performed, false);
  assert.equal(checked.external_push_sent, false);

  const listed = await notificationTools.list_household_routine_reminders({});
  assert.equal(listed.notifications.length, 1);
  const id = listed.notifications[0].notification_id;
  const denied = await notificationTools.acknowledge_household_routine_reminder({
    notification_id: id,
    user_acknowledged: false,
  });
  assert.equal(denied.error.code, "USER_ACKNOWLEDGEMENT_REQUIRED");

  const started = await notificationTools.start_household_routine_reminders();
  assert.equal(started.status, "RUNNING");
  assert.equal(typeof intervalCallback, "function");
  assert.equal((await notificationTools.get_household_routine_reminder_status()).runner.running, true);
  assert.equal(notificationTools.stop_household_routine_reminders().status, "STOPPED");
  assert.equal(cleared, true);

  const acknowledged = await notificationTools.acknowledge_household_routine_reminder({
    notification_id: id,
    user_acknowledged: true,
  });
  assert.equal(acknowledged.status, "ACKNOWLEDGED");

  const reloaded = tools();
  assert.deepEqual((await reloaded.list_household_routine_reminders({})).notifications, []);
  const history = await reloaded.list_household_routine_reminders({ include_acknowledged: true });
  assert.equal(history.notifications.length, 1);
  assert.equal(history.notifications[0].status, "acknowledged");
});

test("撤回提醒授权会在下一次轮询停止周期检查", async (t) => {
  const { store, tools } = await setup(t);
  await store.setRoutineReminderConsent({ enabled: true, user_explicit_confirmation: true });
  let cleared = false;
  const notificationTools = tools({
    setIntervalFn: () => "routine-timer",
    clearIntervalFn: (timer) => { assert.equal(timer, "routine-timer"); cleared = true; },
  });
  assert.equal((await notificationTools.start_household_routine_reminders()).status, "RUNNING");
  await store.setRoutineReminderConsent({ enabled: false, user_explicit_confirmation: true });
  const check = await notificationTools.check_household_routine_reminders();
  assert.equal(check.status, "SCHEDULE_AUTHORIZATION_REQUIRED");
  assert.equal(check.reason, "USER_CONSENT_DISABLED");
  assert.equal(cleared, true);
});

