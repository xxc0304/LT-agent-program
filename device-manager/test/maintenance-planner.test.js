import test from "node:test";
import assert from "node:assert/strict";
import { buildMaintenancePlan } from "../src/maintenance-planner.js";

const now = "2026-10-17T04:00:00.000Z";

test("按维护日期生成逾期、到期、近期和排期未完整提醒", () => {
  const report = buildMaintenancePlan({
    now,
    schedules: [
      { schedule_id: "filter-old", device_id: "air.purifier", maintenance_type: "filter_replacement", last_completed_at: "2026-08-01T04:00:00.000Z", interval_days: 60 },
      { schedule_id: "filter-due", device_id: "air.conditioner", maintenance_type: "filter_replacement", next_due_at: now },
      { schedule_id: "clean-soon", device_id: "humidifier", maintenance_type: "cleaning", next_due_at: "2026-10-21T04:00:00.000Z" },
      { schedule_id: "unknown-date", device_id: "fan", maintenance_type: "inspection" },
    ],
  });

  assert.deepEqual(report.items.map((item) => item.maintenance_status), ["OVERDUE", "DUE", "DUE_SOON", "SCHEDULE_INCOMPLETE"]);
  assert.equal(report.summary.overdue_count, 1);
  assert.equal(report.safety.device_control_performed, false);
  assert.match(report.items[0].next_action, /安排维护/);
});

test("可用维护使用量触发近期或到期提醒", () => {
  const report = buildMaintenancePlan({
    now,
    schedules: [
      { schedule_id: "hours-soon", device_id: "filter.a", maintenance_type: "filter_replacement", next_due_at: "2027-01-01T00:00:00.000Z", usage_since_service: 92, usage_limit: 100, usage_unit: "hours" },
      { schedule_id: "hours-due", device_id: "filter.b", maintenance_type: "filter_replacement", next_due_at: "2027-01-01T00:00:00.000Z", usage_since_service: 101, usage_limit: 100, usage_unit: "hours" },
    ],
  });
  assert.deepEqual(report.items.map((item) => item.maintenance_status), ["OVERDUE", "DUE_SOON"]);
});

test("新鲜离线诊断附加只读排查清单，不自动恢复", () => {
  const report = buildMaintenancePlan({
    now,
    schedules: [{ schedule_id: "filter-a", device_id: "air.a", maintenance_type: "filter_replacement", next_due_at: "2026-12-01T00:00:00.000Z" }],
    device_statuses: [{ device_id: "air.a", status: "offline", checked_at: now }],
  });
  const item = report.items[0];
  assert.equal(item.device_health, "offline");
  assert.equal(item.exception.code, "CONNECTIVITY_UNVERIFIED");
  assert.equal(item.exception.automatic_recovery, false);
  assert.match(item.exception.recovery_steps.join(" "), /重新读取设备状态/);
  assert.equal(report.safety.device_control_performed, false);
});

test("设备异常与维护到期分别记录；健康恢复后不会把故障直接标成维护完成", () => {
  const report = buildMaintenancePlan({
    now,
    schedules: [{ schedule_id: "filter-a", device_id: "air.a", maintenance_type: "filter_replacement", next_due_at: "2026-10-01T00:00:00.000Z" }],
    device_statuses: [{ device_id: "air.a", status: "abnormal", diagnosis_code: "FILTER_BLOCKED", summary: "压差异常", checked_at: now }],
  });
  const item = report.items[0];
  assert.equal(item.maintenance_status, "OVERDUE");
  assert.equal(item.device_health, "abnormal");
  assert.equal(item.exception.diagnosis_code, "FILTER_BLOCKED");
  assert.equal(report.safety.maintenance_completed_automatically, false);
});

test("过期或缺失诊断时间降级为未知，不生成故障恢复指令", () => {
  const report = buildMaintenancePlan({
    now,
    schedules: [
      { schedule_id: "old", device_id: "air.old", maintenance_type: "inspection", next_due_at: "2027-01-01T00:00:00.000Z" },
      { schedule_id: "missing", device_id: "air.missing", maintenance_type: "inspection", next_due_at: "2027-01-01T00:00:00.000Z" },
    ],
    device_statuses: [
      { device_id: "air.old", status: "offline", checked_at: "2026-10-17T03:00:00.000Z" },
      { device_id: "air.missing", status: "abnormal" },
    ],
  });
  assert.ok(report.items.every((item) => item.device_health === "unknown"));
  assert.ok(report.items.every((item) => !item.exception));
});

test("拒绝非法维护区间、usage 字段不成对和重复 schedule id", () => {
  assert.throws(() => buildMaintenancePlan({ schedules: [{ schedule_id: "x", device_id: "a", maintenance_type: "filter_replacement", interval_days: 0 }] }), /interval_days/);
  assert.throws(() => buildMaintenancePlan({ schedules: [{ schedule_id: "x", device_id: "a", maintenance_type: "filter_replacement", usage_limit: 10 }] }), /必须同时提供/);
  assert.throws(() => buildMaintenancePlan({ schedules: [
    { schedule_id: "x", device_id: "a", maintenance_type: "cleaning" },
    { schedule_id: "x", device_id: "b", maintenance_type: "cleaning" },
  ] }), /schedule_id 重复/);
});
