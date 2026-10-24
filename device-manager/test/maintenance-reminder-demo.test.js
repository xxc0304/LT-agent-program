import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const deviceManagerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const demoPath = path.join(deviceManagerDir, "src", "maintenance-reminder-demo.js");

test("可运行本机隔离演示，覆盖提醒、暂缓、逾期、维护完成、下一周期和显式归档闭环", () => {
  const result = spawnSync(process.execPath, [demoPath], {
    cwd: deviceManagerDir,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.demo, "maintenance-reminder-inbox");
  assert.equal(report.phases.initial.status, "DUE_SOON");
  assert.equal(report.phases.restarted.process_restarted, true);
  assert.equal(report.phases.restarted.reminders_created, 0);
  assert.equal(report.phases.acknowledged.maintenance_completed, false);
  assert.equal(report.phases.acknowledged.acknowledgment_source, "synthetic_demo_fixture");
  assert.equal(report.phases.acknowledged.user_interaction_performed, false);
  assert.equal(report.phases.overdue.status, "OVERDUE");
  assert.equal(report.phases.overdue.reopened_after_escalation, true);
  assert.equal(report.phases.initial.notification_id, report.phases.overdue.notification_id);
  assert.deepEqual(report.phases.maintenance_completed, {
    phase: "maintenance-completed",
    completion_recorded: true,
    reminders_resolved: 1,
    pending_count: 0,
    completed_history_count: 1,
    physical_maintenance_performed_by_agent: false,
    completion_source: "synthetic_demo_fixture",
    user_interaction_performed: false,
    next_due_at: "2026-11-20T10:00:00.000Z",
  });
  assert.equal(report.phases.next_cycle.status, "DUE_SOON");
  assert.equal(report.phases.next_cycle.reminders_created, 1);
  assert.equal(report.phases.next_cycle.pending_count, 1);
  assert.equal(report.phases.next_cycle.previous_cycle_preserved, true);
  assert.equal(report.phases.next_cycle.previous_cycle_notification_id, report.phases.initial.notification_id);
  assert.notEqual(report.phases.next_cycle.notification_id, report.phases.initial.notification_id);
  assert.equal(report.phases.archived.archived_count, 1);
  assert.equal(report.phases.archived.active_pending_count, 1);
  assert.equal(report.phases.archived.archive_history_count, 1);
  assert.equal(report.phases.archived.archived_notification_id, report.phases.initial.notification_id);
  assert.equal(report.phases.archived.notifications_deleted, false);
  assert.equal(report.phases.archived.confirmation_source, "synthetic_demo_fixture");
  assert.deepEqual(report.guardrails, {
    real_openclaw_gateway_used: false,
    real_home_assistant_used: false,
    model_api_called: false,
    external_notification_sent: false,
    periodic_timer_started: false,
    device_action_performed: false,
    physical_maintenance_performed: false,
    temporary_state_removed: true,
  });
});
