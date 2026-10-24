import { Type } from "typebox";

import { runMockMemoryLearningDemo } from "./mock-memory-learning-demo.js";

export const MOCK_MEMORY_LEARNING_TOOL_DEFINITION = {
  name: "run_mock_household_memory_learning_demo",
  label: "run_mock_household_memory_learning_demo",
  description: "仅当用户明确要求演示家庭偏好学习时调用。运行空调温度与灯光亮度的合成 Mock 事件、来源过滤、三日候选、用户确认和场景只读建议。只使用临时存储，不读取或修改正式家庭记忆，不连接真实 Home Assistant，不执行真实设备动作，也不调用大模型训练。回复时必须说明这是模拟数据，不代表真实家庭已经学会偏好；事件数量须照抄结果中的 event_summary，并区分事件记录总数、接受数、忽略数和去重后的证据天数。",
  inputSchema: Type.Object({
    scenario: Type.Literal("device_preferences", {
      description: "演示家庭系统如何从重复的手动设备设值中形成待确认偏好，并在确认后用于场景建议。",
    }),
  }, { additionalProperties: false }),
};

export async function executeMockMemoryLearningTool({ scenario } = {}) {
  if (scenario !== "device_preferences") {
    return {
      success: false,
      simulation: true,
      error: { code: "DEMO_SCENARIO_UNSUPPORTED", message: "当前只支持 device_preferences Mock 演示。" },
    };
  }
  return runMockMemoryLearningDemo();
}
