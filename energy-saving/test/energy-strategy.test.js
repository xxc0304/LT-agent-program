import test from "node:test";
import assert from "node:assert/strict";
import { analyzeEnergyConsumption } from "../src/energy-analysis.js";
import { createEnergyStrategy } from "../src/energy-strategy.js";

function makeAnalysis({ readings, tariff = null }) {
  return analyzeEnergyConsumption({ readings, tariff });
}

test("按显式 kWh/费用预算返回未超、接近和超限状态，不预测账期结果", () => {
  const analysis = makeAnalysis({
    tariff: { currency: "CNY", segments: [{ name: "all", tier: "peak", start: "00:00", end: "23:59", price_per_kwh: 1 }] },
    readings: [{ device_id: "plug.a", recorded_at: "2026-10-16T10:00:00Z", interval_kwh: 8 }],
  });
  const strategy = createEnergyStrategy(analysis, { budget: { period_kwh: 10, period_cost: 5 } });

  assert.deepEqual(strategy.budgets.map((item) => item.status), ["APPROACHING", "EXCEEDED"]);
  assert.ok(strategy.budgets.every((item) => item.forecast === false));
  assert.equal(strategy.recommendations.length, 2);
  assert.equal(strategy.safety.device_tasks_created, false);
  assert.equal(strategy.safety.device_control_performed, false);
});

test("未完整计价时不声称可评估费用预算", () => {
  const analysis = makeAnalysis({
    tariff: { currency: "CNY", segments: [{ name: "day", start: "08:00", end: "20:00", price_per_kwh: 1 }] },
    readings: [{ device_id: "plug.night", recorded_at: "2026-10-15T21:00:00Z", interval_kwh: 2 }],
  });
  const strategy = createEnergyStrategy(analysis, { budget: { period_cost: 10 } });

  assert.equal(strategy.budgets[0].status, "INSUFFICIENT_DATA");
  assert.equal(strategy.budgets[0].used, null);
  assert.equal(strategy.recommendations.length, 0);
});

test("存在低谷价差且有峰时段用电时，只建议人工评估可转移负载", () => {
  const analysis = makeAnalysis({
    tariff: { currency: "CNY", segments: [
      { name: "offpeak", tier: "off_peak", start: "00:00", end: "08:00", price_per_kwh: 0.3 },
      { name: "peak", tier: "peak", start: "08:00", end: "22:00", price_per_kwh: 1.1 },
      { name: "night", tier: "off_peak", start: "22:00", end: "00:00", price_per_kwh: 0.3 },
    ] },
    readings: [{ device_id: "plug.a", recorded_at: "2026-10-16T10:00:00Z", interval_kwh: 1 }],
  });
  const strategy = createEnergyStrategy(analysis);

  assert.equal(strategy.recommendations[0].code, "CONSIDER_SHIFTING_FLEXIBLE_LOADS");
  assert.equal(strategy.recommendations[0].flexible_loads_inferred, false);
  assert.equal(strategy.recommendations[0].requires_human_review, true);
});

test("没有完整能源证据或更便宜低谷时段时不生成臆测建议", () => {
  const noData = makeAnalysis({ readings: [] });
  assert.equal(createEnergyStrategy(noData, { budget: { period_kwh: 10 } }).status, "INSUFFICIENT_DATA");

  const flatTariff = makeAnalysis({
    tariff: { segments: [{ name: "all", tier: "peak", start: "00:00", end: "23:59", price_per_kwh: 0.5 }] },
    readings: [{ device_id: "plug.a", recorded_at: "2026-10-16T10:00:00Z", interval_kwh: 1 }],
  });
  assert.equal(createEnergyStrategy(flatTariff).recommendations.length, 0);
});

test("拒绝未知分析 schema 与非法预算", () => {
  assert.throws(() => createEnergyStrategy({ schema_version: "other" }), /schema_version/);
  const analysis = makeAnalysis({ readings: [] });
  assert.throws(() => createEnergyStrategy(analysis, { budget: { period_kwh: 0 } }), /大于 0/);
});
