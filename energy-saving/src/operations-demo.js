import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { EnergySavingAgent } from "./energy-agent.js";
import { buildMaintenancePlan } from "../../device-manager/src/maintenance-planner.js";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(sourceDir, "../..");
const outputPath = path.join(projectRoot, "tmp", "energy-operations", "operations-report.json");

export function buildMockOperationsReport() {
  const now = "2026-10-17T12:00:00+08:00";
  const energyAgent = new EnergySavingAgent();
  const energyAgentReport = energyAgent.analyzeEnergyUsage({
    timezone: "Asia/Shanghai",
    tariff: {
      currency: "CNY",
      segments: [
        { name: "night-off-peak", tier: "off_peak", start: "00:00", end: "07:00", price_per_kwh: 0.30 },
        { name: "shoulder", tier: "shoulder", start: "07:00", end: "10:00", price_per_kwh: 0.65 },
        { name: "peak", tier: "peak", start: "10:00", end: "22:00", price_per_kwh: 1.20 },
        { name: "evening-off-peak", tier: "off_peak", start: "22:00", end: "00:00", price_per_kwh: 0.30 },
      ],
    },
    readings: [
      { device_id: "plug.living_room", area: "living_room", recorded_at: "2026-10-17T12:30:00+08:00", interval_kwh: 0.8, expected_kwh: 0.3, device_state: "on", power_w: 480 },
      { device_id: "light.study", area: "study", recorded_at: "2026-10-17T19:00:00+08:00", interval_kwh: 0.2, device_state: "on", power_w: 22 },
      { device_id: "plug.water_heater", area: "bathroom", recorded_at: "2026-10-17T06:20:00+08:00", interval_kwh: 1.1, device_state: "on", power_w: 1100 },
      { device_id: "plug.router", area: "living_room", recorded_at: "2026-10-17T20:45:00+08:00", interval_kwh: 0.1, device_state: "off", power_w: 8 },
    ],
    budget: { period_kwh: 2.0, period_cost: 2.0 },
  });
  const { analysis, strategy } = energyAgentReport;
  const budgetForecast = energyAgent.forecastEnergyBudget({
    budget_kwh: 100,
    period_start: "2026-10-01",
    period_end: "2026-10-31",
    through_date: "2026-10-16",
    coverage_attested_complete: true,
    daily_totals: Array.from({ length: 16 }, (_, index) => ({
      date: new Date(Date.parse("2026-10-01T00:00:00Z") + index * 86_400_000).toISOString().slice(0, 10),
      energy_kwh: 3,
    })),
  });
  const effectEvaluation = energyAgent.evaluateEnergyEffect({
    baseline: {
      start_at: "2026-10-15T00:00:00.000Z",
      end_at: "2026-10-15T01:00:00.000Z",
      readings: [0.4, 0.6, 0.2, 0.8].map((interval_kwh, index) => ({
        device_id: "meter.mock_room",
        recorded_at: new Date(Date.parse("2026-10-15T00:00:00.000Z") + (index + 1) * 15 * 60_000).toISOString(),
        interval_kwh,
      })),
    },
    follow_up: {
      start_at: "2026-10-16T00:00:00.000Z",
      end_at: "2026-10-16T01:00:00.000Z",
      readings: [0.3, 0.5, 0.2, 0.6].map((interval_kwh, index) => ({
        device_id: "meter.mock_room",
        recorded_at: new Date(Date.parse("2026-10-16T00:00:00.000Z") + (index + 1) * 15 * 60_000).toISOString(),
        interval_kwh,
      })),
    },
    device_ids: ["meter.mock_room"],
    interval_minutes: 15,
  });
  const maintenance = buildMaintenancePlan({
    now,
    schedules: [
      {
        schedule_id: "filter-purifier-living-room",
        device_id: "air.purifier.living_room",
        device_name: "客厅空气净化器",
        maintenance_type: "filter_replacement",
        last_completed_at: "2026-08-01T04:00:00.000Z",
        interval_days: 60,
      },
      {
        schedule_id: "clean-humidifier-study",
        device_id: "humidifier.study",
        device_name: "书房加湿器",
        maintenance_type: "cleaning",
        next_due_at: "2026-10-20T04:00:00.000Z",
        usage_since_service: 92,
        usage_limit: 100,
        usage_unit: "hours",
      },
      {
        schedule_id: "inspect-bedroom-fan",
        device_id: "fan.bedroom",
        device_name: "卧室风扇",
        maintenance_type: "inspection",
      },
    ],
    device_statuses: [
      { device_id: "air.purifier.living_room", status: "abnormal", diagnosis_code: "FILTER_PRESSURE_HIGH", summary: "示例诊断：滤网压差偏高", checked_at: "2026-10-17T03:58:00.000Z" },
      { device_id: "humidifier.study", status: "offline", checked_at: "2026-10-17T03:59:00.000Z" },
    ],
  });

  const report = {
    schema_version: "energy-operations.mock-report/0.1",
    source: "MOCK",
    report_status: "COMPLETE_MOCK_SCENARIO",
    scenario: "合成区间电量 + 显式基线/状态 + 人工维护计划 + 合成设备诊断快照",
    generated_at: new Date(now).toISOString(),
    energy_analysis: analysis,
    energy_strategy: strategy,
    energy_budget_forecast: budgetForecast,
    effect_evaluation: effectEvaluation,
    maintenance_plan: maintenance,
    interpretation: [
      "输入均为合成 Mock 数据，不是实时电表或真实 HA 诊断。",
      "能耗合计仅覆盖提交的区间读数，数据完整度未知，不能代表完整账期。",
      "预算进度使用独立的合成逐日数据，完整性声明只对演示夹具成立；按平均速度估算，不代表真实账单或预测。",
      "异常项是复核候选，不是已确认浪费或故障。",
      "节能策略只提供建议；维护异常只提供排查步骤，不会控制、重启或维修设备。",
      "前后效果为一小时合成样本的描述性比较，不代表持续或因果节能。",
      "报告未估算真实节省金额或节能率。",
    ],
  };

  assert.equal(analysis.status, "ANALYZED");
  assert.equal(analysis.summary.total_kwh, 2.2);
  assert.equal(analysis.summary.cost, 1.65);
  assert.ok(analysis.possible_anomalies.length >= 2);
  assert.ok(strategy.recommendations.length >= 2);
  assert.equal(effectEvaluation.status, "COMPARABLE");
  assert.equal(effectEvaluation.observed_change.baseline_minus_follow_up_kwh, 0.4);
  assert.equal(maintenance.summary.overdue_count, 1);
  assert.equal(maintenance.summary.due_soon_count, 1);
  assert.equal(maintenance.safety.device_control_performed, false);
  return report;
}

async function writeReport(report) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path.relative(projectRoot, outputPath);
}

const smokeOnly = process.argv.includes("--smoke");
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (smokeOnly) {
    const report = {
      schema_version: "energy-operations.mock-report/0.1",
      source: "MOCK",
      report_status: "SMOKE_PLACEHOLDER",
      energy_analysis: "NOT_IMPLEMENTED_IN_SMOKE_MODE",
      maintenance_plan: "NOT_IMPLEMENTED_IN_SMOKE_MODE",
      notice: "仅验证 Mock 报告写入链路；不是能耗评估或维护结果。",
    };
    const artifactPath = await writeReport(report);
    console.log(JSON.stringify({ ...report, artifact_path: artifactPath }, null, 2));
  } else {
    const report = buildMockOperationsReport();
    const artifactPath = await writeReport(report);
    console.log(JSON.stringify({
      schema_version: report.schema_version,
      source: report.source,
      report_status: report.report_status,
      total_kwh: report.energy_analysis.summary.total_kwh,
      total_cost: report.energy_analysis.summary.cost,
      budget_pace_status: report.energy_budget_forecast.status,
      projected_period_kwh: report.energy_budget_forecast.estimate?.projected_period_kwh ?? null,
      observed_before_after_delta_kwh: report.effect_evaluation.observed_change.baseline_minus_follow_up_kwh,
      effect_causality: report.effect_evaluation.causality,
      energy_recommendations: report.energy_strategy.recommendations.length,
      maintenance_summary: report.maintenance_plan.summary,
      artifact_path: artifactPath,
    }, null, 2));
  }
}
