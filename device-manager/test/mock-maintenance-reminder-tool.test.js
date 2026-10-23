import assert from "node:assert/strict";
import test from "node:test";

import {
  executeMockMaintenanceReminderTool,
  MOCK_MAINTENANCE_REMINDER_TOOL_DEFINITION,
} from "../src/mock-maintenance-reminder-tool.js";
import plugin from "../src/openclaw-plugin.js";

function unpackToolResult(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const textBlock = result?.content?.find((block) => block.type === "text" && typeof block.text === "string");
  if (textBlock) return JSON.parse(textBlock.text);
  return result;
}

test("维护提醒 Mock 演示工具只接受明确支持的生命周期场景", async () => {
  assert.equal(MOCK_MAINTENANCE_REMINDER_TOOL_DEFINITION.name, "run_mock_maintenance_reminder_demo");
  assert.equal(MOCK_MAINTENANCE_REMINDER_TOOL_DEFINITION.inputSchema.properties.scenario.const, "reminder_lifecycle");

  const rejected = await executeMockMaintenanceReminderTool({ scenario: "check_real_home" });
  assert.equal(rejected.success, false);
  assert.equal(rejected.simulation, true);
  assert.equal(rejected.error.code, "DEMO_SCENARIO_UNSUPPORTED");
});

test("OpenClaw 可调用隔离维护提醒演示并准确暴露各阶段边界", async () => {
  const registeredTools = new Map();
  plugin.register({
    pluginConfig: {},
    registerTool(tool) { registeredTools.set(tool.name, tool); },
  });

  const tool = registeredTools.get("run_mock_maintenance_reminder_demo");
  assert.ok(tool, "插件未注册维护提醒 Mock 演示工具");
  const result = unpackToolResult(await tool.execute("test-maintenance-reminder-demo", {
    scenario: "reminder_lifecycle",
  }, undefined, undefined));

  assert.equal(result.success, true);
  assert.equal(result.simulation, true);
  assert.equal(result.demo, "maintenance-reminder-inbox");
  assert.deepEqual(result.phases.initial_reminder, { status: "DUE_SOON", reminders_created: 1 });
  assert.deepEqual(result.phases.process_restart, {
    process_restarted: true,
    reminders_created: 0,
    duplicate_checks_skipped: 1,
    pending_count: 1,
    status: "DUE_SOON",
    same_reminder_preserved: true,
  });
  assert.equal(result.phases.user_snooze.status, "SNOOZED");
  assert.equal(result.phases.user_snooze.maintenance_completed, false);
  assert.equal(result.phases.user_snooze.user_interaction_performed, false);
  assert.deepEqual(result.phases.snooze_expired, {
    status: "pending",
    snoozed_reopened: 1,
    same_reminder_preserved: true,
  });
  assert.deepEqual(result.phases.synthetic_acknowledgment, {
    status: "ACKNOWLEDGED",
    maintenance_completed: false,
    user_interaction_performed: false,
    pending_count_after_acknowledgment: 0,
  });
  assert.deepEqual(result.phases.overdue_escalation, {
    status: "OVERDUE",
    reopened_after_escalation: true,
    same_reminder_preserved: true,
  });
  assert.deepEqual(result.phases.maintenance_completion, {
    completion_recorded: true,
    reminders_resolved: 1,
    pending_count: 0,
    completed_history_count: 1,
    physical_maintenance_performed_by_agent: false,
    completion_source: "synthetic_demo_fixture",
    user_interaction_performed: false,
  });
  assert.deepEqual(result.guardrails, {
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
