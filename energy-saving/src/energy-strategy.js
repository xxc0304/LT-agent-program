const ANALYSIS_SCHEMA = "energy-saving.analysis/0.1";
const STRATEGY_SCHEMA = "energy-saving.strategy/0.1";

function evaluateBudget(metric, used, limit, currency = null, costIsComplete = true) {
  if (limit === undefined || limit === null) return null;
  if (!Number.isFinite(limit) || limit <= 0) throw new Error(`budget.${metric} 必须是大于 0 的有限数字`);
  if (!Number.isFinite(used) || !costIsComplete) {
    return {
      metric,
      limit,
      used: null,
      used_ratio: null,
      status: "INSUFFICIENT_DATA",
      basis: "submitted_readings_only",
      forecast: false,
      ...(currency ? { currency } : {}),
    };
  }
  const ratio = used / limit;
  const status = ratio >= 1 ? "EXCEEDED" : ratio >= 0.8 ? "APPROACHING" : "WITHIN_BUDGET";
  return {
    metric,
    limit,
    used,
    used_ratio: Math.round((ratio + Number.EPSILON) * 1000) / 1000,
    status,
    basis: "submitted_readings_only",
    forecast: false,
    ...(currency ? { currency } : {}),
  };
}

/** Create advisory-only strategy notes; this module never emits device Tasks. */
export function createEnergyStrategy(analysis, { budget = {} } = {}) {
  if (!analysis || analysis.schema_version !== ANALYSIS_SCHEMA) {
    throw new Error(`analysis.schema_version 必须是 ${ANALYSIS_SCHEMA}`);
  }
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) throw new Error("budget 必须是对象");

  const kwhBudget = evaluateBudget("energy_kwh", analysis.summary?.total_kwh, budget.period_kwh);
  const costBudget = evaluateBudget(
    "cost",
    analysis.summary?.cost,
    budget.period_cost,
    analysis.summary?.currency,
    analysis.summary?.cost_status === "COMPLETE",
  );
  const budgets = [kwhBudget, costBudget].filter(Boolean);
  const recommendations = [];

  for (const result of budgets) {
    if (result.status === "EXCEEDED" || result.status === "APPROACHING") {
      recommendations.push({
        code: result.status === "EXCEEDED" ? "REVIEW_BUDGET_OVERRUN" : "REVIEW_BUDGET_HEADROOM",
        status: "ADVISORY",
        metric: result.metric,
        reason: result.status,
        message: result.status === "EXCEEDED"
          ? "已提供的读数达到或超过本期预算；请核对数据覆盖并检查可调整的用能项目。"
          : "已提供的读数接近本期预算；建议关注后续用能。",
        requires_human_review: true,
      });
    }
  }

  const peakKwh = analysis.summary?.peak_window_kwh;
  const peakRate = analysis.summary?.maximum_observed_peak_rate;
  const offPeakRate = analysis.summary?.minimum_off_peak_rate;
  if (analysis.summary?.cost_status === "COMPLETE"
    && Number.isFinite(peakKwh) && peakKwh > 0
    && Number.isFinite(peakRate) && Number.isFinite(offPeakRate) && offPeakRate < peakRate) {
    recommendations.push({
      code: "CONSIDER_SHIFTING_FLEXIBLE_LOADS",
      status: "ADVISORY",
      reason: "OFF_PEAK_RATE_LOWER_THAN_OBSERVED_PEAK_RATE",
      peak_window_kwh: peakKwh,
      observed_peak_rate: peakRate,
      minimum_off_peak_rate: offPeakRate,
      message: "分时电价显示低谷时段单价更低；可人工评估是否将可延迟负载安排到低谷时段。",
      flexible_loads_inferred: false,
      requires_human_review: true,
    });
  }

  return {
    schema_version: STRATEGY_SCHEMA,
    status: analysis.status === "ANALYZED" ? "ADVISORY_READY" : "INSUFFICIENT_DATA",
    decision_mode: "RULE_BASED_ADVISORY_ONLY",
    budgets,
    recommendations,
    safety: {
      device_tasks_created: false,
      device_control_performed: false,
      budget_forecast_performed: false,
      basis: "submitted_readings_only",
    },
  };
}
