import assert from "node:assert/strict";
import test from "node:test";

import { planEnergyOptimization } from "../src/energy-optimization.js";

const now = Date.parse("2026-10-25T18:00:00+08:00");
const tariff = {
  currency: "CNY",
  segments: [
    { name: "off_peak", tier: "off_peak", start: "00:00", end: "07:00", price_per_kwh: 0.3 },
    { name: "shoulder", tier: "shoulder", start: "07:00", end: "10:00", price_per_kwh: 0.65 },
    { name: "peak", tier: "peak", start: "10:00", end: "22:00", price_per_kwh: 1.2 },
    { name: "night_off_peak", tier: "off_peak", start: "22:00", end: "00:00", price_per_kwh: 0.3 },
  ],
};

test("低价排程按 15 分钟搜索并返回本地时间与估算费用差", () => {
  const result = planEnergyOptimization({
    readings: [],
    tariff,
    timezone: "Asia/Shanghai",
    now,
    flexible_loads: [{
      load_id: "dishwasher-1",
      name: "洗碗机",
      energy_kwh: 1.2,
      duration_minutes: 120,
      earliest_start: new Date(now).toISOString(),
      deadline_at: "2026-10-26T07:00:00+08:00",
      user_marked_flexible: true,
    }],
  });

  const [recommendation] = result.schedule_recommendations;
  assert.equal(recommendation.status, "RECOMMENDATION_READY");
  assert.equal(recommendation.recommended_start_local, "2026-10-25 22:00");
  assert.equal(recommendation.recommended_end_local, "2026-10-26 00:00");
  assert.equal(recommendation.estimated_cost, 0.36);
  assert.equal(recommendation.earliest_window_cost, 1.44);
  assert.equal(recommendation.estimated_cost_difference, 1.08);
  assert.equal(recommendation.action_taken, false);
  assert.equal(result.execution.schedules_installed, false);
});

test("未由用户标记可延后的负载不进入低价排程", () => {
  const result = planEnergyOptimization({
    readings: [],
    tariff,
    now,
    flexible_loads: [{
      load_id: "heater-1",
      name: "取暖器",
      user_marked_flexible: false,
    }],
  });

  assert.deepEqual(result.schedule_recommendations, [{
    load_id: "heater-1",
    name: "取暖器",
    status: "OMITTED",
    reason: "NOT_MARKED_FLEXIBLE_BY_USER",
  }]);
  assert.equal(result.execution.device_control_performed, false);
});

test("待机候选必须显式标记、读数新鲜且映射控制插座", () => {
  const readings = [
    {
      device_id: "meter.valid",
      control_device_id: "switch.plug.valid",
      area: "kitchen",
      recorded_at: new Date(now).toISOString(),
      interval_kwh: 0.01,
      power_w: 12,
      load_mode: "standby",
    },
    {
      device_id: "meter.unlabeled",
      control_device_id: "switch.plug.unlabeled",
      recorded_at: new Date(now).toISOString(),
      interval_kwh: 0.01,
      power_w: 12,
    },
    {
      device_id: "meter.old",
      control_device_id: "switch.plug.old",
      recorded_at: new Date(now - 10 * 60_000).toISOString(),
      interval_kwh: 0.01,
      power_w: 12,
      load_mode: "standby",
    },
    {
      device_id: "meter.unmapped",
      recorded_at: new Date(now).toISOString(),
      interval_kwh: 0.01,
      power_w: 12,
      load_mode: "standby",
    },
  ];
  const result = planEnergyOptimization({ readings, tariff, now });

  assert.deepEqual(result.standby_action_candidates.map((item) => item.control_device_id), ["switch.plug.valid"]);
  assert.deepEqual(result.omitted_standby_readings.map((item) => item.reason), [
    "STALE_OR_FUTURE_STANDBY_READING",
    "EXPLICIT_CONTROL_DEVICE_MAPPING_REQUIRED",
  ]);
  assert.equal(result.execution.device_control_performed, false);
  assert.equal(result.execution.user_confirmation_required_for_device_actions, true);
});
