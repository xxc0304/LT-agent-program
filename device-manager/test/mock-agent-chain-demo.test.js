import test from "node:test";
import assert from "node:assert/strict";

import { runMockAgentChainDemo } from "../src/mock-agent-chain-demo.js";
import { executeMockAgentChainTool, MOCK_AGENT_CHAIN_TOOL_DEFINITION } from "../src/mock-agent-chain-tool.js";

test("自然语言演示工具运行完整合成多 Agent 链路并始终使用 Mock HA", async () => {
  const result = await runMockAgentChainDemo({ createRunId: () => "test-run" });

  assert.equal(result.success, true);
  assert.equal(result.simulation, true);
  assert.equal(result.backend, "Mock Home Assistant");
  assert.deepEqual(result.agents_involved, ["learning-companion", "energy-saving", "device-manager"]);
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.planned_tasks.length, 1);
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0].result.verified, true);
  assert.equal(result.final_light_state, "off");
  assert.match(result.note, /合成样例/);
});

test("Mock 多 Agent 自然语言入口只暴露支持的演示场景", async () => {
  assert.equal(MOCK_AGENT_CHAIN_TOOL_DEFINITION.name, "run_mock_agent_chain_demo");

  const rejected = await executeMockAgentChainTool({ scenario: "arbitrary_device_control" });
  assert.equal(rejected.success, false);
  assert.equal(rejected.error.code, "DEMO_SCENARIO_UNSUPPORTED");

  const result = await executeMockAgentChainTool({ scenario: "learning_departure" });
  assert.equal(result.success, true);
  assert.equal(result.simulation, true);
  assert.equal(result.final_light_state, "off");
});
