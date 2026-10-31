import { analyzeEnergyConsumption } from "./energy-analysis.js";

const OPTIMIZATION_SCHEMA = "energy-saving.optimization-plan/0.1";
const QUARTER_HOUR_MS = 15 * 60_000;
const EXPLICIT_TIMEZONE_SUFFIX = /(?:Z|[+-]\d{2}:\d{2})$/i;

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function parseClock(value, field) {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`${field} 必须使用 HH:mm 格式`);
  }
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function createTariffRateLookup(timezone, segments) {
  const formatter = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const normalized = segments.map((segment, index) => ({
    start: parseClock(segment.start, `tariff.segments[${index}].start`),
    end: parseClock(segment.end, `tariff.segments[${index}].end`),
    rate: segment.price_per_kwh,
  }));
  const cache = new Map();
  return (timestamp) => {
    const minuteTimestamp = Math.floor(timestamp / 60_000) * 60_000;
    if (cache.has(minuteTimestamp)) return cache.get(minuteTimestamp);
    const parts = formatter.formatToParts(new Date(minuteTimestamp));
    const values = Object.fromEntries(parts.filter((item) => item.type !== "literal").map(({ type, value }) => [type, value]));
    const minute = Number(values.hour) * 60 + Number(values.minute);
    const matching = normalized.find(({ start, end }) => start < end
      ? minute >= start && minute < end
      : minute >= start || minute < end);
    const rate = matching?.rate ?? null;
    cache.set(minuteTimestamp, rate);
    return rate;
  };
}

function costForWindow(startMs, durationMinutes, energyKwh, tariffRateAt) {
  let rateMinuteSum = 0;
  for (let offset = 0; offset < durationMinutes; offset += 1) {
    const rate = tariffRateAt(startMs + offset * 60_000);
    if (rate === null) return null;
    rateMinuteSum += rate;
  }
  return energyKwh * (rateMinuteSum / durationMinutes);
}

function formatLocalDateTime(timestamp, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts
    .filter((part) => part.type !== "literal")
    .map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
}

function planFlexibleLoad(load, index, { timezone, segments, currency }) {
  const prefix = `flexible_loads[${index}]`;
  if (!load || typeof load !== "object" || Array.isArray(load)) throw new Error(`${prefix} 必须是对象`);
  if (typeof load.load_id !== "string" || !load.load_id.trim()) throw new Error(`${prefix}.load_id 必须是非空字符串`);
  if (typeof load.name !== "string" || !load.name.trim()) throw new Error(`${prefix}.name 必须是非空字符串`);
  if (load.user_marked_flexible !== true) {
    return { load_id: load.load_id, name: load.name, status: "OMITTED", reason: "NOT_MARKED_FLEXIBLE_BY_USER" };
  }
  if (!Number.isFinite(load.energy_kwh) || load.energy_kwh <= 0) throw new Error(`${prefix}.energy_kwh 必须是大于 0 的数字`);
  if (!Number.isInteger(load.duration_minutes) || load.duration_minutes < 1 || load.duration_minutes > 1440) {
    throw new Error(`${prefix}.duration_minutes 必须是 1 到 1440 的整数`);
  }
  const earliestMs = Date.parse(load.earliest_start);
  const deadlineMs = Date.parse(load.deadline_at);
  if (typeof load.earliest_start !== "string" || !EXPLICIT_TIMEZONE_SUFFIX.test(load.earliest_start) || !Number.isFinite(earliestMs)) throw new Error(`${prefix}.earliest_start 必须是带时区的 ISO 时间`);
  if (typeof load.deadline_at !== "string" || !EXPLICIT_TIMEZONE_SUFFIX.test(load.deadline_at) || !Number.isFinite(deadlineMs)) throw new Error(`${prefix}.deadline_at 必须是带时区的 ISO 时间`);
  if (deadlineMs <= earliestMs) throw new Error(`${prefix}.deadline_at 必须晚于 earliest_start`);
  if (deadlineMs - earliestMs > 7 * 24 * 60 * 60_000) throw new Error(`${prefix} 的时间窗不能超过 7 天`);

  const firstStart = Math.ceil(earliestMs / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
  const latestStart = deadlineMs - load.duration_minutes * 60_000;
  if (firstStart > latestStart) {
    return { load_id: load.load_id, name: load.name, status: "OMITTED", reason: "NO_FEASIBLE_WINDOW" };
  }

  const windows = [];
  const rateAt = createTariffRateLookup(timezone, segments);
  for (let start = firstStart; start <= latestStart; start += QUARTER_HOUR_MS) {
    const cost = costForWindow(start, load.duration_minutes, load.energy_kwh, rateAt);
    if (cost !== null) windows.push({ start_ms: start, estimated_cost: cost });
  }
  if (windows.length === 0) {
    return { load_id: load.load_id, name: load.name, status: "OMITTED", reason: "TARIFF_COVERAGE_GAP" };
  }
  windows.sort((left, right) => left.estimated_cost - right.estimated_cost || left.start_ms - right.start_ms);
  const recommended = windows[0];
  const baseline = windows.reduce((best, item) => item.start_ms < best.start_ms ? item : best, windows[0]);
  const estimatedCostDifference = Math.max(0, baseline.estimated_cost - recommended.estimated_cost);
  return {
    load_id: load.load_id,
    name: load.name,
    status: "RECOMMENDATION_READY",
    recommended_start: new Date(recommended.start_ms).toISOString(),
    recommended_end: new Date(recommended.start_ms + load.duration_minutes * 60_000).toISOString(),
    recommended_start_local: formatLocalDateTime(recommended.start_ms, timezone),
    recommended_end_local: formatLocalDateTime(recommended.start_ms + load.duration_minutes * 60_000, timezone),
    timezone,
    duration_minutes: load.duration_minutes,
    estimated_energy_kwh: load.energy_kwh,
    estimated_cost: round(recommended.estimated_cost, 2),
    earliest_window_cost: round(baseline.estimated_cost, 2),
    estimated_cost_difference: round(estimatedCostDifference, 2),
    currency,
    estimate_basis: "constant_energy_over_runtime_and_supplied_tariff",
    action_taken: false,
  };
}

/**
 * Analyze supplied mock/local meter samples, explicit standby labels and
 * user-declared flexible loads. This only creates recommendations; an
 * adapter must separately re-check registered devices and request approval
 * before any device action.
 */
export function planEnergyOptimization({
  readings,
  tariff,
  flexible_loads = [],
  timezone = "Asia/Shanghai",
  standby_threshold_w = 5,
  now = Date.now(),
  standby_max_age_ms = 5 * 60_000,
} = {}) {
  if (!Array.isArray(readings)) throw new Error("readings 必须是数组");
  if (!tariff || typeof tariff !== "object" || !Array.isArray(tariff.segments)) throw new Error("tariff.segments 必须是数组");
  if (!Array.isArray(flexible_loads) || flexible_loads.length > 12) throw new Error("flexible_loads 必须是最多 12 项的数组");
  if (!Number.isFinite(standby_threshold_w) || standby_threshold_w < 0) throw new Error("standby_threshold_w 必须是非负数字");
  if (!Number.isFinite(now) || now < 0) throw new Error("now 必须是非负毫秒时间戳");
  if (!Number.isFinite(standby_max_age_ms) || standby_max_age_ms < 0) throw new Error("standby_max_age_ms 必须是非负数字");

  // Reuse the canonical analysis validation for timezone, meter samples and tariff.
  const energyAnalysis = analyzeEnergyConsumption({ readings, tariff, timezone });
  const acceptedReadingIndexes = new Set();
  const seenReadingBuckets = new Set();
  for (const [index, reading] of readings.entries()) {
    const timestamp = Date.parse(reading?.recorded_at);
    const optionalNumbersValid = [reading?.expected_kwh, reading?.power_w].every((value) =>
      value === undefined || value === null || (Number.isFinite(value) && value >= 0));
    if (typeof reading?.device_id !== "string" || !reading.device_id.trim()
      || typeof reading.recorded_at !== "string" || !Number.isFinite(timestamp)
      || !Number.isFinite(reading.interval_kwh) || reading.interval_kwh < 0
      || !optionalNumbersValid) continue;
    const bucket = `${reading.device_id}\u0000${reading.recorded_at}`;
    if (seenReadingBuckets.has(bucket)) continue;
    seenReadingBuckets.add(bucket);
    acceptedReadingIndexes.add(index);
  }
  const scheduleRecommendations = flexible_loads.map((load, index) => planFlexibleLoad(load, index, {
    timezone,
    segments: tariff.segments,
    currency: tariff.currency ?? null,
  }));

  const standbyCandidates = [];
  const omittedStandbyReadings = [];
  for (const [index, reading] of readings.entries()) {
    if (reading?.load_mode !== "standby") continue;
    if (!acceptedReadingIndexes.has(index)) {
      omittedStandbyReadings.push({ device_id: reading?.device_id ?? null, reason: "INVALID_OR_DUPLICATE_METER_READING" });
      continue;
    }
    if (typeof reading.device_id !== "string" || !reading.device_id.trim()) {
      omittedStandbyReadings.push({ device_id: null, reason: "METER_DEVICE_ID_MISSING" });
      continue;
    }
    if (!Number.isFinite(reading.power_w) || reading.power_w <= standby_threshold_w) {
      omittedStandbyReadings.push({ device_id: reading.device_id, reason: "BELOW_STANDBY_THRESHOLD" });
      continue;
    }
    const recordedAt = Date.parse(reading.recorded_at);
    if (typeof reading.recorded_at !== "string" || !EXPLICIT_TIMEZONE_SUFFIX.test(reading.recorded_at)
      || !Number.isFinite(recordedAt) || now - recordedAt > standby_max_age_ms || recordedAt - now > 60_000) {
      omittedStandbyReadings.push({ device_id: reading.device_id, reason: "STALE_OR_FUTURE_STANDBY_READING" });
      continue;
    }
    if (typeof reading.control_device_id !== "string" || !reading.control_device_id.trim()) {
      omittedStandbyReadings.push({ device_id: reading.device_id, reason: "EXPLICIT_CONTROL_DEVICE_MAPPING_REQUIRED" });
      continue;
    }
    standbyCandidates.push({
      measured_device_id: reading.device_id,
      control_device_id: reading.control_device_id,
      area: typeof reading.area === "string" ? reading.area : null,
      observed_power_w: round(reading.power_w, 1),
      load_mode: "standby",
      threshold_w: standby_threshold_w,
      measurement_max_age_ms: standby_max_age_ms,
      recorded_at: reading.recorded_at,
      action: "turn_off",
      requires_device_manager_revalidation: true,
      requires_user_confirmation: true,
      note: "仅因输入明确标记 load_mode=standby 才列为候选；功率读数本身不证明设备可以断电。",
    });
  }

  return {
    schema_version: OPTIMIZATION_SCHEMA,
    source: "CALLER_SUPPLIED_DATA_ONLY",
    energy_analysis: energyAnalysis,
    schedule_recommendations: scheduleRecommendations,
    standby_action_candidates: standbyCandidates,
    omitted_standby_readings: omittedStandbyReadings,
    execution: {
      device_actions_created: false,
      device_control_performed: false,
      schedules_installed: false,
      user_confirmation_required_for_device_actions: standbyCandidates.length > 0,
    },
    interpretation: [
      "低谷排程基于用户明确标记可延后的负载，只返回时间与费用估算，不会安装定时任务或启动设备。",
      "费用比较假设负载在运行时段内均匀耗能；不代表实际电量节省。",
      "待机候选要求显式 standby 标记、测量设备到控制插座的明确映射和最新测量值；仍须设备管家核查在线、登记、节能授权、能力与当前状态。",
      "任何设备动作都必须通过设备管家计划校验和用户确认。",
    ],
  };
}
