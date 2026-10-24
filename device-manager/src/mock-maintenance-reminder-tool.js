import { Type } from "typebox";

import { runMaintenanceReminderDemo } from "./maintenance-reminder-demo.js";

export const MOCK_MAINTENANCE_REMINDER_TOOL_DEFINITION = {
  name: "run_mock_maintenance_reminder_demo",
  label: "run_mock_maintenance_reminder_demo",
  description: "仅当用户明确要求演示/模拟维护提醒流程时调用。使用临时合成滤芯计划，演示近期提醒、独立 Node.js 进程重启后的持久化去重、明确时长的暂缓及到期恢复、合成夹具模拟已读但不代表真人确认或维护完成、逾期后重新打开提醒，以及模拟明确记录维护完成后关闭待办并保留历史。不要用于查询真实家庭维护状态；结果必须明确说明全程是 Mock，不连接 Gateway/HA，不写正式维护台账，不发送外部通知，不启动周期任务，也不控制设备或实际维修。",
  inputSchema: Type.Object({
    scenario: Type.Literal("reminder_lifecycle", {
      description: "仅演示维护提醒的生成、跨进程去重、暂缓/到期恢复、合成已读边界、逾期升级和维护完成后关闭提醒。",
    }),
  }, { additionalProperties: false }),
};

export async function executeMockMaintenanceReminderTool({ scenario } = {}) {
  if (scenario !== "reminder_lifecycle") {
    return {
      success: false,
      simulation: true,
      error: {
        code: "DEMO_SCENARIO_UNSUPPORTED",
        message: "当前只支持 reminder_lifecycle Mock 演示。",
      },
    };
  }

  const report = await runMaintenanceReminderDemo();
  const {
    initial,
    restarted,
    snoozed,
    snooze_expired: snoozeExpired,
    acknowledged,
    overdue,
    maintenance_completed: maintenanceCompleted,
  } = report.phases;
  const sameReminder = [restarted, snoozed, snoozeExpired, overdue]
    .every((phase) => initial.notification_id === phase.notification_id);

  return {
    success: sameReminder
      && initial.status === "DUE_SOON"
      && restarted.reminders_created === 0
      && snoozed.status === "SNOOZED"
      && snoozed.maintenance_completed === false
      && snoozeExpired.status === "pending"
      && snoozeExpired.snoozed_reopened === 1
      && acknowledged.maintenance_completed === false
      && acknowledged.user_interaction_performed === false
      && overdue.status === "OVERDUE"
      && overdue.reopened_after_escalation === true
      && maintenanceCompleted.completion_recorded === true
      && maintenanceCompleted.reminders_resolved === 1
      && maintenanceCompleted.pending_count === 0
      && maintenanceCompleted.completed_history_count === 1
      && maintenanceCompleted.physical_maintenance_performed_by_agent === false
      && maintenanceCompleted.user_interaction_performed === false,
    simulation: true,
    demo: report.demo,
    phases: {
      initial_reminder: {
        status: initial.status,
        reminders_created: initial.reminders_created,
      },
      process_restart: {
        process_restarted: restarted.process_restarted,
        reminders_created: restarted.reminders_created,
        duplicate_checks_skipped: restarted.duplicate_checks_skipped,
        pending_count: restarted.pending_count,
        status: restarted.status,
        same_reminder_preserved: sameReminder,
      },
      user_snooze: {
        status: snoozed.status,
        snoozed_until: snoozed.snoozed_until,
        maintenance_completed: snoozed.maintenance_completed,
        user_interaction_performed: snoozed.user_interaction_performed,
      },
      snooze_expired: {
        status: snoozeExpired.status,
        snoozed_reopened: snoozeExpired.snoozed_reopened,
        same_reminder_preserved: sameReminder,
      },
      synthetic_acknowledgment: {
        status: acknowledged.status,
        maintenance_completed: acknowledged.maintenance_completed,
        user_interaction_performed: acknowledged.user_interaction_performed,
        pending_count_after_acknowledgment: acknowledged.pending_count_after_acknowledgment,
      },
      overdue_escalation: {
        status: overdue.status,
        reopened_after_escalation: overdue.reopened_after_escalation,
        same_reminder_preserved: sameReminder,
      },
      maintenance_completion: {
        completion_recorded: maintenanceCompleted.completion_recorded,
        reminders_resolved: maintenanceCompleted.reminders_resolved,
        pending_count: maintenanceCompleted.pending_count,
        completed_history_count: maintenanceCompleted.completed_history_count,
        physical_maintenance_performed_by_agent: maintenanceCompleted.physical_maintenance_performed_by_agent,
        completion_source: maintenanceCompleted.completion_source,
        user_interaction_performed: maintenanceCompleted.user_interaction_performed,
      },
    },
    guardrails: report.guardrails,
  };
}
