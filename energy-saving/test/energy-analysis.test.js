import test from "node:test";
import assert from "node:assert/strict";
import { analyzeEnergyConsumption } from "../src/energy-analysis.js";

const tariff = {
  currency: "CNY",
  segments: [
    { name: "off-peak", tier: "off_peak", start: "00:00", end: "08:00", price_per_kwh: 0.3 },
    { name: "peak", tier: "peak", start: "08:00", end: "22:00", price_per_kwh: 1.2 },
    { name: "night", tier: "off_peak", start: "22:00", end: "00:00", price_per_kwh: 0.3 },
  ],
};

test("能耗报告按时区汇总设备、区域和小时区间，保留输入覆盖未知语义", () => {
  const report = analyzeEnergyConsumption({
    timezone: "Asia/Shanghai",
    tariff,
    readings: [
      { device_id: "plug.study", area: "study", recorded_at: "2026-10-16T23:20:00Z", interval_kwh: 0.4 },
      { device_id: "light.study", area: "study", recorded_at: "2026-10-16T11:15:00Z", interval_kwh: 0.2 },
    ],
  });

  assert.equal(report.status, "ANALYZED");
  assert.equal(report.summary.total_kwh, 0.6);
  assert.equal(report.summary.cost, 0.36);
  assert.equal(report.summary.peak_window_kwh, 0.2);
  assert.deepEqual(report.by_area, [{ area: "study", consumption_kwh: 0.6 }]);
  assert.deepEqual(report.hourly_profile.map((row) => row.local_hour), [
    "2026-10-16T19:00",
    "2026-10-17T07:00",
  ]);
  assert.equal(report.data_quality.completeness, "UNKNOWN_INPUT_COVERAGE");
});

test("只依据显式基线或关闭状态下的功率读数标注候选异常", () => {
  const report = analyzeEnergyConsumption({
    readings: [
      { device_id: "plug.a", recorded_at: "2026-10-16T10:00:00Z", interval_kwh: 0.2, expected_kwh: 0.1 },
      { device_id: "plug.b", recorded_at: "2026-10-16T10:15:00Z", interval_kwh: 0, device_state: "off", power_w: 8 },
      { device_id: "plug.c", recorded_at: "2026-10-16T10:30:00Z", interval_kwh: 0.2 },
    ],
  });

  assert.deepEqual(report.possible_anomalies.map((item) => item.type), [
    "ABOVE_EXPLICIT_BASELINE",
    "POWER_WHILE_REPORTED_OFF",
  ]);
  assert.ok(report.possible_anomalies.every((item) => item.severity === "review"));
});

test("重复 bucket 与非法读数被计入数据质量，不被累加", () => {
  const readings = [
    { device_id: "plug.a", recorded_at: "2026-10-16T10:00:00Z", interval_kwh: 0.5 },
    { device_id: "plug.a", recorded_at: "2026-10-16T10:00:00Z", interval_kwh: 0.5 },
    { device_id: "plug.b", recorded_at: "bad-time", interval_kwh: 0.8 },
    { device_id: "plug.c", recorded_at: "2026-10-16T10:05:00Z", power_w: 40 },
  ];
  const report = analyzeEnergyConsumption({ readings });

  assert.equal(report.summary.total_kwh, 0.5);
  assert.equal(report.data_quality.accepted_reading_count, 1);
  assert.equal(report.data_quality.rejected_reading_count, 3);
});

test("没有有效 kWh 读数时不把缺失数据伪装成零耗电", () => {
  const report = analyzeEnergyConsumption({ readings: [{ device_id: "plug.a", recorded_at: "2026-10-16T10:00:00Z", power_w: 12 }] });
  assert.equal(report.status, "INSUFFICIENT_DATA");
  assert.equal(report.summary.total_kwh, null);
  assert.equal(report.summary.cost, null);
});

test("不完整电价时段只返回部分费用，不冒充完整费用", () => {
  const report = analyzeEnergyConsumption({
    tariff: { currency: "CNY", segments: [{ name: "day", start: "08:00", end: "20:00", price_per_kwh: 1 }] },
    readings: [
      { device_id: "plug.day", recorded_at: "2026-10-16T10:00:00Z", interval_kwh: 1 },
      { device_id: "plug.night", recorded_at: "2026-10-15T21:00:00Z", interval_kwh: 1 },
    ],
  });
  assert.equal(report.summary.cost_status, "PARTIAL");
  assert.equal(report.summary.cost, null);
  assert.equal(report.summary.partial_cost, 1);
});

test("校验非法电价时段与时区", () => {
  assert.throws(() => analyzeEnergyConsumption({ timezone: "Mars/Olympus", readings: [] }), /timezone/);
  assert.throws(() => analyzeEnergyConsumption({ tariff: { segments: [
    { name: "a", start: "08:00", end: "12:00", price_per_kwh: 1 },
    { name: "b", start: "11:00", end: "14:00", price_per_kwh: 2 },
  ] }, readings: [] }), /重叠/);
});
