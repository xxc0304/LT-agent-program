import { randomUUID } from "node:crypto";

import { Type } from "typebox";

import { SCENES } from "./scenes.js";

const DEFAULT_PLAN_TTL_MS = 10 * 60 * 1000;

export const SCENE_PLANNING_TOOL_DEFINITIONS = [
  {
    name: "plan_scene",
    description: "只读预览回家、睡眠或离家场景；在设备在线且能力/范围已确认时，可把已确认的房间舒适温度或灯光亮度偏好作为建议参数。若偏好查询返回 conflict_review，必须停止计划、展示冲突值并用自然语言询问用户，不得沿用旧偏好或自行选值。不会执行设备动作。计划 ID 是工具内部关联值，不要要求用户输入；展示计划并询问后，等待用户下一条明确肯定回复。",
    inputSchema: Type.Object({
      scene_id: Type.Union([
        Type.Literal("home"),
        Type.Literal("sleep"),
        Type.Literal("away"),
      ]),
      day_type: Type.Optional(Type.Union([
        Type.Literal("weekday"),
        Type.Literal("weekend"),
      ])),
    }, { additionalProperties: false }),
  },
  {
    name: "execute_scene_plan",
    description: "仅当 Agent 已向用户完整展示当前计划，并在后续独立消息中理解到用户明确同意（例如‘执行吧’、‘按这个方案执行’）时调用。把工具内部 plan_id 与 user_confirmed:true 传入；绝不要要求用户输入 ID 或口令。执行前重新校验偏好和设备；计划过期或变化时必须重新预览并再次询问。",
    inputSchema: Type.Object({
      plan_id: Type.String({ description: "plan_scene 返回的一次性计划 ID。" }),
      user_confirmed: Type.Boolean({ description: "仅当用户看到当前完整计划后，在后续独立消息中明确肯定同意执行时为 true；否定、含糊、询问意见或最初场景请求均为 false。" }),
    }, { additionalProperties: false }),
  },
];

function clone(value) {
  return structuredClone(value);
}

function roomIdFromEntityId(deviceId) {
  const separator = deviceId.indexOf(".");
  return separator < 0 ? deviceId : deviceId.slice(separator + 1);
}

function temperatureRangeIssue(value, attributes = {}) {
  if (!Number.isFinite(attributes.min_temperature) || !Number.isFinite(attributes.max_temperature)) {
    return "DEVICE_RANGE_UNKNOWN";
  }
  if (value < attributes.min_temperature || value > attributes.max_temperature) {
    return "PREFERENCE_OUTSIDE_DEVICE_RANGE";
  }
  return null;
}

function comparablePlan(plan) {
  return JSON.stringify({
    scene_id: plan.scene_id,
    steps: plan.steps,
    temperature_adjustments: plan.temperature_adjustments,
    brightness_adjustments: plan.brightness_adjustments,
  });
}

function toolFailure(code, message, details = {}) {
  return {
    success: false,
    execution_performed: false,
    error: { code, message, ...details },
  };
}

/**
 * Read-only scene planning plus a short-lived, one-time confirmed execution
 * path. user_confirmed is an Agent-interpreted conversation signal, not
 * cryptographic proof of human intent; the Agent Skill must require a distinct
 * affirmative user reply, and deployments needing stronger assurance should
 * add a native human-approval surface.
 */
export function createScenePlanningTools({
  deviceRuntime,
  getHouseholdPreference,
  now = () => Date.now(),
  createPlanId = randomUUID,
  planTtlMs = DEFAULT_PLAN_TTL_MS,
} = {}) {
  if (!deviceRuntime || typeof deviceRuntime.invoke !== "function") {
    throw new Error("scene planner 需要一个可调用 invoke() 的设备运行时");
  }
  if (typeof getHouseholdPreference !== "function") {
    throw new Error("scene planner 需要已确认偏好的只读查询函数");
  }

  const pendingPlans = new Map();

  async function buildPlan({ scene_id, day_type } = {}) {
    const scene = SCENES[scene_id];
    if (!scene) {
      return toolFailure("SCENE_NOT_FOUND", `未找到场景：${scene_id ?? "未提供"}`, {
        available_scenes: Object.keys(SCENES),
      });
    }

    const proposedSteps = clone(scene.steps);
    const temperatureAdjustments = [];
    const brightnessAdjustments = [];
    const preferenceConflicts = [];
    const temperatureSteps = proposedSteps.filter((step) => step.action === "set_temperature");
    const brightnessSteps = proposedSteps.filter((step) => step.action === "set_brightness");

    for (const step of temperatureSteps) {
      const room_id = roomIdFromEntityId(step.device_id);
      const configuredTemperature = step.parameters?.temperature;
      let preference;
      try {
        preference = await getHouseholdPreference({
          memory_type: "comfort_temperature_c",
          room_id,
          ...(day_type ? { day_type } : {}),
        });
      } catch {
        return toolFailure("PREFERENCE_READ_FAILED", "无法安全读取已确认的家庭温度偏好；未生成个性化建议。");
      }

      if (!preference) {
        temperatureAdjustments.push({
          device_id: step.device_id,
          room_id,
          status: "NO_CONFIRMED_PREFERENCE",
          configured_temperature_c: configuredTemperature,
        });
        continue;
      }
      if (preference.status === "conflict_review") {
        preferenceConflicts.push({
          device_id: step.device_id,
          room_id,
          memory_type: "comfort_temperature_c",
          conflict_scopes: clone(preference.conflict_scopes ?? []),
          candidates: clone(preference.candidates ?? []),
        });
        temperatureAdjustments.push({
          device_id: step.device_id,
          room_id,
          status: "PREFERENCE_CONFLICT",
          configured_temperature_c: configuredTemperature,
          applied_to_proposal: false,
        });
        continue;
      }
      if (preference.status !== "confirmed"
        || preference.memory_type !== "comfort_temperature_c"
        || !Number.isFinite(preference.value)) {
        temperatureAdjustments.push({
          device_id: step.device_id,
          room_id,
          status: "PREFERENCE_NOT_APPLICABLE",
          configured_temperature_c: configuredTemperature,
        });
        continue;
      }

      let state;
      try {
        state = await deviceRuntime.invoke("get_state", { device_id: step.device_id });
      } catch {
        state = null;
      }
      if (!state?.success || !state.device?.available) {
        temperatureAdjustments.push({
          device_id: step.device_id,
          room_id,
          status: state?.success ? "DEVICE_UNAVAILABLE" : "DEVICE_STATE_UNAVAILABLE",
          configured_temperature_c: configuredTemperature,
          suggested_temperature_c: preference.value,
          applied_to_proposal: false,
        });
        continue;
      }

      const rangeIssue = temperatureRangeIssue(preference.value, state.device.attributes);
      if (rangeIssue) {
        temperatureAdjustments.push({
          device_id: step.device_id,
          room_id,
          status: rangeIssue,
          configured_temperature_c: configuredTemperature,
          suggested_temperature_c: preference.value,
          minimum_temperature_c: state.device.attributes?.min_temperature ?? null,
          maximum_temperature_c: state.device.attributes?.max_temperature ?? null,
          applied_to_proposal: false,
        });
        continue;
      }

      step.parameters = { ...step.parameters, temperature: preference.value };
      temperatureAdjustments.push({
        device_id: step.device_id,
        room_id,
        status: "SUGGESTED",
        configured_temperature_c: configuredTemperature,
        suggested_temperature_c: preference.value,
        changed_from_configured: preference.value !== configuredTemperature,
        source: "confirmed_household_preference",
        applied_to_proposal: true,
        confirmation_required_before_execution: true,
      });
    }

    for (const step of brightnessSteps) {
      const room_id = roomIdFromEntityId(step.device_id);
      const configuredBrightness = step.parameters?.brightness;
      let preference;
      try {
        preference = await getHouseholdPreference({
          memory_type: "comfort_brightness_pct",
          room_id,
          ...(day_type ? { day_type } : {}),
        });
      } catch {
        return toolFailure("PREFERENCE_READ_FAILED", "无法安全读取已确认的家庭灯光偏好；未生成个性化建议。");
      }

      if (!preference) {
        brightnessAdjustments.push({
          device_id: step.device_id,
          room_id,
          status: "NO_CONFIRMED_PREFERENCE",
          configured_brightness_pct: configuredBrightness,
        });
        continue;
      }
      if (preference.status === "conflict_review") {
        preferenceConflicts.push({
          device_id: step.device_id,
          room_id,
          memory_type: "comfort_brightness_pct",
          conflict_scopes: clone(preference.conflict_scopes ?? []),
          candidates: clone(preference.candidates ?? []),
        });
        brightnessAdjustments.push({
          device_id: step.device_id,
          room_id,
          status: "PREFERENCE_CONFLICT",
          configured_brightness_pct: configuredBrightness,
          applied_to_proposal: false,
        });
        continue;
      }
      if (preference.status !== "confirmed"
        || preference.memory_type !== "comfort_brightness_pct"
        || !Number.isInteger(preference.value)
        || preference.value < 1
        || preference.value > 100) {
        brightnessAdjustments.push({
          device_id: step.device_id,
          room_id,
          status: "PREFERENCE_NOT_APPLICABLE",
          configured_brightness_pct: configuredBrightness,
          applied_to_proposal: false,
        });
        continue;
      }

      let state;
      try {
        state = await deviceRuntime.invoke("get_state", { device_id: step.device_id });
      } catch {
        state = null;
      }
      if (!state?.success || !state.device?.available) {
        brightnessAdjustments.push({
          device_id: step.device_id,
          room_id,
          status: state?.success ? "DEVICE_UNAVAILABLE" : "DEVICE_STATE_UNAVAILABLE",
          configured_brightness_pct: configuredBrightness,
          suggested_brightness_pct: preference.value,
          applied_to_proposal: false,
        });
        continue;
      }

      const capability = state.device.capabilities?.actions?.set_brightness;
      const hasObservedBrightness = state.device.domain === "light"
        && Number.isFinite(state.device.attributes?.brightness);
      if (capability?.supported === false) {
        brightnessAdjustments.push({
          device_id: step.device_id,
          room_id,
          status: "DEVICE_ACTION_UNSUPPORTED",
          configured_brightness_pct: configuredBrightness,
          suggested_brightness_pct: preference.value,
          applied_to_proposal: false,
        });
        continue;
      }
      if (capability?.supported !== true && !hasObservedBrightness) {
        brightnessAdjustments.push({
          device_id: step.device_id,
          room_id,
          status: "DEVICE_CAPABILITY_UNKNOWN",
          configured_brightness_pct: configuredBrightness,
          suggested_brightness_pct: preference.value,
          applied_to_proposal: false,
        });
        continue;
      }

      step.parameters = { ...step.parameters, brightness: preference.value };
      brightnessAdjustments.push({
        device_id: step.device_id,
        room_id,
        status: "SUGGESTED",
        configured_brightness_pct: configuredBrightness,
        suggested_brightness_pct: preference.value,
        changed_from_configured: preference.value !== configuredBrightness,
        source: "confirmed_household_preference",
        applied_to_proposal: true,
        confirmation_required_before_execution: true,
      });
    }

    if (preferenceConflicts.length) {
      return toolFailure("PREFERENCE_CONFLICT", "家庭偏好存在未解决冲突；未生成场景计划，也未执行设备动作。请先向用户展示冲突值并询问采用哪一个，记忆确认完成后再重新规划。", {
        conflicts: preferenceConflicts,
        temperature_adjustments: temperatureAdjustments,
        brightness_adjustments: brightnessAdjustments,
        requires_user_resolution: true,
      });
    }

    return {
      success: true,
      scene_id,
      scene_name: scene.name,
      execution_performed: false,
      user_confirmation_required_before_execution: true,
      steps: proposedSteps,
      temperature_adjustments: temperatureAdjustments,
      brightness_adjustments: brightnessAdjustments,
      note: "这是只读建议，不代表设备已执行；执行前必须向用户展示目标值并取得单独确认。",
    };
  }

  function removeExpiredPlans() {
    const currentTime = now();
    for (const [planId, plan] of pendingPlans) {
      if (currentTime >= plan.expires_at_ms) pendingPlans.delete(planId);
    }
  }

  return {
    async plan_scene(params = {}) {
      const plan = await buildPlan(params);
      if (!plan.success) return plan;

      removeExpiredPlans();
      const plan_id = createPlanId();
      const expires_at_ms = now() + planTtlMs;
      pendingPlans.set(plan_id, {
        scene_id: plan.scene_id,
        day_type: params.day_type,
        steps: clone(plan.steps),
        temperature_adjustments: clone(plan.temperature_adjustments),
        brightness_adjustments: clone(plan.brightness_adjustments),
        expires_at_ms,
      });

      return {
        ...plan,
        plan_id,
        expires_at: new Date(expires_at_ms).toISOString(),
      };
    },

    async execute_scene_plan({ plan_id, user_confirmed } = {}) {
      removeExpiredPlans();
      const pending = pendingPlans.get(plan_id);
      if (!pending) {
        return toolFailure("PLAN_NOT_FOUND_OR_EXPIRED", "计划不存在、已过期或已经使用；请重新预览场景。");
      }
      if (user_confirmed !== true) {
        return toolFailure("CONFIRMATION_REQUIRED", "还没有收到针对当前计划的明确肯定确认；未执行设备动作。请用自然语言询问用户是否按刚才的方案执行。");
      }

      // Consume before revalidation/execution so retries cannot duplicate a
      // batch that may have partially reached Home Assistant.
      pendingPlans.delete(plan_id);

      const currentPlan = await buildPlan({ scene_id: pending.scene_id, day_type: pending.day_type });
      if (!currentPlan.success) {
        if (currentPlan.error?.code === "PREFERENCE_CONFLICT") {
          return toolFailure("PREFERENCE_CONFLICT", "预览后发现家庭偏好出现冲突；本次未执行。请向用户展示冲突值、确认选择后重新规划并再次确认。", {
            conflicts: currentPlan.error.conflicts ?? [],
            requires_user_resolution: true,
          });
        }
        return toolFailure("PLAN_REVALIDATION_FAILED", "偏好或设备信息无法重新校验；未执行场景，请重新预览。", {
          cause: currentPlan.error?.code,
        });
      }
      if (comparablePlan(pending) !== comparablePlan(currentPlan)) {
        return toolFailure("PLAN_STALE", "预览后计划或设备条件发生变化；未执行场景，请重新预览并再次确认。", {
          current_steps: currentPlan.steps,
          current_temperature_adjustments: currentPlan.temperature_adjustments,
          current_brightness_adjustments: currentPlan.brightness_adjustments,
        });
      }

      const scene = SCENES[pending.scene_id];
      const configuredTemperature = scene.steps.find((step) => step.action === "set_temperature")
        ?.parameters?.temperature;
      const proposedTemperature = pending.steps.find((step) => step.action === "set_temperature")
        ?.parameters?.temperature;
      const configuredBrightness = scene.steps.find((step) => step.action === "set_brightness")
        ?.parameters?.brightness;
      const proposedBrightness = pending.steps.find((step) => step.action === "set_brightness")
        ?.parameters?.brightness;
      const planned_temperature_c = proposedTemperature !== configuredTemperature
        ? proposedTemperature
        : undefined;
      const planned_brightness_pct = proposedBrightness !== configuredBrightness
        ? proposedBrightness
        : undefined;

      let result;
      try {
        result = await deviceRuntime.invoke("run_scene", {
          scene_id: pending.scene_id,
          planned_temperature_c,
          planned_brightness_pct,
          task_id: plan_id,
          trace_id: plan_id,
        });
      } catch {
        return {
          success: false,
          plan_id,
          confirmation_verified: true,
          plan_revalidated: true,
          execution_performed: true,
          error: {
            code: "SCENE_EXECUTION_RESULT_UNKNOWN",
            message: "执行调用发生异常，设备状态可能已经改变；请先查询设备状态，不要自动重试场景。",
          },
        };
      }

      return {
        ...result,
        plan_id,
        confirmation_verified: true,
        plan_revalidated: true,
        execution_performed: (result?.executions?.length ?? 0) > 0,
      };
    },
  };
}
