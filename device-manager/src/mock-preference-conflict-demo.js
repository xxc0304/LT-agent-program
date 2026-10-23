import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PreferenceMemoryStore } from "../../agent-memory/src/memory-store.js";
import { createHouseholdMemoryTools } from "./memory-tools.js";
import { MockHomeAssistant } from "./mock-ha.js";
import { createScenePlanningTools } from "./scene-planning-tools.js";
import { createDeviceToolRuntime } from "./tools.js";

/**
 * Deterministic end-to-end mock of the preference-conflict dialogue path.
 * No live LLM, OpenClaw Gateway, or real Home Assistant instance is used.
 */
export async function runMockPreferenceConflictDemo() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-preference-conflict-demo-"));
  const store = new PreferenceMemoryStore({ filePath: path.join(directory, "memory.json") });
  const homeAssistant = new MockHomeAssistant();
  const deviceRuntime = createDeviceToolRuntime(homeAssistant);
  const memoryTools = createHouseholdMemoryTools(store);
  const sceneTools = createScenePlanningTools({
    deviceRuntime,
    getHouseholdPreference: memoryTools.get_household_preference,
  });

  try {
    await memoryTools.remember_household_preference({
      memory_type: "comfort_temperature_c",
      value: 24,
      room_id: "bedroom",
      user_explicit_request: true,
    });
    await memoryTools.set_household_device_action_observation_consent({
      enabled: true,
      user_explicit_confirmation: true,
    });

    for (const [index, day] of ["2026-10-13", "2026-10-14", "2026-10-15"].entries()) {
      await store.proposeInferredCandidate({
        memory_type: "comfort_temperature_c",
        value: 25,
        room_id: "bedroom",
        observation_scope: "device_action",
        event_id: `mock-conflicting-temperature-${index + 1}`,
        observation_date: day,
        confidence: 0.9,
        consent_to_observe: true,
      });
    }

    const conflict = await memoryTools.get_household_preference({
      memory_type: "comfort_temperature_c",
      room_id: "bedroom",
    });
    const blockedPlan = await sceneTools.plan_scene({ scene_id: "sleep" });
    if (conflict.status !== "conflict_review" || blockedPlan.error?.code !== "PREFERENCE_CONFLICT") {
      throw new Error("Mock 冲突未能阻止睡眠场景规划");
    }
    const auditCountAtConflict = homeAssistant.getAuditLog().length;

    // Scripted user selection stands in for a real dialogue turn.
    const chosenCandidate = conflict.candidates.find((candidate) => candidate.status === "conflict_review"
      && candidate.value === 25);
    if (!chosenCandidate?.memory_id) throw new Error("冲突响应未提供可确认候选 ID");
    const deviceActionsBeforeResolution = homeAssistant.getAuditLog().length - auditCountAtConflict;
    const memoryResolution = await memoryTools.confirm_household_memory_candidate({
      memory_id: chosenCandidate.memory_id,
      user_confirmed: true,
    });
    if (!memoryResolution.success) throw new Error(`冲突选择未能保存：${memoryResolution.error?.code}`);

    const resolvedPreference = await memoryTools.get_household_preference({
      memory_type: "comfort_temperature_c",
      room_id: "bedroom",
    });
    const plan = await sceneTools.plan_scene({ scene_id: "sleep" });
    if (!plan.success) throw new Error(`冲突解决后未能生成场景建议：${plan.error?.code}`);
    const plannedTemperature = plan.steps.find((step) => step.action === "set_temperature")?.parameters?.temperature;
    if (plannedTemperature !== 25 || plan.execution_performed !== false) {
      throw new Error("重规划没有使用用户选定的温度，或意外提前执行");
    }

    const auditCountBeforeExecution = homeAssistant.getAuditLog().length;
    const execution = await sceneTools.execute_scene_plan({ plan_id: plan.plan_id, user_confirmed: true });

    return {
      demo: "家庭偏好冲突 → OpenClaw 工具返回候选并阻止计划 → 用户选择 → 重新规划 → 再次确认 → Mock HA 执行及回读",
      execution_mode: "isolated_mock",
      real_home_assistant_connected: false,
      live_openclaw_gateway_used: false,
      llm_used: false,
      conflict: {
        status: conflict.status,
        candidates: conflict.candidates.map(({ value, status, source }) => ({ value, status, source })),
        scene_plan_blocked: blockedPlan.error.code === "PREFERENCE_CONFLICT",
        plan_id_created: Object.hasOwn(blockedPlan, "plan_id"),
        device_action_before_resolution: deviceActionsBeforeResolution > 0,
        requires_user_resolution: conflict.requires_user_resolution,
      },
      user_choice: {
        selected_temperature_c: 25,
        memory_resolution_succeeded: memoryResolution.success,
        resulting_preference_status: resolvedPreference.status,
        resulting_preference_temperature_c: resolvedPreference.value,
      },
      replanned_scene: {
        scene_id: plan.scene_id,
        temperature_c: plannedTemperature,
        execution_performed_before_confirmation: plan.execution_performed,
        user_confirmation_required: plan.user_confirmation_required_before_execution,
      },
      second_confirmation: "模拟用户在看见完整方案后明确回复：执行吧",
      execution: {
        success: execution.success,
        execution_performed: execution.execution_performed,
        confirmation_verified: execution.confirmation_verified,
        plan_revalidated: execution.plan_revalidated,
        all_steps_verified: execution.verification?.every((entry) => entry.verified) === true,
        audit_entries_added: homeAssistant.getAuditLog().length - auditCountBeforeExecution,
      },
      note: "本演示验证本地工具链和 Mock 设备状态；模拟用户选择与确认，不代表真实 LLM 对话或真实 HA 联调。",
      storage: "临时测试目录；演示结束后删除，不写入家庭正式记忆",
    };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMockPreferenceConflictDemo()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
