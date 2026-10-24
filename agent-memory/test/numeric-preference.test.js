import assert from "node:assert/strict";
import test from "node:test";

import { normalizeInferredNumericPreference } from "../src/numeric-preference.js";

test("温度候选仅归一到 0.5°C 档，边界和无关偏好类型保持有效", () => {
  assert.equal(normalizeInferredNumericPreference("comfort_temperature_c", 22.24), 22);
  assert.equal(normalizeInferredNumericPreference("comfort_temperature_c", 22.26), 22.5);
  assert.equal(normalizeInferredNumericPreference("comfort_temperature_c", 16), 16);
  assert.equal(normalizeInferredNumericPreference("comfort_temperature_c", 30), 30);
  assert.equal(normalizeInferredNumericPreference("sleep_time", "22:30"), "22:30");
});

test("亮度候选仅归一到 5% 档，不会生成关闭值或越界值", () => {
  assert.equal(normalizeInferredNumericPreference("comfort_brightness_pct", 69), 70);
  assert.equal(normalizeInferredNumericPreference("comfort_brightness_pct", 1), 1);
  assert.equal(normalizeInferredNumericPreference("comfort_brightness_pct", 100), 100);
  assert.equal(normalizeInferredNumericPreference("comfort_brightness_pct", Number.NaN), Number.NaN);
});
