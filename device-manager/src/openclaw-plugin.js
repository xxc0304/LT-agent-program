import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

import { createDeviceToolRuntime, DEVICE_TOOL_DEFINITIONS } from "./tools.js";
import { createOrchestratorBridge } from "./orchestrator-bridge.js";
import { ORCHESTRATOR_TOOL_DEFINITIONS } from "./orchestrator-tools.js";
import { PreferenceMemoryStore } from "../../agent-memory/src/memory-store.js";
import { createHouseholdMemoryTools, HOUSEHOLD_MEMORY_TOOL_DEFINITIONS } from "./memory-tools.js";
import { createScenePlanningTools, SCENE_PLANNING_TOOL_DEFINITIONS } from "./scene-planning-tools.js";

const runtime = createDeviceToolRuntime();
const orchestrator = createOrchestratorBridge(runtime);
const householdMemory = createHouseholdMemoryTools(new PreferenceMemoryStore());
const scenePlanning = createScenePlanningTools({
  deviceRuntime: runtime,
  getHouseholdPreference: householdMemory.get_household_preference,
});

const TOOL_DEFINITIONS = [
  ...DEVICE_TOOL_DEFINITIONS,
  ...ORCHESTRATOR_TOOL_DEFINITIONS,
  ...HOUSEHOLD_MEMORY_TOOL_DEFINITIONS,
  ...SCENE_PLANNING_TOOL_DEFINITIONS,
];

export default defineToolPlugin({
  id: "device-manager",
  name: "家庭设备管家",
  description: "为家庭微脑提供设备查询/控制、多 Agent 事件调度、家庭偏好记忆，以及经用户确认后执行并回读的场景工具，支持 Mock 与真实 Home Assistant REST 后端。",
  tools: (tool) =>
    TOOL_DEFINITIONS.map((definition) =>
      tool({
        name: definition.name,
        label: definition.name,
        description: definition.description,
        parameters: definition.inputSchema,
        async execute(params, _config, context) {
          context.signal?.throwIfAborted();
          if (definition.name === "run_scene") {
            return {
              success: false,
              execution_performed: false,
              error: {
                code: "SCENE_CONFIRMATION_REQUIRED",
                message: "不能直接调用固定场景执行器。请先用 plan_scene 展示计划，等待用户在后续消息原样发送确认口令，再调用 execute_scene_plan。",
              },
            };
          }
          if (definition.name === "dispatch_agent_event") {
            return orchestrator.dispatchEvent(params.event, { autoRun: params.auto_run ?? true });
          }
          if (Object.hasOwn(scenePlanning, definition.name)) return scenePlanning[definition.name](params);
          if (Object.hasOwn(householdMemory, definition.name)) return householdMemory[definition.name](params);
          return runtime.invoke(definition.name, params);
        },
      }),
    ),
});
