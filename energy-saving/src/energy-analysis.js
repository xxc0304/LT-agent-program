const ANALYSIS_SCHEMA = "energy-saving.analysis/0.1";
const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DEFAULT_POLICY = Object.freeze({
  baselineRatio: 1.5,
  minimumBaselineExcessKwh: 0.05,
  offStatePowerThresholdW: 5,
});

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function assertTimezone(timezone) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
  } catch {
    throw new Error(`无效的 IANA timezone：${timezone}`);
  }
}

function localParts(timestamp, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map(({ type, value }) => [type, value]));
}

function localHourKey(timestamp, timezone) {
  const parts = localParts(timestamp, timezone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:00`;
}

function minuteOfDay(timestamp, timezone) {
  const parts = localParts(timestamp, timezone);
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function parseClock(value, field) {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`${field} 必须使用 HH:mm 格式`);
  }
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function normalizeTariff(tariff) {
  if (tariff === undefined || tariff === null) return null;
  if (!tariff || typeof tariff !== "object" || Array.isArray(tariff)) throw new Error("tariff 必须是对象");
  if (!Array.isArray(tariff.segments)) throw new Error("tariff.segments 必须是数组");
  const segments = tariff.segments.map((segment, index) => {
    if (!segment || typeof segment !== "object" || Array.isArray(segment)) throw new Error(`tariff.segments[${index}] 必须是对象`);
    if (typeof segment.name !== "string" || !segment.name.trim()) throw new Error(`tariff.segments[${index}].name 不能为空`);
    const startMinute = parseClock(segment.start, `tariff.segments[${index}].start`);
    const endMinute = parseClock(segment.end, `tariff.segments[${index}].end`);
    if (startMinute === endMinute) throw new Error(`tariff.segments[${index}] 的 start 和 end 不能相同`);
    if (!Number.isFinite(segment.price_per_kwh) || segment.price_per_kwh < 0) {
      throw new Error(`tariff.segments[${index}].price_per_kwh 必须是非负数字`);
    }
    const tier = segment.tier ?? "shoulder";
    if (!["peak", "off_peak", "shoulder"].includes(tier)) throw new Error(`tariff.segments[${index}].tier 无效`);
    return { ...segment, startMinute, endMinute, tier };
  });

  const coverage = new Array(1440).fill(null);
  for (const [index, segment] of segments.entries()) {
    for (let minute = 0; minute < 1440; minute += 1) {
      const matches = segment.startMinute < segment.endMinute
        ? minute >= segment.startMinute && minute < segment.endMinute
        : minute >= segment.startMinute || minute < segment.endMinute;
      if (!matches) continue;
      if (coverage[minute] !== null) throw new Error(`tariff 时段重叠：${segments[coverage[minute]].name} 与 ${segment.name}`);
      coverage[minute] = index;
    }
  }
  return { currency: tariff.currency ?? null, segments, coverage };
}

function tariffFor(timestamp, timezone, tariff) {
  if (!tariff) return null;
  const index = tariff.coverage[minuteOfDay(timestamp, timezone)];
  return index === null ? null : tariff.segments[index];
}

function validOptionalNumber(value, name) {
  return value === undefined || value === null || (Number.isFinite(value) && value >= 0) ? null : `${name} 必须是非负有限数字`;
}

function validateReading(reading, index) {
  const prefix = `readings[${index}]`;
  if (!reading || typeof reading !== "object" || Array.isArray(reading)) return { error: `${prefix} 必须是对象` };
  if (typeof reading.device_id !== "string" || !reading.device_id.trim()) return { error: `${prefix}.device_id 不能为空` };
  const timestamp = Date.parse(reading.recorded_at);
  if (typeof reading.recorded_at !== "string" || !Number.isFinite(timestamp)) return { error: `${prefix}.recorded_at 必须是有效时间` };
  if (!Number.isFinite(reading.interval_kwh) || reading.interval_kwh < 0) return { error: `${prefix}.interval_kwh 必须是非负有限数字` };
  for (const name of ["expected_kwh", "power_w"]) {
    const error = validOptionalNumber(reading[name], `${prefix}.${name}`);
    if (error) return { error };
  }
  return { timestamp };
}

function areaKey(reading) {
  return typeof reading.area === "string" && reading.area.trim() ? reading.area.trim() : "unknown";
}

function toSortedRows(map, keyName, valueName, digits = 3) {
  return [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({ [keyName]: key, [valueName]: round(value, digits) }));
}

/**
 * Analyze supplied interval-meter data. This function never estimates kWh from
 * instantaneous watts and never labels a candidate anomaly as confirmed waste.
 */
export function analyzeEnergyConsumption({
  readings,
  timezone = DEFAULT_TIMEZONE,
  tariff: tariffInput = null,
  policy: policyInput = {},
} = {}) {
  if (!Array.isArray(readings)) throw new Error("readings 必须是数组");
  assertTimezone(timezone);
  const policy = { ...DEFAULT_POLICY, ...policyInput };
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`policy.${name} 必须是非负有限数字`);
  }
  if (policy.baselineRatio < 1) throw new Error("policy.baselineRatio 必须大于或等于 1");
  const tariff = normalizeTariff(tariffInput);

  const accepted = [];
  const rejected = [];
  const seenBuckets = new Set();
  for (const [index, reading] of readings.entries()) {
    const validated = validateReading(reading, index);
    if (validated.error) {
      rejected.push({ index, reason: validated.error });
      continue;
    }
    const bucketKey = `${reading.device_id}\u0000${reading.recorded_at}`;
    if (seenBuckets.has(bucketKey)) {
      rejected.push({ index, reason: "同一 device_id 与 recorded_at 的重复读数" });
      continue;
    }
    seenBuckets.add(bucketKey);
    accepted.push({ ...reading, timestamp: validated.timestamp, area: areaKey(reading) });
  }

  const byDevice = new Map();
  const byArea = new Map();
  const byHour = new Map();
  const anomalies = [];
  let totalKwh = 0;
  let partialCost = 0;
  let pricedReadingCount = 0;
  let peakKwh = 0;
  let minimumOffPeakRate = null;
  let observedPeakRate = null;

  if (tariff) {
    const offPeakRates = tariff.segments.filter((segment) => segment.tier === "off_peak").map((segment) => segment.price_per_kwh);
    if (offPeakRates.length > 0) minimumOffPeakRate = Math.min(...offPeakRates);
  }

  for (const reading of accepted) {
    const kwh = reading.interval_kwh;
    totalKwh += kwh;
    byDevice.set(reading.device_id, (byDevice.get(reading.device_id) ?? 0) + kwh);
    byArea.set(reading.area, (byArea.get(reading.area) ?? 0) + kwh);
    const hour = localHourKey(reading.timestamp, timezone);
    byHour.set(hour, (byHour.get(hour) ?? 0) + kwh);

    if (reading.expected_kwh !== undefined && reading.expected_kwh !== null) {
      const excess = kwh - reading.expected_kwh;
      const minimumFlaggedValue = Math.max(
        reading.expected_kwh * policy.baselineRatio,
        reading.expected_kwh + policy.minimumBaselineExcessKwh,
      );
      if (kwh >= minimumFlaggedValue) {
        anomalies.push({
          type: "ABOVE_EXPLICIT_BASELINE",
          severity: "review",
          device_id: reading.device_id,
          recorded_at: reading.recorded_at,
          observed_kwh: round(kwh),
          expected_kwh: round(reading.expected_kwh),
          excess_kwh: round(excess),
          message: "高于输入的显式基线；请核对读数和设备状态，不能单凭此结果认定浪费。",
        });
      }
    }
    if (String(reading.device_state ?? "").toLowerCase() === "off"
      && reading.power_w !== undefined && reading.power_w !== null
      && reading.power_w > policy.offStatePowerThresholdW) {
      anomalies.push({
        type: "POWER_WHILE_REPORTED_OFF",
        severity: "review",
        device_id: reading.device_id,
        recorded_at: reading.recorded_at,
        power_w: round(reading.power_w, 1),
        threshold_w: policy.offStatePowerThresholdW,
        message: "设备状态报告为关闭但仍有功率读数；可能是待机功耗或状态/计量不一致，需复核。",
      });
    }

    const segment = tariffFor(reading.timestamp, timezone, tariff);
    if (segment) {
      pricedReadingCount += 1;
      partialCost += kwh * segment.price_per_kwh;
      if (segment.tier === "peak") peakKwh += kwh;
      if (segment.tier === "peak") observedPeakRate = observedPeakRate === null
        ? segment.price_per_kwh : Math.max(observedPeakRate, segment.price_per_kwh);
    }
  }

  const acceptedCount = accepted.length;
  const costStatus = !tariff || acceptedCount === 0
    ? "UNAVAILABLE"
    : pricedReadingCount === acceptedCount ? "COMPLETE" : pricedReadingCount > 0 ? "PARTIAL" : "UNAVAILABLE";

  return {
    schema_version: ANALYSIS_SCHEMA,
    status: acceptedCount > 0 ? "ANALYZED" : "INSUFFICIENT_DATA",
    timezone,
    summary: {
      total_kwh: acceptedCount > 0 ? round(totalKwh) : null,
      reading_count: acceptedCount,
      device_count: byDevice.size,
      area_count: byArea.size,
      observed_hour_count: byHour.size,
      cost_status: costStatus,
      cost: costStatus === "COMPLETE" ? round(partialCost, 2) : null,
      partial_cost: pricedReadingCount > 0 ? round(partialCost, 2) : null,
      currency: tariff?.currency ?? null,
      peak_window_kwh: tariff && acceptedCount > 0 && costStatus === "COMPLETE" ? round(peakKwh) : null,
      minimum_off_peak_rate: numberOrNull(minimumOffPeakRate),
      maximum_observed_peak_rate: numberOrNull(observedPeakRate),
    },
    by_device: toSortedRows(byDevice, "device_id", "consumption_kwh"),
    by_area: toSortedRows(byArea, "area", "consumption_kwh"),
    hourly_profile: toSortedRows(byHour, "local_hour", "consumption_kwh"),
    possible_anomalies: anomalies,
    data_quality: {
      input_reading_count: readings.length,
      accepted_reading_count: acceptedCount,
      rejected_reading_count: rejected.length,
      rejected_readings: rejected,
      priced_reading_count: pricedReadingCount,
      completeness: "UNKNOWN_INPUT_COVERAGE",
      meter_topology: "CALLER_MUST_SUPPLY_NON_OVERLAPPING_METERS",
    },
  };
}
