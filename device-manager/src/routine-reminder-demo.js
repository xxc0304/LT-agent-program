import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PreferenceMemoryStore } from "../../agent-memory/src/memory-store.js";
import { RoutineNotificationInbox } from "./routine-notification-inbox.js";
import { createHouseholdRoutineNotificationTools } from "./routine-notification-tools.js";

/** Run an isolated routine reminder example without reading household data. */
export async function runRoutineReminderDemo() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-routine-reminder-demo-"));
  const now = Date.parse("2026-10-19T14:30:30.000Z"); // Monday, 22:30 in Asia/Shanghai.
  const clock = () => now;
  const store = new PreferenceMemoryStore({ filePath: path.join(directory, "memory.json"), clock });
  const inbox = new RoutineNotificationInbox({ filePath: path.join(directory, "inbox.json"), clock });

  try {
    const preference = await store.saveExplicitPreference({
      memory_type: "sleep_time",
      value: "22:30",
      time_zone: "Asia/Shanghai",
      day_type: "weekday",
      user_explicit_request: true,
    });
    const consent = await store.setRoutineReminderConsent({
      enabled: true,
      user_explicit_confirmation: true,
    });
    if (!preference.success || !consent.success) throw new Error("无法创建隔离作息示例数据");

    const tools = createHouseholdRoutineNotificationTools({
      store,
      inbox,
      timeZone: "Asia/Shanghai",
      scheduleAuthorized: true,
      clock,
    });
    const beforeStart = await tools.get_household_routine_reminder_status();
    const check = await tools.check_household_routine_reminders();
    const pending = await tools.list_household_routine_reminders({ limit: 10 });
    const notification = pending.notifications[0];
    if (!check.success || check.status !== "EVENTS_DELIVERED" || !notification) {
      throw new Error("示例没有成功把到期事件放入收件箱");
    }
    const acknowledgement = await tools.acknowledge_household_routine_reminder({
      notification_id: notification.notification_id,
      user_acknowledged: true,
    });
    const afterAcknowledgement = await tools.list_household_routine_reminders({
      include_acknowledged: true,
      limit: 10,
    });

    return {
      demo: "临时已确认作息偏好 → 到期检查 → 本地 OpenClaw 收件箱 → 用户确认已读",
      simulated_local_time: "2026-10-19 22:30:30 Asia/Shanghai",
      reminder: notification.message,
      due_check_status: check.status,
      notification_count: pending.notifications.length,
      acknowledgement_status: acknowledgement.status,
      final_notification_status: afterAcknowledgement.notifications[0]?.status ?? null,
      runner_auto_started: beforeStart.runner.running,
      real_home_assistant_connected: false,
      external_push_sent: false,
      device_action_performed: false,
      llm_used: false,
      storage: "临时目录；演示结束后删除，不读写正式家庭记忆或正式提醒收件箱",
    };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runRoutineReminderDemo()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

