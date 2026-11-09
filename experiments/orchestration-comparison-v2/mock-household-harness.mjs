import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { MockHomeAssistant } from "../../device-manager/src/mock-ha.js";

const fixtureUrl = new URL("./fixtures/offline-scenarios.json", import.meta.url);
export const OFFLINE_SCENARIOS = Object.freeze(JSON.parse(readFileSync(fixtureUrl, "utf8")));
const SCENARIO_BY_ID = new Map(OFFLINE_SCENARIOS.map((scenario) => [scenario.scenario_id, scenario]));
const CANDIDATES = new Set(["A", "B", "C", "D"]);

function clone(value) {
  return structuredClone(value);
}

function actionKey({ device_id, action }) {
  return `${device_id}:${action}`;
}

function findScenario(scenarioId) {
  const scenario = SCENARIO_BY_ID.get(scenarioId);
  if (!scenario) throw new TypeError(`Unknown offline scenario: ${scenarioId}`);
  return scenario;
}

/**
 * Create a fresh Mock Home Assistant run for one candidate/scenario/replicate.
 * Every invocation starts from the same fixture snapshot; no real HA client is
 * imported, and every write attempt (including a denied one) is retained.
 */
export function createMockHouseholdRun({ candidate, scenarioId, replicate = 1 } = {}) {
  if (!CANDIDATES.has(candidate)) throw new TypeError("candidate must be A, B, C, or D");
  if (!Number.isSafeInteger(replicate) || replicate < 1) throw new TypeError("replicate must be a positive integer");
  const scenario = findScenario(scenarioId);
  const runId = `${candidate}-${scenario.scenario_id}-r${replicate}`;
  const homeAssistant = new MockHomeAssistant({ devices: clone(scenario.devices) });
  const readAttempts = [];
  const actionAttempts = [];

  function readState(deviceId) {
    const attempt = { device_id: deviceId, attempt: readAttempts.length + 1 };
    readAttempts.push(attempt);
    let result;
    if (scenario.read_fault) {
      result = {
        success: false,
        error: { code: scenario.read_fault.code, category: "environment" },
      };
    } else {
      result = homeAssistant.getState({ device_id: deviceId });
    }
    attempt.success = result.success;
    attempt.error_code = result.error?.code ?? null;
    return result;
  }

  function simulateAction({ device_id, action, parameters = {}, confirmed = false, lock_authorization_proof, lock_authorization_context } = {}) {
    const attempt = {
      sequence: actionAttempts.length + 1,
      device_id,
      action,
      parameters: clone(parameters),
      confirmed,
    };
    actionAttempts.push(attempt);

    if (!scenario.mock_action_allowlist.includes(actionKey({ device_id, action }))) {
      const result = {
        success: false,
        denied: true,
        error: { code: "SCENARIO_WRITE_NOT_AUTHORIZED", category: "policy" },
      };
      recordActionResult(attempt, result);
      return result;
    }

    const result = homeAssistant.controlDevice({
      device_id,
      action,
      parameters,
      confirmed,
      ...(lock_authorization_proof ? { lock_authorization_proof } : {}),
      ...(lock_authorization_context ? { lock_authorization_context } : {}),
      trace_id: runId,
      task_id: `${runId}-task-${attempt.sequence}`,
      idempotency_key: `${runId}-action-${attempt.sequence}`,
    });
    recordActionResult(attempt, result);
    return result;
  }

  function recordActionResult(attempt, result) {
    attempt.success = result.success;
    attempt.denied = result.denied ?? false;
    attempt.error_code = result.error?.code ?? null;
    attempt.verified = result.verified ?? null;
  }

  function snapshot() {
    return homeAssistant.listDevices().devices;
  }

  function summary() {
    const successfulWrites = homeAssistant.getAuditLog();
    return {
      run_id: runId,
      candidate,
      scenario_id: scenario.scenario_id,
      replicate,
      read_attempt_count: readAttempts.length,
      action_attempt_count: actionAttempts.length,
      successful_write_count: successfulWrites.length,
      denied_or_failed_attempt_count: actionAttempts.length - successfulWrites.length,
      final_devices: snapshot(),
      read_attempts: clone(readAttempts),
      action_attempts: clone(actionAttempts),
      successful_writes: successfulWrites,
    };
  }

  return Object.freeze({
    runId,
    candidate,
    scenario: clone(scenario),
    initialDevices: clone(scenario.devices),
    readState,
    simulateAction,
    snapshot,
    summary,
  });
}

export function loadOfflineScenarioDefinitions() {
  return clone(OFFLINE_SCENARIOS);
}

function executeProbe(run, probe) {
  if (probe.operation === "read") {
    const result = run.readState(probe.device_id);
    return {
      operation: probe.operation,
      result,
      readback: result.success ? result.device.state : null,
    };
  }

  if (probe.operation === "action_and_readback" || probe.operation === "blocked_action") {
    const actionResult = run.simulateAction(probe.action);
    const readback = run.readState(probe.readback_device_id ?? probe.action.device_id);
    return { operation: probe.operation, actionResult, readback };
  }

  throw new TypeError(`Unsupported offline probe operation: ${probe.operation}`);
}

function matchesExpected(actual, expected) {
  if (expected.read_error) {
    return actual.result?.success === false && actual.result.error?.code === expected.read_error;
  }
  if (expected.action_success !== undefined) {
    return actual.actionResult?.success === expected.action_success
      && (expected.readback_state === undefined
        || actual.readback?.device?.state === expected.readback_state);
  }
  if (expected.readback_state !== undefined) {
    return actual.readback === expected.readback_state
      || actual.readback?.device?.state === expected.readback_state;
  }
  return false;
}

export function runOfflinePreflight({ candidate = "A", replicate = 1 } = {}) {
  const scenarios = OFFLINE_SCENARIOS.map((scenario) => {
    const run = createMockHouseholdRun({ candidate, scenarioId: scenario.scenario_id, replicate });
    const actual = executeProbe(run, scenario.offline_probe);
    const summary = run.summary();
    const changedDeviceIds = new Set(summary.successful_writes.map((write) => write.device_id));
    const finalById = new Map(summary.final_devices.map((device) => [device.device_id, device]));
    const unrelatedDevicesUnchanged = run.initialDevices
      .filter((device) => !changedDeviceIds.has(device.device_id))
      .every((device) => JSON.stringify(device) === JSON.stringify(finalById.get(device.device_id)));
    const checks = {
      expected_behavior: matchesExpected(actual, scenario.expected),
      successful_write_count: summary.successful_write_count === scenario.expected.writes,
      attempts_recorded: summary.action_attempt_count === scenario.expected.action_attempts,
      unrelated_devices_unchanged: unrelatedDevicesUnchanged,
    };
    return {
      scenario_id: scenario.scenario_id,
      label: scenario.label,
      passed: Object.values(checks).every(Boolean),
      checks,
      actual,
      summary,
    };
  });

  return {
    status: scenarios.every((scenario) => scenario.passed) ? "passed" : "failed",
    scope: "deterministic Mock fixture behavior only; not an LLM orchestration comparison",
    network_used: false,
    real_home_assistant_used: false,
    model_called: false,
    scenario_count: scenarios.length,
    passed_scenario_count: scenarios.filter((scenario) => scenario.passed).length,
    failed_scenario_count: scenarios.filter((scenario) => !scenario.passed).length,
    scenarios,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = runOfflinePreflight();
  report.generated_at = new Date().toISOString();
  const output = process.argv.includes("--json")
    ? report
    : {
      status: report.status,
      scope: report.scope,
      network_used: report.network_used,
      real_home_assistant_used: report.real_home_assistant_used,
      model_called: report.model_called,
      scenario_count: report.scenario_count,
      passed_scenario_count: report.passed_scenario_count,
      failed_scenario_count: report.failed_scenario_count,
      scenarios: report.scenarios.map(({ scenario_id, label, passed, checks }) => ({
        scenario_id,
        label,
        passed,
        checks,
      })),
      generated_at: report.generated_at,
      detail: "Pass --json to include state snapshots, action logs, and read attempts.",
    };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (report.status !== "passed") process.exitCode = 1;
}
