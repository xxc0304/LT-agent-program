import { randomUUID } from "node:crypto";

import { Type } from "typebox";

import { SCENES } from "./scenes.js";

const DEFAULT_PLAN_TTL_MS = 10 * 60 * 1000;

export const SCENE_PLANNING_TOOL_DEFINITIONS = [
  {
    name: "plan_scene",
    description: "只读预览回家、睡眠或离家场景；在设备能力范围内，可把已确认的房间舒适温度偏好作为建议参数。不会执行设备动作。返回的确认口令只能在已向用户展示计划、并收到用户下一条明确确认后用于执行。",
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
    description: "在已向用户完整展示某个 plan_scene 结果、并收到用户随后发送的原样确认口令后，重新校验偏好和设备，再执行该次计划并回读审计。禁止在同一轮场景请求中自行补造确认口令；计划过期或变化时必须重新预览并再次询问。",
    inputSchema: Type.Object({
      plan_id: Type.String({ description: "plan_scene 返回的一次性计划 ID。" }),
      confirmation_phrase: Type.String({ description: "用户在看到该计划后，随后原样发送的确认口令。" }),
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
 * path. The confirmation phrase is a guard against accidental tool calls, not
 * cryptographic proof of human intent; the Agent Skill must require a distinct
 * user reply, and deployments needing stronger assurance should add a native
 * human-approval surface.
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
    const temperatureSteps = proposedSteps.filter((step) => step.action === "set_temperature");

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

    return {
      success: true,
      scene_id,
      scene_name: scene.name,
      execution_performed: false,
      user_confirmation_required_before_execution: true,
      steps: proposedSteps,
      temperature_adjustments: temperatureAdjustments,
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
      const confirmation_phrase = `确认执行方案 ${plan_id}`;
      pendingPlans.set(plan_id, {
        scene_id: plan.scene_id,
        day_type: params.day_type,
        steps: clone(plan.steps),
        temperature_adjustments: clone(plan.temperature_adjustments),
        confirmation_phrase,
        expires_at_ms,
      });

      return {
        ...plan,
        plan_id,
        confirmation_phrase,
        expires_at: new Date(expires_at_ms).toISOString(),
      };
    },

    async execute_scene_plan({ plan_id, confirmation_phrase } = {}) {
      removeExpiredPlans();
      const pending = pendingPlans.get(plan_id);
      if (!pending) {
        return toolFailure("PLAN_NOT_FOUND_OR_EXPIRED", "计划不存在、已过期或已经使用；请重新预览场景。");
      }
      if (confirmation_phrase !== pending.confirmation_phrase) {
        return toolFailure("CONFIRMATION_REQUIRED", "确认口令不匹配；未执行设备动作。请等待用户针对当前计划的明确确认。");
      }

      // Consume before revalidation/execution so retries cannot duplicate a
      // batch that may have partially reached Home Assistant.
      pendingPlans.delete(plan_id);

      const currentPlan = await buildPlan({ scene_id: pending.scene_id, day_type: pending.day_type });
      if (!currentPlan.success) {
        return toolFailure("PLAN_REVALIDATION_FAILED", "偏好或设备信息无法重新校验；未执行场景，请重新预览。", {
          cause: currentPlan.error?.code,
        });
      }
      if (comparablePlan(pending) !== comparablePlan(currentPlan)) {
        return toolFailure("PLAN_STALE", "预览后计划或设备条件发生变化；未执行场景，请重新预览并再次确认。", {
          current_steps: currentPlan.steps,
          current_temperature_adjustments: currentPlan.temperature_adjustments,
        });
      }

      const scene = SCENES[pending.scene_id];
      const configuredTemperature = scene.steps.find((step) => step.action === "set_temperature")
        ?.parameters?.temperature;
      const proposedTemperature = pending.steps.find((step) => step.action === "set_temperature")
        ?.parameters?.temperature;
      const planned_temperature_c = proposedTemperature !== configuredTemperature
        ? proposedTemperature
        : undefined;

      let result;
      try {
        result = await deviceRuntime.invoke("run_scene", {
          scene_id: pending.scene_id,
          planned_temperature_c,
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
