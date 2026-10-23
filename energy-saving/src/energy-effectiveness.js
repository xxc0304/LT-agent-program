const EFFECT_SCHEMA = "energy-saving.effect-comparison/0.1";

function timestamp(value, field) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed)) throw new Error(`${field} 必须是有效 ISO 时间字符串`);
  return parsed;
}

function normalizeWindow(window, name, intervalMs, deviceIds) {
  if (!window || typeof window !== "object" || Array.isArray(window)) throw new Error(`${name} 必须是对象`);
  const start = timestamp(window.start_at, `${name}.start_at`);
  const end = timestamp(window.end_at, `${name}.end_at`);
  if (end <= start || (end - start) % intervalMs !== 0) {
    throw new Error(`${name} 必须是正时长，且窗口长度必须能被采样间隔整除`);
  }
  if (!Array.isArray(window.readings)) throw new Error(`${name}.readings 必须是数组`);
  const slotCount = (end - start) / intervalMs;
  const expectedCount = slotCount * deviceIds.length;
  const seen = new Set();
  const rejected = [];
  let totalKwh = 0;

  for (const [index, reading] of window.readings.entries()) {
    const prefix = `${name}.readings[${index}]`;
    if (!reading || typeof reading !== "object" || Array.isArray(reading)) {
      rejected.push({ index, reason: "读数必须是对象" });
      continue;
    }
    if (!deviceIds.includes(reading.device_id)) {
      rejected.push({ index, reason: "device_id 不在显式比较清单中" });
      continue;
    }
    const recordedAt = typeof reading.recorded_at === "string" ? Date.parse(reading.recorded_at) : NaN;
    if (!Number.isFinite(recordedAt)) {
      rejected.push({ index, reason: `${prefix}.recorded_at 无效` });
      continue;
    }
    const elapsed = recordedAt - start;
    if (elapsed <= 0 || recordedAt > end || elapsed % intervalMs !== 0) {
      rejected.push({ index, reason: "recorded_at 必须位于窗口内且精确对齐采样间隔终点" });
      continue;
    }
    if (!Number.isFinite(reading.interval_kwh) || reading.interval_kwh < 0) {
      rejected.push({ index, reason: `${prefix}.interval_kwh 必须是非负有限数字` });
      continue;
    }
    const slot = elapsed / intervalMs;
    const key = `${reading.device_id}\u0000${slot}`;
    if (seen.has(key)) {
      rejected.push({ index, reason: "同一设备采样时段出现重复读数" });
      continue;
    }
    seen.add(key);
    totalKwh += reading.interval_kwh;
  }

  return {
    start,
    end,
    durationMs: end - start,
    expectedCount,
    observedCount: seen.size,
    missingCount: expectedCount - seen.size,
    rejected,
    totalKwh,
    complete: seen.size === expectedCount && rejected.length === 0,
  };
}

/** Compare matched energy observation windows without claiming causality. */
export function evaluateEnergyEffect({
  baseline,
  follow_up,
  device_ids,
  interval_minutes,
} = {}) {
  if (!Array.isArray(device_ids) || device_ids.length === 0
    || device_ids.some((id) => typeof id !== "string" || !id.trim())
    || new Set(device_ids).size !== device_ids.length) {
    throw new Error("device_ids 必须是非空且不重复的设备 ID 数组");
  }
  if (!Number.isInteger(interval_minutes) || interval_minutes <= 0) throw new Error("interval_minutes 必须是正整数");
  const intervalMs = interval_minutes * 60_000;
  const before = normalizeWindow(baseline, "baseline", intervalMs, device_ids);
  const after = normalizeWindow(follow_up, "follow_up", intervalMs, device_ids);
  const sameDuration = before.durationMs === after.durationMs;
  const complete = before.complete && after.complete && sameDuration;
  const deltaKwh = complete ? before.totalKwh - after.totalKwh : null;
  const reportableDelta = deltaKwh === null ? null : Math.round((deltaKwh + Number.EPSILON) * 1000) / 1000;
  const reductionPercent = complete && before.totalKwh > 0
    ? Math.round(((deltaKwh / before.totalKwh) * 100 + Number.EPSILON) * 100) / 100
    : null;
  const direction = reportableDelta === null
    ? "NOT_COMPARABLE"
    : reportableDelta > 0
      ? "LOWER_AFTER_AT_REPORT_PRECISION"
      : reportableDelta < 0
        ? "HIGHER_AFTER_AT_REPORT_PRECISION"
        : "NO_DIFFERENCE_AT_REPORT_PRECISION";

  return {
    schema_version: EFFECT_SCHEMA,
    status: complete ? "COMPARABLE" : "INSUFFICIENT_OR_MISMATCHED_DATA",
    comparison_basis: {
      device_ids: [...device_ids].sort(),
      interval_minutes,
      baseline_duration_hours: Math.round((before.durationMs / 3_600_000) * 1000) / 1000,
      follow_up_duration_hours: Math.round((after.durationMs / 3_600_000) * 1000) / 1000,
      same_duration: sameDuration,
      complete_fixed_interval_coverage: complete,
    },
    baseline: {
      total_kwh: before.observedCount > 0 ? Math.round((before.totalKwh + Number.EPSILON) * 1000) / 1000 : null,
      coverage: { observed: before.observedCount, expected: before.expectedCount, missing: before.missingCount },
      rejected_readings: before.rejected,
    },
    follow_up: {
      total_kwh: after.observedCount > 0 ? Math.round((after.totalKwh + Number.EPSILON) * 1000) / 1000 : null,
      coverage: { observed: after.observedCount, expected: after.expectedCount, missing: after.missingCount },
      rejected_readings: after.rejected,
    },
    observed_change: {
      baseline_minus_follow_up_kwh: reportableDelta,
      reduction_percent: reductionPercent,
      direction,
    },
    interpretation: complete
      ? "这是同设备、同长度、完整采样窗口的前后观察差值；占用、天气、电价和其他行为未控制，不能据此证明由某个动作造成节能。"
      : "采样覆盖不完整或比较条件不匹配；不计算节能差值，需先补齐窗口或设备读数。",
    causality: "NOT_ESTABLISHED_BY_BEFORE_AFTER_COMPARISON",
  };
}
