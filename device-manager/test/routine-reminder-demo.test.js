import assert from "node:assert/strict";
import test from "node:test";

import { runRoutineReminderDemo } from "../src/routine-reminder-demo.js";

test("隔离作息提醒演示跑通到期、收件箱和已读确认而不启用外部副作用", async () => {
  const result = await runRoutineReminderDemo();
  assert.equal(result.due_check_status, "EVENTS_DELIVERED");
  assert.equal(result.notification_count, 1);
  assert.equal(result.acknowledgement_status, "ACKNOWLEDGED");
  assert.equal(result.final_notification_status, "acknowledged");
  assert.equal(result.runner_auto_started, false);
  assert.equal(result.real_home_assistant_connected, false);
  assert.equal(result.external_push_sent, false);
  assert.equal(result.device_action_performed, false);
  assert.equal(result.llm_used, false);
  assert.match(result.reminder, /22:30/);
});

