import test from "node:test";
import assert from "node:assert/strict";
import { evaluateEnergyEffect } from "../src/energy-effectiveness.js";

const deviceIds = ["meter.room"];

function window(start, values) {
  const startMs = Date.parse(start);
  return {
    start_at: new Date(startMs).toISOString(),
    end_at: new Date(startMs + values.length * 15 * 60_000).toISOString(),
    readings: values.map((interval_kwh, index) => ({
      device_id: "meter.room",
      recorded_at: new Date(startMs + (index + 1) * 15 * 60_000).toISOString(),
      interval_kwh,
    })),
  };
}

test("完整匹配窗口返回观察差值与百分比，并明确不做因果归因", () => {
  const report = evaluateEnergyEffect({
    baseline: window("2026-10-15T00:00:00Z", [0.4, 0.6, 0.2, 0.8]),
    follow_up: window("2026-10-16T00:00:00Z", [0.3, 0.5, 0.2, 0.6]),
    device_ids: deviceIds,
    interval_minutes: 15,
  });

  assert.equal(report.status, "COMPARABLE");
  assert.equal(report.baseline.total_kwh, 2);
  assert.equal(report.follow_up.total_kwh, 1.6);
  assert.equal(report.observed_change.baseline_minus_follow_up_kwh, 0.4);
  assert.equal(report.observed_change.reduction_percent, 20);
  assert.equal(report.observed_change.direction, "LOWER_AFTER_AT_REPORT_PRECISION");
  assert.equal(report.causality, "NOT_ESTABLISHED_BY_BEFORE_AFTER_COMPARISON");
});

test("缺失采样、重复读数或不同窗口时长时不计算差值", () => {
  const baseline = window("2026-10-15T00:00:00Z", [0.5, 0.5]);
  const missing = window("2026-10-16T00:00:00Z", [0.3]);
  missing.end_at = new Date(Date.parse(missing.start_at) + 30 * 60_000).toISOString();
  const report = evaluateEnergyEffect({ baseline, follow_up: missing, device_ids: deviceIds, interval_minutes: 15 });
  assert.equal(report.status, "INSUFFICIENT_OR_MISMATCHED_DATA");
  assert.equal(report.observed_change.baseline_minus_follow_up_kwh, null);
  assert.equal(report.observed_change.direction, "NOT_COMPARABLE");
  assert.equal(report.follow_up.coverage.missing, 1);
});

test("拒绝未声明设备、重复设备、越界或未对齐的读数", () => {
  const baseline = window("2026-10-15T00:00:00Z", [0.5]);
  const followUp = window("2026-10-16T00:00:00Z", [0.4]);
  followUp.readings.push({ device_id: "other.meter", recorded_at: "2026-10-16T00:30:00Z", interval_kwh: 0.1 });
  const report = evaluateEnergyEffect({ baseline, follow_up: followUp, device_ids: deviceIds, interval_minutes: 15 });
  assert.equal(report.status, "INSUFFICIENT_OR_MISMATCHED_DATA");
  assert.match(report.follow_up.rejected_readings[0].reason, /不在显式比较清单/);
});

test("基线为零时不除零计算百分比", () => {
  const report = evaluateEnergyEffect({
    baseline: window("2026-10-15T00:00:00Z", [0]),
    follow_up: window("2026-10-16T00:00:00Z", [0]),
    device_ids: deviceIds,
    interval_minutes: 15,
  });
  assert.equal(report.status, "COMPARABLE");
  assert.equal(report.observed_change.reduction_percent, null);
  assert.equal(report.observed_change.direction, "NO_DIFFERENCE_AT_REPORT_PRECISION");
});

test("输入条件非法时明确拒绝，而不是猜测归一化方案", () => {
  const baseline = window("2026-10-15T00:00:00Z", [0.5]);
  const followUp = window("2026-10-16T00:00:00Z", [0.4]);
  assert.throws(() => evaluateEnergyEffect({ baseline, follow_up: followUp, device_ids: [], interval_minutes: 15 }), /device_ids/);
  assert.throws(() => evaluateEnergyEffect({ baseline, follow_up: followUp, device_ids: deviceIds, interval_minutes: 0 }), /interval_minutes/);
});
