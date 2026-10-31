import { randomUUID } from "node:crypto";
import { Type } from "typebox";

import { EnergySavingAgent } from "../../energy-saving/src/energy-agent.js";
import { buildMaintenancePlan } from "./maintenance-planner.js";
import { MaintenanceScheduleStore } from "./maintenance-store.js";

const JSON_OBJECT = Type.Record(Type.String(), Type.Any());
const READING = Type.Record(Type.String(), Type.Any());
const NULLABLE_STRING = Type.Union([Type.String(), Type.Null()]);
const NULLABLE_NON_NEGATIVE_NUMBER = Type.Union([Type.Number({ minimum: 0 }), Type.Null()]);
const NULLABLE_POSITIVE_NUMBER = Type.Union([Type.Number({ exclusiveMinimum: 0 }), Type.Null()]);
const TARIFF_CLOCK = Type.String({
  pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$",
  description: "24 小时制 HH:mm。午夜写 00:00，不要写 24:00。",
});
const TARIFF_SEGMENT = Type.Object({
  name: Type.String({ minLength: 1, description: "用户提供的时段名称，例如 peak、off_peak 或 shoulder。" }),
  tier: Type.Optional(Type.Union([
    Type.Literal("peak"),
    Type.Literal("off_peak"),
    Type.Literal("shoulder"),
  ], { description: "时段类型；可省略，省略时按 shoulder 处理。" })),
  start: TARIFF_CLOCK,
  end: TARIFF_CLOCK,
  price_per_kwh: Type.Number({ minimum: 0, description: "该时段每千瓦时的单价。" }),
}, { additionalProperties: false });
const TARIFF = Type.Object({
  currency: Type.Optional(Type.String({ minLength: 1, description: "币种代码，例如 CNY。" })),
  segments: Type.Array(TARIFF_SEGMENT, {
    minItems: 1,
    maxItems: 48,
    description: "明确提供的分时电价。每段都要包含 name、start、end、price_per_kwh；时段不可重叠。",
  }),
}, { additionalProperties: false });
const ENERGY_OPTIMIZATION_PROPERTIES = {
  readings: Type.Array(READING, { maxItems: 1000 }),
  tariff: TARIFF,
  flexible_loads: Type.Optional(Type.Array(Type.Object({
    load_id: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    energy_kwh: Type.Number({ exclusiveMinimum: 0 }),
    duration_minutes: Type.Integer({ minimum: 1, maximum: 1440 }),
    earliest_start: Type.String({ minLength: 1, format: "date-time", description: "带明确时区的 ISO 8601 时间。" }),
    deadline_at: Type.String({ minLength: 1, format: "date-time", description: "带明确时区的 ISO 8601 时间；若允许恰好在午夜结束，使用次日 00:00，而不是前一日 23:59。" }),
    user_marked_flexible: Type.Boolean(),
  }, { additionalProperties: false }), { maxItems: 12 })),
  timezone: Type.Optional(Type.String()),
  standby_threshold_w: Type.Optional(Type.Number({ minimum: 0 })),
};
const ENERGY_OPTIMIZATION_INPUT = Type.Object(ENERGY_OPTIMIZATION_PROPERTIES, { additionalProperties: false });
const ENERGY_OPTIMIZATION_CALCULATOR_INPUT = Type.Object({
  ...ENERGY_OPTIMIZATION_PROPERTIES,
  evaluation_time_ms: Type.Number({ minimum: 0, description: "由委派适配器注入的统一评估时刻；调用方不得自行指定。" }),
}, { additionalProperties: false });
const MAX_COMPLETION_HISTORY_LIMIT = 50;
const MAX_COMPLETION_HISTORY_OFFSET = 500;
const ENERGY_STANDBY_ACTION_LIMIT = 11;

function paginateCompletions(completions, { limit, offset, cursor, scheduleId }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_COMPLETION_HISTORY_LIMIT
    || !Number.isInteger(offset) || offset < 0 || offset > MAX_COMPLETION_HISTORY_OFFSET
    || (cursor !== undefined && (typeof cursor !== "string" || cursor.length < 1 || cursor.length > 128))
    || (cursor !== undefined && offset !== 0)
    || (scheduleId !== undefined && (typeof scheduleId !== "string" || !scheduleId.trim()))) {
    return {
      success: false,
      error: {
        code: "INVALID_COMPLETION_HISTORY_OPTIONS",
        message: `completion_limit 必须为 1 到 ${MAX_COMPLETION_HISTORY_LIMIT}，completion_offset 必须为 0 到 ${MAX_COMPLETION_HISTORY_OFFSET} 的整数；completion_cursor 必须为非空短 ID 且不能与非零 offset 同时使用；completion_schedule_id 必须为非空字符串。`,
      },
    };
  }
  const ordered = completions
    .filter((item) => scheduleId === undefined || item.schedule_id === scheduleId)
    .slice().sort((left, right) =>
    Date.parse(right.recorded_at) - Date.parse(left.recorded_at)
      || String(right.record_id).localeCompare(String(left.record_id)));
  let page;
  let hasMore;
  if (cursor !== undefined) {
    const cursorIndex = ordered.findIndex((item) => item.record_id === cursor);
    if (cursorIndex < 0) {
      return {
        success: false,
        error: { code: "INVALID_COMPLETION_HISTORY_CURSOR", message: "完成历史分页游标未找到；请从第一页重新查询。" },
        total_count: ordered.length,
      };
    }
    const older = ordered.slice(cursorIndex + 1);
    page = older.slice(0, limit);
    hasMore = older.length > page.length;
  } else {
    page = ordered.slice(offset, offset + limit);
    hasMore = offset + page.length < ordered.length;
  }
  return {
    success: true,
    items: page,
    total_count: ordered.length,
    next_offset: cursor === undefined && hasMore ? offset + page.length : null,
    next_cursor: hasMore && page.length > 0 ? page.at(-1).record_id : null,
  };
}

export const ENERGY_OPERATIONS_TOOL_DEFINITIONS = Object.freeze([
  {
    name: "plan_energy_optimization",
    label: "plan_energy_optimization",
    description: "委派给独立能源管家 Agent 进行低谷排程和待机能耗评估。只使用本次明确提供的电量、电价和用户标记可延后的负载；能源管家调用确定性计算工具，适配器校验结果后，设备管家才会核查任何待机关闭候选。不会读取电表、安装排程或直接控制设备。费用差额是均匀耗能假设下的估算，不是实测节省。电价必须按 tariff.segments 传入；时间使用 24 小时 HH:mm，午夜写 00:00。若用户说最晚午夜结束，deadline_at 使用次日 00:00。信息不完整或结果校验失败时说明缺项，不得猜测电价或宣称已执行。",
    inputSchema: ENERGY_OPTIMIZATION_INPUT,
  },
  {
    name: "analyze_energy_usage",
    label: "analyze_energy_usage",
    description: "分析本次调用明确提供的 Mock/本地分时电量读数，返回分设备/区域/时段画像、显式基线异常候选、电价预算和建议。没有读取 HA、电表或其他外部数据，也不创建控制任务；不要把建议说成已实现节能。",
    inputSchema: Type.Object({
      readings: Type.Array(READING),
      timezone: Type.Optional(Type.String()),
      tariff: Type.Optional(JSON_OBJECT),
      policy: Type.Optional(JSON_OBJECT),
      budget: Type.Optional(JSON_OBJECT),
    }, { additionalProperties: false }),
  },
  {
    name: "forecast_energy_budget",
    label: "forecast_energy_budget",
    description: "能源管家的只读预算进度估算。仅使用调用方明确提供的预算周期和连续逐日电量；至少 3 个完整日，并必须由用户明确说明覆盖完整。缺天、未确认完整或信息不足时不预测。按已完整日期平均日用电量做线性进度估算，不是统计模型预测；不读取 HA/电表，不创建任务、不控制设备。不得替用户编造日数据或完整性确认。",
    inputSchema: Type.Object({
      budget_kwh: Type.Number({ exclusiveMinimum: 0 }),
      period_start: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "账期开始日，按家庭账单使用的本地日历日期填写。" }),
      period_end: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "账期结束日，含当天。" }),
      through_date: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "最近一个已经完整统计结束的日期。" }),
      daily_totals: Type.Array(Type.Object({
        date: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
        energy_kwh: Type.Number({ minimum: 0 }),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 366 }),
      coverage_attested_complete: Type.Literal(true, { description: "仅在用户明确说明 period_start 到 through_date 的每天电量都完整且没有漏数时传 true。" }),
    }, { additionalProperties: false }),
  },
  {
    name: "evaluate_energy_effect",
    label: "evaluate_energy_effect",
    description: "比较用户提供的同设备、同采样间隔、等时长前后电量窗口；数据不完整或不匹配时不计算差值，输出不构成因果节能证明。不读取 HA，也不控制设备。",
    inputSchema: Type.Object({
      baseline: Type.Object({ start_at: Type.String(), end_at: Type.String(), readings: Type.Array(READING) }, { additionalProperties: false }),
      follow_up: Type.Object({ start_at: Type.String(), end_at: Type.String(), readings: Type.Array(READING) }, { additionalProperties: false }),
      device_ids: Type.Array(Type.String(), { minItems: 1 }),
      interval_minutes: Type.Integer({ minimum: 1 }),
    }, { additionalProperties: false }),
  },
  {
    name: "save_maintenance_schedule",
    label: "save_maintenance_schedule",
    description: "保存或合并更新用户提供的设备维护周期，供后续到期计划查询使用。未传的可选字段保留原值；需要清除某个可选字段时显式传 null。已有 schedule_id 不可改绑其他设备/维护类型。仅存储结构化周期，不检查真实设备、不执行维护或设备操作。",
    inputSchema: Type.Object({
      maintenance_schedule: Type.Object({
        schedule_id: Type.String({ minLength: 1 }),
        device_id: Type.String({ minLength: 1 }),
        device_name: Type.Optional(NULLABLE_STRING),
        maintenance_type: Type.String({ minLength: 1 }),
        installed_at: Type.Optional(NULLABLE_STRING),
        last_completed_at: Type.Optional(NULLABLE_STRING),
        interval_days: Type.Optional(NULLABLE_POSITIVE_NUMBER),
        next_due_at: Type.Optional(NULLABLE_STRING),
        usage_since_service: Type.Optional(NULLABLE_NON_NEGATIVE_NUMBER),
        usage_limit: Type.Optional(NULLABLE_POSITIVE_NUMBER),
        usage_unit: Type.Optional(NULLABLE_STRING),
      }, { additionalProperties: false }),
    }, { additionalProperties: false }),
  },
  {
    name: "get_device_maintenance_plan",
    label: "get_device_maintenance_plan",
    description: "根据本地已保存的维护周期生成到期/逾期/信息缺失提醒，并分页返回本地完成历史。完成历史默认最近 20 条；可选 completion_schedule_id 按维护计划筛选，静态结果可传 completion_limit/completion_offset，可能变化时使用回执 completion_history_page.next_cursor 继续。本工具不连接 HA，也不执行维修、复位或设备控制。",
    inputSchema: Type.Object({
      device_statuses: Type.Optional(Type.Array(JSON_OBJECT)),
      now: Type.Optional(Type.String()),
      completion_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_COMPLETION_HISTORY_LIMIT })),
      completion_offset: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_COMPLETION_HISTORY_OFFSET })),
      completion_cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      completion_schedule_id: Type.Optional(Type.String({ minLength: 1 })),
    }, { additionalProperties: false }),
  },
  {
    name: "record_device_maintenance_completed",
    label: "record_device_maintenance_completed",
    description: "仅在用户明确说实体维护已完成后调用，并传 user_confirmed=true；记录完成时间、更新维护周期、重置已有使用量计数，并关闭该维护计划在完成时间前已生成的提醒。重复的同时间记录幂等，也会重试提醒收件箱同步。Agent 不会执行实体维护、设备复位或控制。没有明确用户反馈时必须询问，不得推断已完成。",
    inputSchema: Type.Object({
      schedule_id: Type.String({ minLength: 1 }),
      completed_at: Type.Optional(Type.String()),
      user_confirmed: Type.Literal(true),
    }, { additionalProperties: false }),
  },
]);

/** Internal calculator exposed only inside the independent energy-saving Agent session. */
export const ENERGY_OPTIMIZATION_CALCULATOR_TOOL_DEFINITION = Object.freeze({
  name: "calculate_energy_optimization",
  label: "calculate_energy_optimization",
  description: "能源管家内部确定性计算工具。依据输入的电价、读数及明确标记可延后的负载生成计算结果；只返回报告，不查询或控制设备、不创建计划、不安装排程。evaluation_time_ms 由设备管家适配器注入并原样传入。",
  inputSchema: ENERGY_OPTIMIZATION_CALCULATOR_INPUT,
});

function errorResult(error, fallbackCode) {
  return {
    success: false,
    error: {
      code: error?.code ?? fallbackCode,
      message: error instanceof Error ? error.message : "工具执行失败",
    },
  };
}

/** Compose pure energy analysis with local persisted maintenance operations. */
export function createEnergyOperationsTools({
  energyAgent = new EnergySavingAgent(),
  maintenanceStore = new MaintenanceScheduleStore(),
  reminderInbox,
  deviceInventory = null,
  agentPlanTools = null,
  clock = () => Date.now(),
} = {}) {
  if (typeof energyAgent?.analyzeEnergyUsage !== "function"
    || typeof energyAgent?.evaluateEnergyEffect !== "function") {
    throw new Error("energyAgent 必须提供 analyzeEnergyUsage() 与 evaluateEnergyEffect()");
  }
  if (!maintenanceStore
    || typeof maintenanceStore.listSchedules !== "function"
    || typeof maintenanceStore.upsertSchedule !== "function"
    || typeof maintenanceStore.recordCompletion !== "function") {
    throw new Error("maintenanceStore 接口不完整");
  }
  if (reminderInbox !== undefined && typeof reminderInbox?.completeForSchedule !== "function") {
    throw new Error("提醒收件箱必须支持维护完成同步");
  }

  async function buildEnergyActionApproval(candidates, optimization) {
    if (candidates.length === 0) return { status: "NO_ACTION_CANDIDATE", execution_performed: false };
    if (!deviceInventory || typeof deviceInventory.discover !== "function"
      || !agentPlanTools || typeof agentPlanTools.submitAgentPlan !== "function"
      || typeof energyAgent.planStandbyOptimizationTasks !== "function") {
      return {
        status: "DEVICE_MANAGER_INTEGRATION_REQUIRED",
        execution_performed: false,
        note: "当前部署未提供设备管家设备清单和计划入口；保留候选说明，不创建任何设备动作。",
      };
    }

    let scan;
    try {
      scan = await deviceInventory.discover();
    } catch {
      scan = null;
    }
    if (scan?.success !== true || !Array.isArray(scan.devices)) {
      return {
        status: "DEVICE_REVALIDATION_FAILED",
        execution_performed: false,
        error: scan?.error ?? { code: "DEVICE_DISCOVERY_FAILED", message: "无法刷新设备清单；未创建待执行计划。" },
      };
    }

    const eligibleCandidates = [];
    const omitted = [];
    const seen = new Set();
    for (const candidate of candidates) {
      const deviceId = candidate.control_device_id;
      if (seen.has(deviceId)) continue;
      seen.add(deviceId);
      const device = scan.devices.find((item) => item.device_id === deviceId);
      let reason = null;
      if (!device) reason = "CONTROL_DEVICE_NOT_IN_CURRENT_INVENTORY";
      else if (device.approval_status !== "approved") reason = "DEVICE_NOT_APPROVED";
      else if (device.energy_opt_in !== true) reason = "ENERGY_PERMISSION_REQUIRED";
      else if (device.area_confirmed !== true || typeof device.area_id !== "string" || !device.area_id.trim()) reason = "ROOM_NOT_CONFIRMED";
      else if (device.domain !== "switch") reason = "CONTROL_TARGET_MUST_BE_A_SWITCH";
      else if (device.available !== true) reason = "DEVICE_UNAVAILABLE";
      else if (device.current_state !== "on") reason = device.current_state === "off" ? "ALREADY_OFF" : "DEVICE_STATE_UNKNOWN";
      else if (device.current_capabilities?.actions?.turn_off?.supported !== true) reason = "TURN_OFF_CAPABILITY_NOT_CONFIRMED";

      if (reason) {
        omitted.push({
          control_device_id: deviceId,
          reason,
          ...(device ? { current_state: device.current_state ?? null, available: device.available ?? null } : {}),
        });
        continue;
      }
      eligibleCandidates.push(candidate);
      if (eligibleCandidates.length >= ENERGY_STANDBY_ACTION_LIMIT) break;
    }

    if (eligibleCandidates.length === 0) {
      return {
        status: "NO_ELIGIBLE_DEVICE_ACTION",
        execution_performed: false,
        omitted_devices: omitted,
      };
    }

    const planId = `energy-optimization-${randomUUID()}`;
    const energyStepId = "energy-saving-standby-plan";
    const energyOptimizationInput = {
      candidates: eligibleCandidates,
      event_id: `evt-${planId}`,
      trace_id: `trace-${planId}`,
    };
    const energyPlan = await energyAgent.planStandbyOptimizationTasks({ ...energyOptimizationInput, reserve: false });
    if (energyPlan.status !== "PLANNED" || energyPlan.tasks.length === 0) {
      return {
        status: "ENERGY_AGENT_NO_ACTION",
        execution_performed: false,
        energy_agent_result: energyPlan,
        omitted_devices: omitted,
        note: "能源管家重新读取已授权设备状态后没有生成可执行 Task；没有提交设备动作。",
      };
    }
    const planSteps = [{
      step_id: energyStepId,
      agent_id: "energy-saving",
      capability: "plan_event",
      depends_on: [],
      input: { energy_optimization: energyOptimizationInput },
    }, ...energyPlan.tasks.map((task, index) => ({
      step_id: `device-action-${index + 1}`,
      agent_id: "device-manager",
      capability: "execute_device_action",
      depends_on: [energyStepId],
      input: {},
      action: {
        name: task.action,
        target_ref: { device_id: task.target_ref.device_id },
        parameters: task.parameters ?? {},
      },
    }))];
    const result = await agentPlanTools.submitAgentPlan({
      plan: {
        schema_version: "0.1",
        plan_id: planId,
        trace_id: `trace-${planId}`,
        goal: "能源管家根据明确待机读数生成候选 Task，再由设备管家核验并在用户确认后关闭智能插座",
        steps: planSteps,
      },
    });
    return {
      status: result?.workflow_status ?? (result?.success === false ? "PLAN_REJECTED" : "PLAN_SUBMITTED"),
      execution_performed: result?.execution_performed === true,
      approval: result?.approval ?? null,
      workflow_result: result,
      omitted_devices: omitted,
      candidate_device_ids: eligibleCandidates.map((candidate) => candidate.control_device_id),
      energy_agent_result: energyPlan,
      note: "设备管家会重新核查计划证据；未收到用户针对该方案的后续明确同意时，不会执行。",
      optimization_schema: optimization.schema_version,
    };
  }

  function calculateEnergyOptimization(params = {}) {
    const { evaluation_time_ms: evaluationTime, ...optimizationInput } = params;
    return energyAgent.planEnergyOptimization({
      ...optimizationInput,
      now: Number.isFinite(evaluationTime) ? evaluationTime : clock(),
    });
  }

  async function completeEnergyOptimization(params, optimization) {
    const approval = await buildEnergyActionApproval(optimization.standby_action_candidates, optimization);
    return {
      success: true,
      source: optimization.source,
      report: optimization,
      device_action_workflow: approval,
    };
  }

  return {
    async plan_energy_optimization(params = {}) {
      try {
        const optimization = calculateEnergyOptimization(params);
        return completeEnergyOptimization(params, optimization);
      } catch (error) {
        return errorResult(error, "ENERGY_OPTIMIZATION_FAILED");
      }
    },

    calculate_energy_optimization(params = {}) {
      try {
        return calculateEnergyOptimization(params);
      } catch (error) {
        return errorResult(error, "ENERGY_OPTIMIZATION_FAILED");
      }
    },

    async complete_energy_optimization(params = {}, optimization) {
      try {
        if (!optimization || typeof optimization !== "object" || Array.isArray(optimization)) {
          throw new TypeError("optimization 必须是已通过适配器校验的对象");
        }
        return await completeEnergyOptimization(params, optimization);
      } catch (error) {
        return errorResult(error, "ENERGY_OPTIMIZATION_FAILED");
      }
    },

    async analyze_energy_usage(params = {}) {
      try {
        return { success: true, source: "CALLER_SUPPLIED_DATA_ONLY", report: energyAgent.analyzeEnergyUsage(params) };
      } catch (error) {
        return errorResult(error, "ENERGY_ANALYSIS_FAILED");
      }
    },

    async forecast_energy_budget(params = {}) {
      try {
        return { success: true, source: "CALLER_SUPPLIED_COMPLETE_DAILY_TOTALS", report: energyAgent.forecastEnergyBudget(params) };
      } catch (error) {
        return errorResult(error, "ENERGY_BUDGET_FORECAST_FAILED");
      }
    },

    async evaluate_energy_effect(params = {}) {
      try {
        return { success: true, source: "CALLER_SUPPLIED_DATA_ONLY", report: energyAgent.evaluateEnergyEffect(params) };
      } catch (error) {
        return errorResult(error, "ENERGY_EFFECT_EVALUATION_FAILED");
      }
    },

    async save_maintenance_schedule({ maintenance_schedule } = {}) {
      try {
        return await maintenanceStore.upsertSchedule(maintenance_schedule);
      } catch (error) {
        return errorResult(error, "MAINTENANCE_SCHEDULE_SAVE_FAILED");
      }
    },

    async get_device_maintenance_plan({
      device_statuses = [],
      now,
      completion_limit = 20,
      completion_offset = 0,
      completion_cursor,
      completion_schedule_id,
    } = {}) {
      try {
        const snapshot = typeof maintenanceStore.readSnapshot === "function"
          ? await maintenanceStore.readSnapshot()
          : null;
        const completions = snapshot?.completions ?? await maintenanceStore.listCompletions();
        const schedules = snapshot?.schedules ?? await maintenanceStore.listSchedules();
        const historyPage = paginateCompletions(completions, {
          limit: completion_limit,
          offset: completion_offset,
          cursor: completion_cursor,
          scheduleId: completion_schedule_id,
        });
        if (!historyPage.success) return historyPage;
        const plan = buildMaintenancePlan({
          schedules,
          device_statuses,
          now: now ?? new Date(clock()),
        });
        return {
          success: true,
          source: "LOCAL_MAINTENANCE_SCHEDULES_AND_CALLER_SUPPLIED_DIAGNOSTICS",
          plan,
          recent_completions: historyPage.items,
          completion_history_page: {
            schedule_id_filter: completion_schedule_id ?? null,
            total_count: historyPage.total_count,
            next_offset: historyPage.next_offset,
            next_cursor: historyPage.next_cursor,
          },
        };
      } catch (error) {
        return errorResult(error, "MAINTENANCE_PLAN_FAILED");
      }
    },

    async record_device_maintenance_completed(params = {}) {
      try {
        const completion = await maintenanceStore.recordCompletion(params);
        if (completion?.success !== true) return completion;
        const reminderResolution = reminderInbox
          ? await reminderInbox.completeForSchedule({
              schedule_id: params.schedule_id,
              completed_at: completion.completion?.completed_at,
            })
          : {
              success: false,
              status: "NOT_CONFIGURED",
              resolved_count: 0,
              error: { code: "REMINDER_INBOX_NOT_CONFIGURED", message: "未配置维护提醒收件箱；维护完成已记录，但提醒未同步。" },
            };
        return { ...completion, reminder_resolution: reminderResolution };
      } catch (error) {
        return errorResult(error, "MAINTENANCE_COMPLETION_RECORD_FAILED");
      }
    },
  };
}
