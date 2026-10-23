import assert from "node:assert/strict";
import test from "node:test";

import { runMockFeedbackReplanDemo } from "../src/mock-replan-demo.js";

test("澄清重规划演示只执行用户澄清后的动作并回读验证", async () => {
  const result = await runMockFeedbackReplanDemo();

  assert.equal(result.success, true);
  assert.match(result.conversation[1].text, /打开和关闭/);
  assert.match(result.conversation[1].text, /当前冲突计划不会执行/);
  assert.equal(result.conflict_gate.status, "CLARIFICATION_REQUIRED");
  assert.equal(result.conflict_gate.execution_performed, false);
  assert.equal(result.conflict_gate.approval_allowed, false);
  assert.equal(result.revised_plan.status, "WAITING_FOR_APPROVAL");
  assert.equal(result.revised_plan.execution_performed_before_confirmation, false);
  assert.equal(result.confirmation.workflow_status, "COMPLETED");
  assert.equal(result.final_state.state, "off");
  assert.deepEqual(result.audit.map(({ action, verified }) => ({ action, verified })), [
    { action: "turn_off", verified: true },
  ]);
  assert.equal(result.real_home_assistant_connected, false);
  assert.equal(result.openclaw_gateway_called, false);
  assert.equal(result.llm_used, false);
});
