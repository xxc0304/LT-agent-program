const FORECAST_SCHEMA = "energy-saving.budget-forecast/0.1";
const MINIMUM_OBSERVED_DAYS = 3;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value, field) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    throw new Error(`${field} 必须使用 YYYY-MM-DD 格式`);
  }
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} 不是有效日期`);
  }
  return timestamp;
}

function dayCountInclusive(startMs, endMs) {
  return Math.floor((endMs - startMs) / 86_400_000) + 1;
}

function isoDate(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function notForecasted(reason, observedDays = 0) {
  const messages = {
    COMPLETE_COVERAGE_ATTESTATION_REQUIRED: "没有明确确认逐日电量覆盖完整，因此不做账期估算。",
    AT_LEAST_THREE_COMPLETE_DAYS_REQUIRED: "完整日样本少于 3 天，当前不做账期估算。",
    DAILY_COVERAGE_GAP_OR_EXTRA_DAY: "逐日电量与账期起始日至统计截止日不连续，请补齐或核对日期。",
    DUPLICATE_DAILY_TOTAL: "同一日期出现多条逐日总量，请先合并或核对。",
  };
  return {
    schema_version: FORECAST_SCHEMA,
    status: "NOT_FORECASTED",
    reason,
    message: messages[reason] ?? "数据不足，当前不做账期估算。",
    observed_days: observedDays,
    estimate: null,
    safety: {
      device_tasks_created: false,
      device_control_performed: false,
    },
  };
}

/** Estimate end-of-period kWh from explicitly complete daily totals. */
export function forecastEnergyBudget({
  budget_kwh,
  period_start,
  period_end,
  through_date,
  daily_totals,
  coverage_attested_complete,
} = {}) {
  if (!Number.isFinite(budget_kwh) || budget_kwh <= 0) {
    throw new Error("budget_kwh 必须是大于 0 的有限数字");
  }
  const startMs = parseDate(period_start, "period_start");
  const endMs = parseDate(period_end, "period_end");
  const throughMs = parseDate(through_date, "through_date");
  if (endMs < startMs) throw new Error("period_end 不能早于 period_start");
  if (throughMs < startMs || throughMs > endMs) {
    throw new Error("through_date 必须处于本期起止日期内");
  }
  if (!Array.isArray(daily_totals) || daily_totals.length > 366) {
    throw new Error("daily_totals 必须是最多 366 项的数组");
  }
  for (const [index, item] of daily_totals.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`daily_totals[${index}] 必须是对象`);
    }
    parseDate(item.date, `daily_totals[${index}].date`);
    if (!Number.isFinite(item.energy_kwh) || item.energy_kwh < 0) {
      throw new Error(`daily_totals[${index}].energy_kwh 必须是非负有限数字`);
    }
  }

  const observedDays = dayCountInclusive(startMs, throughMs);
  if (coverage_attested_complete !== true) {
    return notForecasted("COMPLETE_COVERAGE_ATTESTATION_REQUIRED", daily_totals.length);
  }
  if (observedDays < MINIMUM_OBSERVED_DAYS) {
    return notForecasted("AT_LEAST_THREE_COMPLETE_DAYS_REQUIRED", observedDays);
  }
  if (daily_totals.length !== observedDays) {
    return notForecasted("DAILY_COVERAGE_GAP_OR_EXTRA_DAY", daily_totals.length);
  }

  const totalsByDate = new Map();
  for (const item of daily_totals) {
    if (totalsByDate.has(item.date)) return notForecasted("DUPLICATE_DAILY_TOTAL", daily_totals.length);
    totalsByDate.set(item.date, item.energy_kwh);
  }
  let observedKwh = 0;
  for (let day = 0; day < observedDays; day += 1) {
    const date = isoDate(startMs + day * 86_400_000);
    if (!totalsByDate.has(date)) return notForecasted("DAILY_COVERAGE_GAP_OR_EXTRA_DAY", daily_totals.length);
    observedKwh += totalsByDate.get(date);
  }

  const periodDays = dayCountInclusive(startMs, endMs);
  const remainingDays = periodDays - observedDays;
  const averageDailyKwh = observedKwh / observedDays;
  const projectedKwh = observedKwh + averageDailyKwh * remainingDays;
  const remainingBudgetKwh = budget_kwh - observedKwh;
  const status = observedKwh > budget_kwh
    ? "BUDGET_EXCEEDED_TO_DATE"
    : remainingDays === 0
      ? "PERIOD_COMPLETE"
      : projectedKwh > budget_kwh ? "PACE_ABOVE_BUDGET" : "PACE_WITHIN_BUDGET";

  return {
    schema_version: FORECAST_SCHEMA,
    status,
    period: { start: period_start, end: period_end, days: periodDays },
    coverage: {
      through_date,
      complete_days: observedDays,
      remaining_days: remainingDays,
      caller_attested_complete: true,
    },
    budget_kwh: round(budget_kwh),
    estimate: {
      observed_kwh: round(observedKwh),
      average_daily_kwh: round(averageDailyKwh, 3),
      projected_period_kwh: round(projectedKwh),
      remaining_budget_kwh: round(remainingBudgetKwh),
      projected_over_budget_kwh: round(Math.max(0, projectedKwh - budget_kwh)),
      projected_budget_ratio: round(projectedKwh / budget_kwh, 3),
    },
    message: status === "BUDGET_EXCEEDED_TO_DATE"
      ? "截至已完整统计日期，用电量已经超过本期预算。"
      : status === "PACE_ABOVE_BUDGET"
        ? "按已完整日期的平均用电速度估算，本期可能超过预算；建议先核对数据和可调整的用电项目。"
        : status === "PACE_WITHIN_BUDGET"
          ? "按已完整日期的平均用电速度估算，目前账期进度在预算范围内。"
          : "账期数据已覆盖到结束日；这是已累计用电量，不是预测值。",
    method: "LINEAR_PACE_FROM_COMPLETE_DAILY_TOTALS",
    interpretation: [
      "这是按已完整日期的平均日用电量推算，不是统计模型预测；后续天气、人数和用电习惯变化会改变结果。",
      "逐日数据完整性由调用方声明，能源管家无法独立验证电表覆盖。",
      "该估算只用于提醒，不会创建任务或控制设备。",
    ],
    safety: {
      device_tasks_created: false,
      device_control_performed: false,
    },
  };
}
