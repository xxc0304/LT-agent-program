import { Type } from "typebox";

import { runMockAgentChainDemo } from "./mock-agent-chain-demo.js";

export const MOCK_AGENT_CHAIN_TOOL_DEFINITION = {
  name: "run_mock_agent_chain_demo",
  label: "run_mock_agent_chain_demo",
  description: "仅当用户明确用自然语言要求‘演示/模拟多 Agent 协作链路’时调用。运行学习伴学事件→节能规划→设备管家执行→状态回读的合成事件演示，始终使用专用 Mock HA，绝不连接真实 HA。结果必须说明占用/学习事件是程序生成的演示数据，不是实时识别或传感器证据。不要将本工具用于普通家庭控制请求。",
  inputSchema: Type.Object({
    scenario: Type.Literal("learning_departure", {
      description: "模拟孩子离开书桌 10 分钟、同区域无人，观察能源管家是否委派设备管家关闭客厅灯。仅限演示。",
    }),
  }, { additionalProperties: false }),
};

export async function executeMockAgentChainTool({ scenario } = {}) {
  if (scenario !== "learning_departure") {
    return {
      success: false,
      simulation: true,
      error: { code: "DEMO_SCENARIO_UNSUPPORTED", message: "当前只支持 learning_departure 演示场景。" },
    };
  }
  return runMockAgentChainDemo();
}
