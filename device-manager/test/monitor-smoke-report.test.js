import assert from "node:assert/strict";
import test from "node:test";

import { buildMonitorSmokeReport } from "../src/monitor-smoke-report.js";

test("HA 监测冒烟报告只输出白名单摘要，不包含令牌、原始状态或属性", () => {
  const report = buildMonitorSmokeReport({
    startResult: {
      success: true,
      monitoring: true,
      backend_mode: "home-assistant",
      connection_state: "connected",
      initial_scan: { success: true, discovered_count: 2, devices: [{ state: "unavailable" }] },
      initial_health_check: { success: true, checked_count: 2, active_alert_count: 0, pending_offline: [{ device_id: "light.study" }] },
    },
    monitorStatus: {
      connection_state: "connected",
      received_event_count: 1,
      last_event: {
        device_id: "light.study",
        domain: "light",
        change_type: "state_changed",
        state_changed: true,
        availability_changed: true,
        available: false,
        old_state: "secret-old-state",
        new_state: "secret-new-state",
        attributes: { private_note: "secret-attribute" },
      },
      last_refresh: { success: true, trigger: "state_change_event", event_count: 1, discovered_count: 2, missing_count: 0 },
      last_diagnosis: { alerts: [{ device_id: "light.study", status: "offline", code: "DEVICE_OFFLINE", state: "unavailable" }] },
      pending_offline: [{ device_id: "light.study", severity_after_grace: "warning", grace_ms: 120_000, recheck_at: "2026-10-10T00:02:00Z", state: "unavailable" }],
      offline_summary: {
        offline_device_count: 3,
        confirmed_offline_device_count: 3,
        pending_offline_device_count: 0,
        grouped_offline_device_count: 2,
        grouped_offline_device_ids: ["light.study", "switch.study_plug"],
        suspected_shared_infrastructure_issue: true,
        shared_infrastructure_incident_active: true,
        summary: "possible shared issue",
      },
      offline_policy: { ordinary_grace_ms: 120_000, critical_grace_ms: 15_000, explicitly_critical_entity_count: 0 },
    },
    events: [
      {
        event_type: "diagnostic_transient",
        occurred_at: "2026-10-10T00:00:00Z",
        severity: "info",
        subject: { device_id: "light.study" },
        payload: { code: "DEVICE_OFFLINE", duration_ms: 8000, summary: "safe summary", state: "unavailable" },
      },
      {
        event_type: "diagnostic_recovered",
        occurred_at: "2026-10-10T00:00:00Z",
        subject: { device_id: "light.study" },
        payload: { previous_code: "DEVICE_OFFLINE", summary: "fixed", attributes: { private_note: "secret-attribute" } },
        source: { id: "https://user:secret-token@ha.example.test" },
      },
      {
        event_type: "diagnostic_shared_infrastructure_suspected",
        occurred_at: "2026-10-10T00:00:00Z",
        severity: "warning",
        subject: {},
        payload: { affected_device_count: 3, summary: "Do not expose this free-form field in the smoke report." },
      },
      { event_type: "action_executed", subject: { device_id: "light.study" }, payload: { action: "turn_on" } },
    ],
    durationMs: 30_000,
  });

  assert.equal(report.result, "CONNECTED");
  assert.equal(report.observed_state_event_count, 1);
  assert.equal(report.diagnostic_events.length, 3);
  assert.equal(report.diagnostic_events[0].duration_ms, 8000);
  assert.equal(report.diagnostic_events[0].severity, "info");
  assert.equal(report.diagnostic_events[1].previous_code, "DEVICE_OFFLINE");
  assert.equal(report.pending_offline[0].grace_ms, 120_000);
  assert.equal(report.offline_summary.suspected_shared_infrastructure_issue, true);
  assert.equal(report.offline_summary.confirmed_offline_device_count, 3);
  assert.equal(report.offline_summary.pending_offline_device_count, 0);
  assert.equal(report.offline_summary.deferred_offline_device_count, 0);
  assert.equal(report.offline_summary.grouped_offline_device_count, 2);
  assert.deepEqual(report.offline_summary.grouped_offline_device_ids, ["light.study", "switch.study_plug"]);
  assert.equal(report.offline_summary.shared_infrastructure_incident_active, true);
  assert.equal(report.diagnostic_events[2].affected_device_count, 3);
  assert.equal(Object.hasOwn(report.diagnostic_events[2], "summary"), false);
  assert.equal(report.initial_health_check.pending_offline_count, 1);
  assert.equal(report.offline_policy.ordinary_grace_ms, 120_000);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("secret-old-state"), false);
  assert.equal(serialized.includes("secret-new-state"), false);
  assert.equal(serialized.includes("secret-attribute"), false);
  assert.equal(serialized.includes("unavailable"), false);
});
