const VALUE_STEPS = Object.freeze({
  comfort_temperature_c: 0.5,
  comfort_brightness_pct: 5,
});

/**
 * Normalize small control-value variations before repeated observations are
 * grouped into one preference candidate. The raw event is never persisted.
 */
export function normalizeInferredNumericPreference(memoryType, value) {
  const step = VALUE_STEPS[memoryType];
  if (!step || !Number.isFinite(value)) return value;

  const rounded = Number((Math.round(value / step) * step).toFixed(1));
  if (memoryType === "comfort_temperature_c") return Math.min(30, Math.max(16, rounded));
  if (memoryType === "comfort_brightness_pct") return Math.min(100, Math.max(1, rounded));
  return rounded;
}

