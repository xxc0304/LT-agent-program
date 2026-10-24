import { Type } from "typebox";

import { EnergySavingAgent } from "../../energy-saving/src/energy-agent.js";
import { buildMaintenancePlan } from "./maintenance-planner.js";
import { MaintenanceScheduleStore } from "./maintenance-store.js";

const JSON_OBJECT = Type.Record(Type.String(), Type.Any());
const READING = Type.Record(Type.String(), Type.Any());
const NULLABLE_STRING = Type.Union([Type.String(), Type.Null()]);
const NULLABLE_NON_NEGATIVE_NUMBER = Type.Union([Type.Number({ minimum: 0 }), Type.Null()]);
const NULLABLE_POSITIVE_NUMBER = Type.Union([Type.Number({ exclusiveMinimum: 0 }), Type.Null()]);
const MAX_COMPLETION_HISTORY_LIMIT = 50;
const MAX_COMPLETION_HISTORY_OFFSET = 500;

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

  return {
    async analyze_energy_usage(params = {}) {
      try {
        return { success: true, source: "CALLER_SUPPLIED_DATA_ONLY", report: energyAgent.analyzeEnergyUsage(params) };
      } catch (error) {
        return errorResult(error, "ENERGY_ANALYSIS_FAILED");
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
