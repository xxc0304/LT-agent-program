import assert from "node:assert/strict";
import test from "node:test";
import { runIndependentLearningEnergyDemo } from "../src/independent-learning-energy-demo.js";

test("独立学习→节能→设备管家组合验收只作用于 Mock 且覆盖门禁与待确认路径", async () => {
  const result = await runIndependentLearningEnergyDemo({ now: () => Date.parse("2026-10-15T10:00:00.000Z") });
  assert.equal(result.success, true);
  assert.equal(result.simulation, true);
  assert.equal(result.model_calls, 0);
  assert.equal(result.real_home_assistant_connected, false);
  assert.equal(result.device_actions_executed, 0);
  assert.ok(result.scenarios.every((scenario) => scenario.mock_action_audit_entries === 0));
  assert.deepEqual(result.scenarios.map((scenario) => scenario.status), [
    "REJECTED",
    "REVIEW_REQUIRED",
    "NO_ACTION",
    "CHALLENGE",
  ]);
  assert.ok(result.scenarios.every((scenario) => scenario.final_light_state === "on"));
  assert.deepEqual(result.scenarios[0].simulated_agent_invocations, []);
  assert.deepEqual(result.scenarios[1].simulated_agent_invocations, ["learning-companion"]);
  assert.deepEqual(result.scenarios[2].simulated_agent_invocations, ["learning-companion", "energy-saving"]);
  assert.deepEqual(result.scenarios[3].agents_involved, ["learning-companion", "energy-saving", "device-manager"]);
  assert.equal(result.scenarios[3].confirmation_required, true);
});
