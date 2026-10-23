import assert from "node:assert/strict";
import test from "node:test";

import { runMockPreferenceConflictDemo } from "../src/mock-preference-conflict-demo.js";

test("端到端 Mock 演示：冲突先阻断，用户选择后才重规划并执行", async () => {
  const result = await runMockPreferenceConflictDemo();

  assert.equal(result.execution_mode, "isolated_mock");
  assert.equal(result.real_home_assistant_connected, false);
  assert.equal(result.live_openclaw_gateway_used, false);
  assert.equal(result.llm_used, false);
  assert.equal(result.conflict.status, "conflict_review");
  assert.deepEqual(result.conflict.candidates.map(({ value }) => value), [24, 25]);
  assert.equal(result.conflict.scene_plan_blocked, true);
  assert.equal(result.conflict.plan_id_created, false);
  assert.equal(result.conflict.device_action_before_resolution, false);
  assert.equal(result.user_choice.memory_resolution_succeeded, true);
  assert.equal(result.user_choice.resulting_preference_status, "confirmed");
  assert.equal(result.user_choice.resulting_preference_temperature_c, 25);
  assert.equal(result.replanned_scene.temperature_c, 25);
  assert.equal(result.replanned_scene.execution_performed_before_confirmation, false);
  assert.equal(result.replanned_scene.user_confirmation_required, true);
  assert.equal(result.execution.success, true);
  assert.equal(result.execution.execution_performed, true);
  assert.equal(result.execution.confirmation_verified, true);
  assert.equal(result.execution.plan_revalidated, true);
  assert.equal(result.execution.all_steps_verified, true);
  assert.equal(result.execution.audit_entries_added, 4);
});
