import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMockOperationsReport } from "../src/operations-demo.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("集成 Mock 演示产生带来源标识、可解释策略与维护处置的报告", async () => {
  const report = buildMockOperationsReport();
  assert.equal(report.source, "MOCK");
  assert.equal(report.energy_analysis.summary.total_kwh, 2.2);
  assert.equal(report.energy_analysis.summary.cost, 1.65);
  assert.equal(report.effect_evaluation.status, "COMPARABLE");
  assert.equal(report.effect_evaluation.observed_change.baseline_minus_follow_up_kwh, 0.4);
  assert.equal(report.effect_evaluation.causality, "NOT_ESTABLISHED_BY_BEFORE_AFTER_COMPARISON");
  assert.ok(report.energy_analysis.possible_anomalies.some((item) => item.type === "ABOVE_EXPLICIT_BASELINE"));
  assert.ok(report.energy_analysis.possible_anomalies.some((item) => item.type === "POWER_WHILE_REPORTED_OFF"));
  assert.ok(report.energy_strategy.recommendations.some((item) => item.code === "CONSIDER_SHIFTING_FLEXIBLE_LOADS"));
  assert.equal(report.maintenance_plan.summary.overdue_count, 1);
  assert.equal(report.maintenance_plan.summary.due_soon_count, 1);
  assert.ok(report.maintenance_plan.items.some((item) => item.exception?.code === "CONNECTIVITY_UNVERIFIED"));
  assert.equal(report.maintenance_plan.safety.device_control_performed, false);
  assert.ok(report.interpretation.every((line) => /Mock|合成|不能|不会|未估算|不是/.test(line)));
});

test("smoke 输出明确留在占位类型，不伪装成真实分析结果", async () => {
  const { spawnSync } = await import("node:child_process");
  const scriptPath = path.join(projectRoot, "energy-saving", "src", "operations-demo.js");
  const run = spawnSync(process.execPath, [scriptPath, "--smoke"], { cwd: projectRoot, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const artifactPath = path.join(projectRoot, "tmp", "energy-operations", "operations-report.json");
  const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
  assert.equal(artifact.report_status, "SMOKE_PLACEHOLDER");
  assert.equal(artifact.source, "MOCK");
});
