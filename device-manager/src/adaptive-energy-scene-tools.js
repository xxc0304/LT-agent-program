import { randomUUID } from "node:crypto";

import { Type } from "typebox";
import { ScenarioAdaptationStore, SCENARIO_FEEDBACK_TYPES } from "./scenario-adaptation-store.js";

const DEFAULT_PLAN_TTL_MS = 10 * 60 * 1000;
const ENERGY_SCENE_DOMAINS = new Set(["light", "switch"]);

export const ADAPTIVE_ENERGY_SCENE_TOOL_DEFINITIONS = [
  {
    name: "analyze_room_energy_adaptation",
    description: "刷新指定已确认房间的设备清单，分析当前最小节能场景可执行范围、缺口和下一步完善建议，并应用用户此前明确保存的设备偏好；只读，不控制设备。",
    inputSchema: Type.Object({
      area_id: Type.String({ minLength: 1, description: "家庭清单中用户确认过的房间标识。" }),
    }, { additionalProperties: false }),
  },
  {
    name: "plan_room_energy_saving",
    description: "根据最新 HA 扫描和用户明确保存的房间设备偏好，为一个用户已确认的房间生成最小节能计划：仅考虑已批准、已明确授权节能、在线且明确支持 turn_off 的灯和开关/插座；用户排除的设备不会加入，偏好设备仅在满足全部安全条件时优先展示。设备不齐时生成可执行子集并说明跳过原因；只读预览，不控制设备。执行前必须向用户展示计划并在后续独立消息中取得明确同意。",
    inputSchema: Type.Object({
      area_id: Type.String({ minLength: 1, description: "家庭清单中用户确认过的房间标识。" }),
    }, { additionalProperties: false }),
  },
  {
    name: "execute_room_energy_saving_plan",
    description: "仅在用户已看见 plan_room_energy_saving 的完整计划，并于后续独立消息明确同意后调用。执行前重新扫描 HA；设备、状态、房间授权或能力与预览不一致时废弃旧计划并要求重新预览。",
    inputSchema: Type.Object({
      plan_id: Type.String({ minLength: 1, description: "工具内部计划 ID，不要展示或要求用户输入。" }),
      user_confirmed: Type.Boolean({ description: "仅当用户看过当前计划后，明确同意执行时为 true。" }),
    }, { additionalProperties: false }),
  },
  {
    name: "record_room_energy_scenario_feedback",
    description: "仅在用户明确评价当前房间节能方案或明确要求调整设备偏好后调用。可记录方案有帮助/效果不佳，或为一台已发现且属于该确认房间的设备设为优先、排除、重置偏好。设备偏好不会绕过登记、节能授权、在线状态或动作能力检查；不保存自由文本对话。",
    inputSchema: Type.Object({
      area_id: Type.String({ minLength: 1 }),
      feedback_type: Type.Union(SCENARIO_FEEDBACK_TYPES.map((value) => Type.Literal(value))),
      device_id: Type.Optional(Type.String({ minLength: 1 })),
      user_explicit_feedback: Type.Boolean({ description: "只有用户刚刚明确表达此反馈或设备偏好时才为 true。" }),
    }, { additionalProperties: false }),
  },
  {
    name: "get_room_energy_adaptation_report",
    description: "查看一个房间已明确保存的个性化设备偏好、方案反馈计数和执行回读统计。没有电量传感器基线时只报告设备动作验证率，不估算节能度数或百分比。",
    inputSchema: Type.Object({
      area_id: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
  },
];

function failure(code, message, details = {}) {
  return {
    success: false,
    execution_performed: false,
    error: { code, message, ...details },
  };
}

function normalizeArea(value) {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : "";
}

function comparablePlan(plan) {
  return JSON.stringify({
    area_id: plan.area_id,
    steps: plan.steps,
    already_satisfied: plan.already_satisfied,
    omitted_devices: plan.omitted_devices,
    personalization: plan.personalization,
  });
}

function omission(device, reason, detail) {
  return {
    device_id: device.device_id,
    name: device.name,
    domain: device.domain,
    reason,
    detail,
  };
}

/**
 * Plan and execute a smallest safe room-level energy action set using the
 * current household inventory. This deliberately does not infer equivalent
 * actions: only explicitly opted-in, supported light/switch turn_off actions
 * are candidates.
 */
export function createAdaptiveEnergySceneTools({
  deviceRuntime,
  deviceInventory,
  scenarioAdaptationStore = new ScenarioAdaptationStore(),
  now = () => Date.now(),
  createPlanId = randomUUID,
  planTtlMs = DEFAULT_PLAN_TTL_MS,
} = {}) {
  if (!deviceRuntime || typeof deviceRuntime.invoke !== "function") {
    throw new Error("自适应节能场景需要可调用 invoke() 的设备运行时");
  }
  if (!deviceInventory || typeof deviceInventory.discover !== "function" || typeof deviceInventory.list !== "function") {
    throw new Error("自适应节能场景需要 DeviceInventory 实例");
  }
  if (!scenarioAdaptationStore || typeof scenarioAdaptationStore.getArea !== "function"
    || typeof scenarioAdaptationStore.recordFeedback !== "function"
    || typeof scenarioAdaptationStore.recordExecution !== "function") {
    throw new Error("自适应节能场景需要 ScenarioAdaptationStore 实例");
  }

  const pendingPlans = new Map();

  async function buildPlan(areaId) {
    const normalizedArea = normalizeArea(areaId);
    if (!normalizedArea) return failure("INVALID_AREA", "area_id 必须是非空房间标识");

    let scan;
    try {
      scan = await deviceInventory.discover();
    } catch {
      return failure("DEVICE_DISCOVERY_FAILED", "无法刷新家庭设备清单；没有生成计划");
    }
    if (!scan?.success) {
      return failure(scan?.error?.code ?? "DEVICE_DISCOVERY_FAILED", scan?.error?.message ?? "无法刷新家庭设备清单；没有生成计划");
    }

    const roomDevices = scan.devices.filter((device) => normalizeArea(device.area_id) === normalizedArea);
    const confirmedRoomDevices = roomDevices.filter((device) => device.area_confirmed === true);
    if (confirmedRoomDevices.length === 0) {
      const knownRooms = [...new Set(scan.devices
        .filter((device) => device.area_confirmed === true && device.area_id)
        .map((device) => device.area_id))];
      return failure("ROOM_NOT_CONFIRMED", "该房间尚未在家庭设备清单中由用户确认；先核对设备房间，再生成节能方案。", {
        area_id: normalizedArea,
        confirmed_area_ids: knownRooms,
      });
    }

    const storedProfile = scenarioAdaptationStore.getArea(normalizedArea);
    if (!storedProfile.success) return failure(storedProfile.error.code, storedProfile.error.message);
    const profile = storedProfile.profile;
    const excludedDeviceIds = new Set(profile.excluded_device_ids);
    const preferredDeviceIds = new Set(profile.preferred_device_ids);

    const steps = [];
    const alreadySatisfied = [];
    const omittedDevices = [];
    for (const device of roomDevices) {
      if (device.area_confirmed !== true) {
        omittedDevices.push(omission(device, "ROOM_NOT_CONFIRMED", "设备房间信息未经用户确认"));
        continue;
      }
      if (excludedDeviceIds.has(device.device_id)) {
        omittedDevices.push(omission(device, "USER_PERSONALIZATION_EXCLUDED", "用户明确要求此设备不参与该房间节能方案"));
        continue;
      }
      if (device.approval_status !== "approved") {
        omittedDevices.push(omission(device, "DEVICE_NOT_APPROVED", "设备尚未由用户核对并批准"));
        continue;
      }
      if (device.energy_opt_in !== true) {
        omittedDevices.push(omission(device, "ENERGY_PERMISSION_REQUIRED", "用户尚未明确授权该设备参与节能"));
        continue;
      }
      if (!ENERGY_SCENE_DOMAINS.has(device.domain)) {
        omittedDevices.push(omission(device, "ACTION_NOT_IN_MINIMAL_SCENE", "当前最小节能场景只处理灯和开关/插座，不推断空调、窗帘等设备的替代动作"));
        continue;
      }
      if (device.available !== true) {
        omittedDevices.push(omission(device, "DEVICE_UNAVAILABLE", "设备当前离线或状态不可用"));
        continue;
      }
      const support = device.current_capabilities?.actions?.turn_off?.supported;
      if (support !== true) {
        omittedDevices.push(omission(
          device,
          support === false ? "ACTION_UNSUPPORTED" : "CAPABILITY_UNKNOWN",
          support === false ? "HA 明确报告不支持 turn_off" : "HA 未提供 turn_off 能力证据；为避免猜测，本次不下发动作",
        ));
        continue;
      }
      if (device.current_state === "off") {
        alreadySatisfied.push({ device_id: device.device_id, name: device.name, domain: device.domain, state: "off" });
        continue;
      }
      if (device.current_state !== "on") {
        omittedDevices.push(omission(device, "DEVICE_STATE_UNKNOWN", `当前状态为 ${device.current_state ?? "未知"}，不是可确认的 on`));
        continue;
      }
      steps.push({
        device_id: device.device_id,
        name: device.name,
        domain: device.domain,
        ...(preferredDeviceIds.has(device.device_id) ? { user_preference: "preferred" } : {}),
        action: "turn_off",
        expected_state: "off",
        observed_state: device.current_state,
        capability_evidence: device.current_capabilities.actions.turn_off.evidence ?? null,
      });
    }

    steps.sort((left, right) => Number(right.user_preference === "preferred") - Number(left.user_preference === "preferred"));
    const requestedPreferredDevices = profile.preferred_device_ids.map((deviceId) => {
      const device = roomDevices.find((item) => item.device_id === deviceId);
      const planned = steps.some((step) => step.device_id === deviceId);
      const isAlreadySatisfied = alreadySatisfied.some((item) => item.device_id === deviceId);
      return {
        device_id: deviceId,
        status: planned ? "eligible_and_prioritized" : isAlreadySatisfied ? "already_satisfied" : "preference_saved_but_not_eligible",
        ...(device ? { current_reason: omittedDevices.find((item) => item.device_id === deviceId)?.reason ?? null } : { current_reason: "DEVICE_NOT_IN_CURRENT_ROOM_SCAN" }),
      };
    });

    return {
      success: true,
      scenario_id: "room_energy_saving_minimal",
      scenario_name: "房间最小节能",
      area_id: normalizedArea,
      steps,
      already_satisfied: alreadySatisfied,
      omitted_devices: omittedDevices,
      personalization: {
        preferred_device_ids: profile.preferred_device_ids,
        excluded_device_ids: profile.excluded_device_ids,
        preferred_devices: requestedPreferredDevices,
        feedback_counts: profile.feedback_counts,
      },
      plan_available: steps.length > 0,
      execution_performed: false,
      user_confirmation_required_before_execution: steps.length > 0,
      summary: {
        candidate_count: roomDevices.length,
        action_count: steps.length,
        already_satisfied_count: alreadySatisfied.length,
        omitted_count: omittedDevices.length,
      },
      note: "只按当前 HA 能力和用户授权生成最小动作子集；不会猜测设备等效能力，也不会自动执行。",
    };
  }

  function removeExpiredPlans() {
    const current = now();
    for (const [planId, plan] of pendingPlans) {
      if (current >= plan.expires_at_ms) pendingPlans.delete(planId);
    }
  }

  function recommendationsFor(plan) {
    const recommendationByReason = {
      DEVICE_NOT_APPROVED: { action: "review_device", priority: "user_action", reason: "先核对设备名称/房间，再决定是否登记批准。" },
      ROOM_NOT_CONFIRMED: { action: "confirm_room", priority: "user_action", reason: "设备房间尚未由用户确认。" },
      ENERGY_PERMISSION_REQUIRED: { action: "review_energy_permission", priority: "user_action", reason: "如希望该设备参与节能，需要用户单独明确授权；不授权也可保留现状。" },
      DEVICE_UNAVAILABLE: { action: "check_availability", priority: "observation", reason: "设备离线或状态不可用，先检查 HA/设备连通性，不对离线设备下发动作。" },
      CAPABILITY_UNKNOWN: { action: "verify_capability", priority: "integration_review", reason: "HA 未提供足够的动作能力证据；核查集成/实体暴露后再重新扫描。" },
      ACTION_UNSUPPORTED: { action: "review_device_mapping", priority: "integration_review", reason: "HA 明确报告当前动作不支持；不能自动改用未经确认的等效动作。" },
      ACTION_NOT_IN_MINIMAL_SCENE: { action: "define_safe_mapping", priority: "design_review", reason: "设备类型不在当前最小场景范围内；须先明确设备角色、等效能力和安全约束。" },
      DEVICE_STATE_UNKNOWN: { action: "refresh_device_state", priority: "observation", reason: "当前状态不明确；刷新状态后重新分析。" },
      USER_PERSONALIZATION_EXCLUDED: { action: "none", priority: "user_preference", reason: "按用户明确偏好排除，除非用户主动更改偏好，否则无需处理。" },
    };
    const seen = new Set();
    const recommendations = [];
    for (const item of plan.omitted_devices) {
      const recommendation = recommendationByReason[item.reason];
      if (!recommendation || seen.has(item.reason)) continue;
      seen.add(item.reason);
      recommendations.push({ code: item.reason, ...recommendation });
    }
    if (plan.personalization.feedback_counts.not_effective > 0) {
      recommendations.push({
        code: "ENERGY_EFFECT_NOT_MEASURED",
        action: "add_energy_measurement_baseline",
        priority: "measurement",
        reason: "已有用户反馈认为效果不佳；目前只有设备动作回读，没有电量/功率基线。接入合适的能耗计量并采集前后数据后，才能判断节能效果。",
      });
    }
    if (recommendations.length === 0) {
      recommendations.push({
        code: "SCENARIO_CURRENTLY_COVERED",
        action: "collect_explicit_feedback",
        priority: "continuous_improvement",
        reason: "当前房间设备均符合本最小场景条件；实际使用后可明确反馈有帮助、效果不佳或调整某台设备偏好。",
      });
    }
    return recommendations;
  }

  function recordExecution(pending, results, { extraAttempted = 0, interrupted = false } = {}) {
    const attempted = results.length + extraAttempted;
    if (attempted === 0) return false;
    const verified = results.filter((item) => item.success && item.verified).length;
    const saved = scenarioAdaptationStore.recordExecution({
      area_id: pending.area_id,
      attempted_actions: attempted,
      verified_actions: verified,
      failed_actions: attempted - verified,
      interrupted,
    });
    return saved.success;
  }

  return {
    async analyze_room_energy_adaptation({ area_id } = {}) {
      const plan = await buildPlan(area_id);
      if (!plan.success) return plan;
      const actionableCount = plan.steps.length + plan.already_satisfied.length;
      const excludedCount = plan.omitted_devices.filter((item) => item.reason === "USER_PERSONALIZATION_EXCLUDED").length;
      const assessedCount = Math.max(0, plan.summary.candidate_count - excludedCount);
      const readiness = actionableCount === 0
        ? "blocked"
        : plan.omitted_devices.some((item) => item.reason !== "USER_PERSONALIZATION_EXCLUDED")
          ? "partial"
          : "ready";
      return {
        ...plan,
        analysis_type: "room_energy_scenario_gap_analysis",
        readiness,
        coverage: {
          assessed_device_count: assessedCount,
          actionable_device_count: actionableCount,
          actionable_ratio: assessedCount === 0 ? null : Number((actionableCount / assessedCount).toFixed(3)),
          preferred_count: plan.personalization.preferred_device_ids.length,
          excluded_by_user_count: excludedCount,
        },
        improvement_suggestions: recommendationsFor(plan),
        note: "这是基于当前 HA 清单和显式用户偏好的差距分析；不推断未接入设备、不替用户授权，也不自动控制。",
      };
    },

    async plan_room_energy_saving({ area_id } = {}) {
      const plan = await buildPlan(area_id);
      if (!plan.success || !plan.plan_available) return plan;

      removeExpiredPlans();
      const planId = createPlanId();
      const expiresAtMs = now() + planTtlMs;
      pendingPlans.set(planId, {
        area_id: plan.area_id,
        steps: structuredClone(plan.steps),
        already_satisfied: structuredClone(plan.already_satisfied),
        omitted_devices: structuredClone(plan.omitted_devices),
        personalization: structuredClone(plan.personalization),
        expires_at_ms: expiresAtMs,
      });
      return { ...plan, plan_id: planId, expires_at: new Date(expiresAtMs).toISOString() };
    },

    async execute_room_energy_saving_plan({ plan_id, user_confirmed } = {}) {
      removeExpiredPlans();
      const pending = pendingPlans.get(plan_id);
      if (!pending) return failure("PLAN_NOT_FOUND_OR_EXPIRED", "计划不存在、已过期或已经使用；请重新预览。", { plan_id });
      if (user_confirmed !== true) {
        return failure("CONFIRMATION_REQUIRED", "还没有收到用户对当前完整计划的明确同意；没有执行设备动作。", { plan_id });
      }

      // Consume the plan before execution to avoid accidental replay after an
      // uncertain network response.
      pendingPlans.delete(plan_id);
      const current = await buildPlan(pending.area_id);
      if (!current.success) {
        return failure("PLAN_REVALIDATION_FAILED", "设备清单无法重新扫描；没有执行场景。请稍后重新预览。", {
          cause: current.error?.code,
        });
      }
      if (comparablePlan(pending) !== comparablePlan(current)) {
        return failure("PLAN_STALE", "预览后设备状态、授权或能力发生变化；旧计划已作废，请重新预览并再次确认。", {
          current_plan: current,
        });
      }

      const results = [];
      for (const step of pending.steps) {
        let latestScan;
        try {
          latestScan = await deviceInventory.discover();
        } catch {
          latestScan = null;
        }
        const latestDevice = latestScan?.success
          ? latestScan.devices.find((device) => device.device_id === step.device_id)
          : null;
        const stillAuthorized = latestDevice
          && latestDevice.approval_status === "approved"
          && latestDevice.energy_opt_in === true
          && latestDevice.area_confirmed === true
          && normalizeArea(latestDevice.area_id) === pending.area_id
          && latestDevice.available === true
          && latestDevice.current_state === "on"
          && latestDevice.current_capabilities?.actions?.turn_off?.supported === true;
        if (!stillAuthorized) {
          const evaluationRecorded = recordExecution(pending, results, { interrupted: true });
          return {
            success: false,
            plan_id,
            execution_performed: results.some((item) => item.success),
            partial_execution: results.some((item) => item.success),
            results,
            evaluation_recorded: evaluationRecorded,
            error: {
              code: "PLAN_STALE",
              message: "逐项执行前发现设备状态、能力或节能授权已变化；停止后续动作。请重新扫描并预览方案。",
              device_id: step.device_id,
              cause: latestScan?.error?.code ?? null,
            },
          };
        }
        let result;
        try {
          result = await deviceRuntime.invoke("control_device", {
            device_id: step.device_id,
            action: step.action,
            task_id: plan_id,
            trace_id: plan_id,
          });
        } catch {
          const evaluationRecorded = recordExecution(pending, results, { extraAttempted: 1, interrupted: true });
          return {
            success: false,
            plan_id,
            execution_performed: true,
            partial_execution: true,
            results,
            evaluation_recorded: evaluationRecorded,
            error: {
              code: "SCENE_EXECUTION_RESULT_UNKNOWN",
              message: `控制 ${step.name} 时调用异常；设备状态可能已改变。先查询状态，不要自动重试。`,
              device_id: step.device_id,
            },
          };
        }
        results.push({
          device_id: step.device_id,
          name: step.name,
          success: result?.success === true,
          verified: result?.verified === true,
          result,
        });
        if (result?.success !== true || result?.verified !== true) {
          const evaluationRecorded = recordExecution(pending, results, { interrupted: true });
          return {
            success: false,
            plan_id,
            execution_performed: true,
            partial_execution: results.some((item) => item.success)
              || results.length < pending.steps.length,
            results,
            evaluation_recorded: evaluationRecorded,
            error: {
              code: result?.error?.code ?? "ACTION_NOT_VERIFIED",
              message: "执行中有设备失败或状态回读未验证；不要盲目重试。请先查看逐项结果和设备当前状态。",
              device_id: step.device_id,
            },
          };
        }
      }

      const evaluationRecorded = recordExecution(pending, results);
      return {
        success: true,
        plan_id,
        scenario_id: "room_energy_saving_minimal",
        area_id: pending.area_id,
        execution_performed: results.length > 0,
        partial_execution: false,
        results,
        verification: results.map(({ device_id, name, verified }) => ({ device_id, name, verified })),
        evaluation_recorded: evaluationRecorded,
      };
    },

    async record_room_energy_scenario_feedback({ area_id, feedback_type, device_id, user_explicit_feedback } = {}) {
      if (user_explicit_feedback !== true) {
        return failure("EXPLICIT_FEEDBACK_REQUIRED", "只有用户明确表达的评价或设备偏好才会记录；未保存任何内容。");
      }
      if (!SCENARIO_FEEDBACK_TYPES.includes(feedback_type)) {
        return failure("INVALID_FEEDBACK_TYPE", "不支持的场景反馈类型。");
      }
      const normalizedArea = normalizeArea(area_id);
      if (!normalizedArea) return failure("INVALID_AREA", "area_id 必须是非空房间标识");
      const deviceFeedback = ["prefer_device", "exclude_device", "reset_device_preference"].includes(feedback_type);
      let refreshedScan;
      let targetDevice;
      try {
        refreshedScan = await deviceInventory.discover();
      } catch {
        return failure("DEVICE_DISCOVERY_FAILED", "无法刷新设备清单；未保存场景反馈");
      }
      if (!refreshedScan?.success) return failure("DEVICE_DISCOVERY_FAILED", "无法刷新设备清单；未保存场景反馈");
      const confirmedRoomExists = refreshedScan.devices.some((device) => device.area_confirmed === true
        && normalizeArea(device.area_id) === normalizedArea);
      if (!confirmedRoomExists) return failure("ROOM_NOT_CONFIRMED", "该房间尚无用户确认的设备；未保存场景反馈");
      if (deviceFeedback) {
        if (typeof device_id !== "string" || !device_id.trim()) return failure("DEVICE_ID_REQUIRED", "设备偏好反馈必须提供 device_id");
        targetDevice = refreshedScan.devices.find((device) => device.device_id === device_id);
        if (!targetDevice) return failure("DEVICE_NOT_IN_INVENTORY", "该设备不在当前 HA 清单中；未保存设备偏好");
        if (targetDevice.area_confirmed !== true || normalizeArea(targetDevice.area_id) !== normalizedArea) {
          return failure("DEVICE_ROOM_NOT_CONFIRMED", "必须先由用户确认该设备属于此房间；未保存设备偏好");
        }
      } else if (device_id !== undefined) {
        return failure("DEVICE_ID_NOT_APPLICABLE", "此类反馈不应绑定设备");
      }
      const saved = scenarioAdaptationStore.recordFeedback({
        area_id: normalizedArea,
        feedback_type,
        device_id,
      });
      if (!saved.success) return failure(saved.error.code, saved.error.message);
      const preferenceStillNeedsEligibility = feedback_type === "prefer_device"
        ? targetDevice.approval_status !== "approved"
          || targetDevice.energy_opt_in !== true
          || !ENERGY_SCENE_DOMAINS.has(targetDevice.domain)
          || targetDevice.available !== true
          || targetDevice.capabilities?.actions?.turn_off?.supported !== true
        : false;
      return {
        success: true,
        area_id: normalizedArea,
        feedback_type,
        device_id: device_id ?? null,
        preference_saved: deviceFeedback,
        preference_effect: feedback_type === "exclude_device"
          ? "future_plans_will_exclude_device"
          : feedback_type === "prefer_device"
            ? "future_plans_prioritize_only_if_all_safety_checks_pass"
            : feedback_type === "reset_device_preference"
              ? "device_returns_to_default_eligibility_rules"
              : "feedback_count_recorded_without_automatic_rule_change",
        device_not_yet_eligible: preferenceStillNeedsEligibility,
        note: "只记录了本次明确的结构化反馈，不保存原始对话；偏好不能绕过设备登记、房间确认、节能授权、在线状态和能力证据。",
      };
    },

    get_room_energy_adaptation_report({ area_id } = {}) {
      const stored = scenarioAdaptationStore.getArea(area_id);
      if (!stored.success) return failure(stored.error.code, stored.error.message);
      const { profile } = stored;
      const metrics = profile.execution_metrics;
      const verificationRate = metrics.attempted_actions === 0
        ? null
        : Number((metrics.verified_actions / metrics.attempted_actions).toFixed(3));
      return {
        success: true,
        area_id: profile.area_id,
        personalization: {
          preferred_device_ids: profile.preferred_device_ids,
          excluded_device_ids: profile.excluded_device_ids,
          feedback_counts: profile.feedback_counts,
          recent_feedback: profile.feedback_records.slice(-10),
        },
        operational_effectiveness: {
          execution_count: metrics.execution_count,
          attempted_actions: metrics.attempted_actions,
          verified_actions: metrics.verified_actions,
          failed_or_unverified_actions: metrics.failed_actions,
          verification_rate: verificationRate,
          interrupted_runs: metrics.partial_runs,
          last_outcome: metrics.last_outcome,
        },
        energy_effectiveness: {
          quantified: false,
          saved_kwh: null,
          saved_percent: null,
          reason: "当前只验证设备动作和执行后状态回读，没有能耗计量设备、基线时段或对照数据；不能把动作成功率当作节能率。",
        },
        note: "此报告统计的是当前本地进程成功写入的结构化用户反馈和设备回读结果；不会自动调整风险策略或触发设备动作。",
      };
    },
  };
}
