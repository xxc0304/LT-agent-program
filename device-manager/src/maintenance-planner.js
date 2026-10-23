const MAINTENANCE_SCHEMA = "device-manager.maintenance-plan/0.1";
const DAY_MS = 24 * 60 * 60 * 1000;
const DIAGNOSTIC_STATES = new Set(["healthy", "abnormal", "offline"]);

const PLAN_STEPS = Object.freeze({
  filter_replacement: [
    "核对设备型号与滤芯规格，准备匹配的耗材。",
    "按设备说明书断电或进入安全维护模式后更换滤芯。",
    "按说明书复位维护计数器，并重新读取设备状态。",
  ],
  cleaning: [
    "按设备说明书确认可清洁部件与允许的清洁方式。",
    "断电后清理指定部件，避免液体接触带电部位。",
    "恢复供电后读取设备状态并记录完成时间。",
  ],
  inspection: [
    "核对设备外观、连接和耗材状态。",
    "按说明书执行规定的检查项目，不拆解未授权部件。",
    "记录检查结果；发现异常时转入设备诊断流程。",
  ],
  battery_replacement: [
    "核对电池型号、极性和设备说明书要求。",
    "按说明书更换电池，不混用新旧或不同型号电池。",
    "重新读取设备状态并记录完成时间。",
  ],
});

function parseTimestamp(value, field) {
  const timestamp = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) throw new Error(`${field} 必须是有效 ISO 时间字符串`);
  return timestamp;
}

function normalizeNow(value) {
  const timestamp = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) throw new Error("now 必须是有效 Date 或 ISO 时间字符串");
  return timestamp;
}

function validateSchedule(schedule, index) {
  const prefix = `schedules[${index}]`;
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) throw new Error(`${prefix} 必须是对象`);
  for (const key of ["schedule_id", "device_id", "maintenance_type"]) {
    if (typeof schedule[key] !== "string" || !schedule[key].trim()) throw new Error(`${prefix}.${key} 不能为空`);
  }
  if (schedule.interval_days !== undefined && (!Number.isFinite(schedule.interval_days) || schedule.interval_days <= 0)) {
    throw new Error(`${prefix}.interval_days 必须是大于 0 的有限数字`);
  }
  if (schedule.next_due_at !== undefined) parseTimestamp(schedule.next_due_at, `${prefix}.next_due_at`);
  if (schedule.last_completed_at !== undefined) parseTimestamp(schedule.last_completed_at, `${prefix}.last_completed_at`);
  if (schedule.installed_at !== undefined) parseTimestamp(schedule.installed_at, `${prefix}.installed_at`);
  if (schedule.usage_since_service !== undefined && (!Number.isFinite(schedule.usage_since_service) || schedule.usage_since_service < 0)) {
    throw new Error(`${prefix}.usage_since_service 必须是非负有限数字`);
  }
  if (schedule.usage_limit !== undefined && (!Number.isFinite(schedule.usage_limit) || schedule.usage_limit <= 0)) {
    throw new Error(`${prefix}.usage_limit 必须是大于 0 的有限数字`);
  }
  const hasUsage = schedule.usage_since_service !== undefined || schedule.usage_limit !== undefined;
  if (hasUsage && (!Number.isFinite(schedule.usage_since_service) || !Number.isFinite(schedule.usage_limit))) {
    throw new Error(`${prefix}.usage_since_service 与 usage_limit 必须同时提供`);
  }
  if (hasUsage && (typeof schedule.usage_unit !== "string" || !schedule.usage_unit.trim())) {
    throw new Error(`${prefix}.usage_unit 必须与 usage 计数同时提供`);
  }
  return schedule;
}

function normalizeDeviceStatuses(deviceStatuses, now, maxAgeMs) {
  if (!Array.isArray(deviceStatuses)) throw new Error("device_statuses 必须是数组");
  const byDevice = new Map();
  for (const [index, status] of deviceStatuses.entries()) {
    if (!status || typeof status !== "object" || Array.isArray(status)) throw new Error(`device_statuses[${index}] 必须是对象`);
    if (typeof status.device_id !== "string" || !status.device_id.trim()) throw new Error(`device_statuses[${index}].device_id 不能为空`);
    if (byDevice.has(status.device_id)) throw new Error(`device_statuses 中 device_id 重复：${status.device_id}`);
    if (typeof status.status !== "string" || !DIAGNOSTIC_STATES.has(status.status)) {
      byDevice.set(status.device_id, { status: "unknown", reason: "INVALID_DIAGNOSTIC_STATUS" });
      continue;
    }
    const observedAt = typeof status.checked_at === "string" ? Date.parse(status.checked_at) : NaN;
    if (!Number.isFinite(observedAt)) {
      byDevice.set(status.device_id, { status: "unknown", reason: "MISSING_DIAGNOSTIC_TIMESTAMP" });
      continue;
    }
    const ageMs = now - observedAt;
    if (ageMs < 0 || ageMs > maxAgeMs) {
      byDevice.set(status.device_id, {
        status: "unknown",
        reason: ageMs < 0 ? "DIAGNOSTIC_FROM_FUTURE" : "STALE_DIAGNOSTIC",
        checked_at: status.checked_at,
      });
      continue;
    }
    byDevice.set(status.device_id, {
      status: status.status,
      checked_at: status.checked_at,
      ...(typeof status.diagnosis_code === "string" ? { diagnosis_code: status.diagnosis_code } : {}),
      ...(typeof status.summary === "string" ? { summary: status.summary } : {}),
    });
  }
  return byDevice;
}

function dateDue(schedule) {
  if (schedule.next_due_at) return Date.parse(schedule.next_due_at);
  const anchor = schedule.last_completed_at ?? schedule.installed_at;
  if (!anchor || !Number.isFinite(schedule.interval_days)) return null;
  return Date.parse(anchor) + schedule.interval_days * DAY_MS;
}

function dueStatusFor(schedule, now, dueSoonDays, usageSoonRatio) {
  const dueAt = dateDue(schedule);
  const daysRemaining = dueAt === null ? null : (dueAt - now) / DAY_MS;
  const usage = schedule.usage_since_service;
  const usageLimit = schedule.usage_limit;
  const candidates = [];
  if (dueAt !== null) {
    if (dueAt < now) candidates.push("OVERDUE");
    else if (dueAt === now) candidates.push("DUE");
    else if (daysRemaining <= dueSoonDays) candidates.push("DUE_SOON");
  }
  if (Number.isFinite(usage) && Number.isFinite(usageLimit)) {
    if (usage > usageLimit) candidates.push("OVERDUE");
    else if (usage === usageLimit) candidates.push("DUE");
    else if (usage >= usageLimit * usageSoonRatio) candidates.push("DUE_SOON");
  }
  if (candidates.includes("OVERDUE")) return { status: "OVERDUE", dueAt, daysRemaining };
  if (candidates.includes("DUE")) return { status: "DUE", dueAt, daysRemaining };
  if (candidates.includes("DUE_SOON")) return { status: "DUE_SOON", dueAt, daysRemaining };
  if (dueAt === null && !Number.isFinite(usage)) return { status: "SCHEDULE_INCOMPLETE", dueAt: null, daysRemaining: null };
  return { status: "SCHEDULED", dueAt, daysRemaining };
}

function maintenanceSteps(maintenanceType) {
  return PLAN_STEPS[maintenanceType] ?? [
    "查阅该设备和维护项目对应的制造商说明书。",
    "确认耗材规格及安全断电要求后，由用户或维护人员执行。",
    "完成后记录维护时间并重新读取设备状态。",
  ];
}

function exceptionPlan(deviceStatus) {
  if (deviceStatus.status === "offline") {
    return {
      code: "CONNECTIVITY_UNVERIFIED",
      severity: "warning",
      message: "设备当前报告离线；这可能是供电、网络、网关或集成状态问题，不直接等同于硬件损坏。",
      recovery_steps: [
        "检查设备供电以及家庭网络/网关连接。",
        "在 Home Assistant 中重新读取设备状态，确认是否为短时离线。",
        "若持续离线，检查对应集成或网关日志；避免连续重放控制命令。",
        "问题持续时转交设备或集成维护人员处理。",
      ],
      automatic_recovery: false,
    };
  }
  if (deviceStatus.status === "abnormal") {
    return {
      code: "DEVICE_REPORTED_ABNORMAL",
      severity: "warning",
      message: deviceStatus.summary ?? "诊断快照报告设备异常；先核对异常码和设备说明书。",
      ...(deviceStatus.diagnosis_code ? { diagnosis_code: deviceStatus.diagnosis_code } : {}),
      recovery_steps: [
        "核对设备当前状态、异常码和最近一次操作记录。",
        "检查设备说明书中的对应处理步骤与安全要求。",
        "只执行说明书允许且用户授权的检查；不要自动复位或重复下发控制命令。",
        "异常仍存在时记录证据并联系维护人员。",
      ],
      automatic_recovery: false,
    };
  }
  return null;
}

/** Build a maintenance reminder/triage plan; it does not control devices. */
export function buildMaintenancePlan({
  schedules,
  device_statuses = [],
  now = new Date(),
  due_soon_days = 7,
  usage_soon_ratio = 0.9,
  diagnostic_max_age_ms = 5 * 60 * 1000,
} = {}) {
  if (!Array.isArray(schedules)) throw new Error("schedules 必须是数组");
  if (!Number.isFinite(due_soon_days) || due_soon_days < 0) throw new Error("due_soon_days 必须是非负有限数字");
  if (!Number.isFinite(usage_soon_ratio) || usage_soon_ratio < 0 || usage_soon_ratio > 1) {
    throw new Error("usage_soon_ratio 必须是 0 到 1 之间的数字");
  }
  if (!Number.isFinite(diagnostic_max_age_ms) || diagnostic_max_age_ms <= 0) {
    throw new Error("diagnostic_max_age_ms 必须是大于 0 的有限数字");
  }
  const nowMs = normalizeNow(now);
  const seenScheduleIds = new Set();
  const validatedSchedules = schedules.map((schedule, index) => {
    const item = validateSchedule(schedule, index);
    if (seenScheduleIds.has(item.schedule_id)) throw new Error(`schedule_id 重复：${item.schedule_id}`);
    seenScheduleIds.add(item.schedule_id);
    return item;
  });
  const statusByDevice = normalizeDeviceStatuses(device_statuses, nowMs, diagnostic_max_age_ms);

  const items = validatedSchedules.map((schedule) => {
    const due = dueStatusFor(schedule, nowMs, due_soon_days, usage_soon_ratio);
    const diagnostic = statusByDevice.get(schedule.device_id) ?? { status: "unknown", reason: "NO_DIAGNOSTIC_SNAPSHOT" };
    const exception = exceptionPlan(diagnostic);
    const plan = {
      schedule_id: schedule.schedule_id,
      device_id: schedule.device_id,
      device_name: schedule.device_name ?? schedule.device_id,
      maintenance_type: schedule.maintenance_type,
      maintenance_status: due.status,
      ...(due.dueAt === null ? {} : { next_due_at: new Date(due.dueAt).toISOString() }),
      ...(due.daysRemaining === null ? {} : { days_remaining: Math.round(due.daysRemaining * 100) / 100 }),
      ...(Number.isFinite(schedule.usage_since_service) ? {
        usage: {
          since_service: schedule.usage_since_service,
          limit: schedule.usage_limit,
          unit: schedule.usage_unit,
        },
      } : {}),
      device_health: diagnostic.status,
      ...(diagnostic.reason ? { diagnostic_status_reason: diagnostic.reason } : {}),
      maintenance_steps: maintenanceSteps(schedule.maintenance_type),
      ...(exception ? { exception } : {}),
      next_action: exception
        ? "先按异常排查清单人工核验；恢复健康后再安排维护。"
        : due.status === "OVERDUE" || due.status === "DUE"
          ? "安排维护并在完成后记录维护时间。"
          : due.status === "DUE_SOON"
            ? "准备耗材或排入近期维护计划。"
            : due.status === "SCHEDULE_INCOMPLETE"
              ? "补充安装日期/上次维护日期及周期，或提供明确的下次到期日。"
              : "按计划周期继续监测。",
    };
    return plan;
  });

  const rank = { OVERDUE: 0, DUE: 1, DUE_SOON: 2, SCHEDULE_INCOMPLETE: 3, SCHEDULED: 4 };
  items.sort((left, right) => rank[left.maintenance_status] - rank[right.maintenance_status]
    || (left.next_due_at ?? "9999").localeCompare(right.next_due_at ?? "9999")
    || left.schedule_id.localeCompare(right.schedule_id));
  const byStatus = (status) => items.filter((item) => item.maintenance_status === status).length;

  return {
    schema_version: MAINTENANCE_SCHEMA,
    generated_at: new Date(nowMs).toISOString(),
    status: items.length > 0 ? "PLAN_READY" : "NO_SCHEDULES",
    summary: {
      schedule_count: items.length,
      overdue_count: byStatus("OVERDUE"),
      due_count: byStatus("DUE"),
      due_soon_count: byStatus("DUE_SOON"),
      incomplete_schedule_count: byStatus("SCHEDULE_INCOMPLETE"),
      abnormal_device_count: items.filter((item) => item.device_health === "abnormal").length,
      offline_device_count: items.filter((item) => item.device_health === "offline").length,
      unknown_diagnostic_count: items.filter((item) => item.device_health === "unknown").length,
    },
    items,
    safety: {
      device_control_performed: false,
      maintenance_completed_automatically: false,
      requires_human_for_physical_maintenance: true,
    },
  };
}
