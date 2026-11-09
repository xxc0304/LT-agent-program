import assert from "node:assert/strict";
import test from "node:test";

import {
  createMockHouseholdRun,
  loadOfflineScenarioDefinitions,
  runOfflinePreflight,
} from "./mock-household-harness.mjs";

function deviceState(run, deviceId) {
  return run.snapshot().find((device) => device.device_id === deviceId)?.state;
}

test("scenario fixtures are complete and use unique IDs", () => {
  const scenarios = loadOfflineScenarioDefinitions();
  assert.ok(scenarios.length >= 5);
  assert.equal(new Set(scenarios.map((scenario) => scenario.scenario_id)).size, scenarios.length);
  for (const scenario of scenarios) {
    assert.ok(Array.isArray(scenario.devices) && scenario.devices.length > 0, scenario.scenario_id);
    assert.ok(Array.isArray(scenario.mock_action_allowlist), scenario.scenario_id);
    assert.ok(scenario.offline_probe && typeof scenario.offline_probe.operation === "string", scenario.scenario_id);
    assert.ok(scenario.expected && typeof scenario.expected === "object", scenario.scenario_id);
    assert.equal(Number.isInteger(scenario.expected.action_attempts), true, scenario.scenario_id);
  }
});

test("offline preflight executes the scenario probes and emits a scoped report", () => {
  const report = runOfflinePreflight({ candidate: "D", replicate: 2 });
  assert.equal(report.status, "passed");
  assert.equal(report.network_used, false);
  assert.equal(report.real_home_assistant_used, false);
  assert.equal(report.model_called, false);
  assert.equal(report.scenario_count, 6);
  assert.equal(report.passed_scenario_count, 6);
  assert.equal(report.failed_scenario_count, 0);
  assert.ok(report.scenarios.every((scenario) => scenario.passed));
  assert.equal(report.scenarios.find((scenario) => scenario.scenario_id === "S05").summary.successful_write_count, 1);
  assert.equal(report.scenarios.find((scenario) => scenario.scenario_id === "S09").summary.successful_write_count, 0);
});

test("each candidate and replicate receives an identical isolated initial state", () => {
  const runA = createMockHouseholdRun({ candidate: "A", scenarioId: "S05", replicate: 1 });
  const runD = createMockHouseholdRun({ candidate: "D", scenarioId: "S05", replicate: 1 });
  assert.deepEqual(runA.initialDevices, runD.initialDevices);
  assert.equal(runA.runId, "A-S05-r1");
  assert.equal(runD.runId, "D-S05-r1");

  const action = runA.simulateAction({ device_id: "light.study_room", action: "turn_off" });
  assert.equal(action.success, true);
  assert.equal(deviceState(runA, "light.study_room"), "off");
  assert.equal(deviceState(runD, "light.study_room"), "on");
});

test("state query returns the fixture value instead of relying on user text", () => {
  const run = createMockHouseholdRun({ candidate: "B", scenarioId: "S01" });
  const result = run.readState("sensor.living_room_temperature");
  assert.equal(result.success, true);
  assert.equal(Number(result.device.state), 25.4);
  assert.deepEqual(run.summary().read_attempts, [
    { device_id: "sensor.living_room_temperature", attempt: 1, success: true, error_code: null },
  ]);
});

test("allowed simulated write changes only its target and verifies via readback", () => {
  const run = createMockHouseholdRun({ candidate: "C", scenarioId: "S05" });
  const result = run.simulateAction({ device_id: "light.study_room", action: "turn_off" });
  assert.equal(result.success, true);
  assert.equal(result.verified, true);
  assert.equal(run.readState("light.study_room").device.state, "off");
  assert.equal(deviceState(run, "light.living_room"), "on");
  const summary = run.summary();
  assert.equal(summary.action_attempt_count, 1);
  assert.equal(summary.successful_write_count, 1);
});

test("conflicting and low-confidence scenarios record blocked attempts without state changes", () => {
  for (const scenarioId of ["S07", "S08"]) {
    const run = createMockHouseholdRun({ candidate: "D", scenarioId });
    const target = scenarioId === "S07" ? "light.living_room" : "light.study_room";
    const result = run.simulateAction({ device_id: target, action: "turn_off" });
    assert.equal(result.success, false);
    assert.equal(result.denied, true);
    assert.equal(deviceState(run, target), "on");
    assert.equal(run.summary().action_attempt_count, 1);
    assert.equal(run.summary().successful_write_count, 0);
  }
});

test("OpenClaw chat confirmation alone does not unlock the mock front door", () => {
  const run = createMockHouseholdRun({ candidate: "A", scenarioId: "S09" });
  const result = run.simulateAction({
    device_id: "lock.front_door",
    action: "unlock",
    confirmed: true,
  });
  assert.equal(result.success, false);
  assert.equal(result.error.code, "TRUSTED_AUTHENTICATION_REQUIRED");
  assert.equal(deviceState(run, "lock.front_door"), "locked");
  assert.equal(run.summary().action_attempt_count, 1);
  assert.equal(run.summary().successful_write_count, 0);
  assert.equal(run.summary().action_attempts[0].error_code, "TRUSTED_AUTHENTICATION_REQUIRED");
});

test("synthetic provider outage is classified as an environment failure and not retried", () => {
  const run = createMockHouseholdRun({ candidate: "B", scenarioId: "S11" });
  const result = run.readState("sensor.living_room_temperature");
  assert.equal(result.success, false);
  assert.equal(result.error.code, "MOCK_PROVIDER_503");
  assert.equal(result.error.category, "environment");
  assert.equal(run.summary().read_attempt_count, 1);
  assert.equal(run.summary().read_attempts[0].error_code, "MOCK_PROVIDER_503");
  assert.equal(run.summary().successful_write_count, 0);
});

test("harness rejects unknown candidates and scenarios rather than guessing", () => {
  assert.throws(() => createMockHouseholdRun({ candidate: "E", scenarioId: "S01" }), TypeError);
  assert.throws(() => createMockHouseholdRun({ candidate: "A", scenarioId: "S99" }), TypeError);
});
