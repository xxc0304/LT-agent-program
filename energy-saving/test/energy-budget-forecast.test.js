import assert from "node:assert/strict";
import test from "node:test";

import { forecastEnergyBudget } from "../src/energy-budget-forecast.js";
import { EnergySavingAgent } from "../src/energy-agent.js";

const baseInput = {
  budget_kwh: 100,
  period_start: "2026-10-01",
  period_end: "2026-10-31",
  through_date: "2026-10-03",
  coverage_attested_complete: true,
  daily_totals: [
    { date: "2026-10-01", energy_kwh: 2 },
    { date: "2026-10-02", energy_kwh: 3 },
    { date: "2026-10-03", energy_kwh: 4 },
  ],
};

test("complete daily totals produce an advisory pace estimate", () => {
  const result = forecastEnergyBudget(baseInput);

  assert.equal(result.status, "PACE_WITHIN_BUDGET");
  assert.equal(result.coverage.complete_days, 3);
  assert.equal(result.coverage.remaining_days, 28);
  assert.equal(result.estimate.observed_kwh, 9);
  assert.equal(result.estimate.average_daily_kwh, 3);
  assert.equal(result.estimate.projected_period_kwh, 93);
  assert.equal(result.estimate.projected_budget_ratio, 0.93);
  assert.equal(result.safety.device_tasks_created, false);
  assert.equal(result.safety.device_control_performed, false);
});

test("daily totals may arrive out of order but are matched by date", () => {
  const result = forecastEnergyBudget({
    ...baseInput,
    daily_totals: [...baseInput.daily_totals].reverse(),
  });

  assert.equal(result.estimate.projected_period_kwh, 93);
});

test("missing completeness attestation and fewer than three full days do not forecast", () => {
  const unattested = forecastEnergyBudget({ ...baseInput, coverage_attested_complete: false });
  assert.equal(unattested.status, "NOT_FORECASTED");
  assert.equal(unattested.reason, "COMPLETE_COVERAGE_ATTESTATION_REQUIRED");
  assert.equal(unattested.estimate, null);

  const shortHistory = forecastEnergyBudget({
    ...baseInput,
    through_date: "2026-10-02",
    daily_totals: baseInput.daily_totals.slice(0, 2),
  });
  assert.equal(shortHistory.status, "NOT_FORECASTED");
  assert.equal(shortHistory.reason, "AT_LEAST_THREE_COMPLETE_DAYS_REQUIRED");
});

test("missing and duplicate dates do not forecast", () => {
  const missingDate = forecastEnergyBudget({
    ...baseInput,
    daily_totals: [
      baseInput.daily_totals[0],
      baseInput.daily_totals[2],
      { date: "2026-10-04", energy_kwh: 2 },
    ],
  });
  assert.equal(missingDate.reason, "DAILY_COVERAGE_GAP_OR_EXTRA_DAY");

  const duplicateDate = forecastEnergyBudget({
    ...baseInput,
    daily_totals: [baseInput.daily_totals[0], baseInput.daily_totals[0], baseInput.daily_totals[2]],
  });
  assert.equal(duplicateDate.reason, "DUPLICATE_DAILY_TOTAL");
});

test("rejects malformed dates, negative consumption, and invalid budgets", () => {
  assert.throws(() => forecastEnergyBudget({ ...baseInput, period_start: "2026-02-30" }), /不是有效日期/);
  assert.throws(() => forecastEnergyBudget({ ...baseInput, budget_kwh: 0 }), /大于 0/);
  assert.throws(() => forecastEnergyBudget({
    ...baseInput,
    daily_totals: [{ date: "2026-10-01", energy_kwh: -1 }],
  }), /非负有限数字/);
});

test("EnergySavingAgent exposes budget pace forecasting", () => {
  const agent = new EnergySavingAgent();
  assert.equal(agent.forecastEnergyBudget(baseInput).estimate.projected_period_kwh, 93);
  assert.ok(agent.manifest.capabilities.includes("budget_pace_forecast"));
});
