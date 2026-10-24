import assert from "node:assert/strict";
import test from "node:test";

import { runMockMemoryLearningDemo } from "../src/mock-memory-learning-demo.js";
import { MockHomeAssistant } from "../src/mock-ha.js";

test("Mock HA 的学习事件使用单独的演示监听器，不给通用状态变化伪造来源认证", async () => {
  const homeAssistant = new MockHomeAssistant();
  const stateChanges = [];
  const behaviorEvents = [];
  const stateMonitor = homeAssistant.createStateMonitor({ onStateChange: (event) => stateChanges.push(event) });
  const behaviorMonitor = homeAssistant.createMockBehaviorMonitor({ onEvent: (event) => behaviorEvents.push(event) });
  await stateMonitor.start();
  await behaviorMonitor.start();

  const result = homeAssistant.simulateBehaviorAction({
    device_id: "climate.bedroom",
    action: "set_temperature",
    temperature_c: 24,
    actor_source: "user_manual",
    event_id: "mock-source-test",
    occurred_at: "2026-10-01T21:00:00+08:00",
    time_zone: "Asia/Shanghai",
  });

  assert.equal(result.success, true);
  assert.equal(stateChanges.length, 1);
  assert.equal(Object.hasOwn(stateChanges[0], "actor_source"), false);
  assert.equal(behaviorEvents.length, 1);
  assert.equal(behaviorEvents[0].origin, "mock");
  assert.equal(behaviorEvents[0].actor_source, "user_manual");
  assert.equal(behaviorEvents[0].temperature_c, 24);
  stateMonitor.stop();
  behaviorMonitor.stop();
});

test("Mock 学习演示完成来源过滤、三日候选、确认和偏好读取", async () => {
  const result = await runMockMemoryLearningDemo();
  assert.equal(result.real_home_assistant_connected, false);
  assert.equal(result.real_event_source_verified, false);
  assert.equal(result.llm_used, false);
  assert.deepEqual(result.numeric_preference_resolution, { temperature_c: 0.5, brightness_pct: 5 });
  assert.equal(result.scenarios.length, 2);
  assert.deepEqual(result.scenarios.map(({ memory_type }) => memory_type), ["comfort_temperature_c", "comfort_brightness_pct"]);
  assert.deepEqual(result.scenarios.map(({ candidate_value }) => candidate_value), ["24°C", "65%"]);
  assert.deepEqual(result.scenarios.map(({ observation_count }) => observation_count), [3, 3]);
  assert.deepEqual(result.scenarios.map(({ confidence }) => confidence), [0.9, 0.9]);
  assert.deepEqual(result.scenarios.map(({ confidence_semantics }) => confidence_semantics), [
    "mean_input_observation_confidence",
    "mean_input_observation_confidence",
  ]);
  assert.deepEqual(result.scenarios.map(({ evidence_dates }) => evidence_dates), [
    ["2026-10-01", "2026-10-02", "2026-10-03"],
    ["2026-10-01", "2026-10-02", "2026-10-03"],
  ]);
  assert.deepEqual(result.scenarios.map(({ preference_visible_before_confirmation }) => preference_visible_before_confirmation), [false, false]);
  assert.deepEqual(result.scenarios.map(({ user_confirmation_succeeded }) => user_confirmation_succeeded), [true, true]);
  assert.deepEqual(result.scenarios.map(({ confirmed_preference }) => confirmed_preference), ["24°C", "65%"]);
  assert.equal(result.scene_recommendation.scene_id, "home");
  assert.deepEqual(result.scene_recommendation.personalized_values, [
    { device_id: "light.living_room", action: "set_brightness", value: 65, unit: "%" },
    { device_id: "climate.bedroom", action: "set_temperature", value: 24, unit: "°C" },
  ]);
  assert.equal(result.scene_recommendation.execution_performed, false);
  assert.equal(result.scene_recommendation.user_confirmation_required_before_execution, true);
  assert.deepEqual(result.event_results.map(({ accepted_for_learning }) => accepted_for_learning), [
    true, false, false, false, true, true, true,
    true, false, false, true, true, true,
  ]);
  assert.deepEqual(result.event_summary, {
    total_event_records: 13,
    accepted_manual_event_records: 8,
    ignored_nonmanual_event_records: 5,
    distinct_evidence_days: 6,
    note: "事件记录数包含同一天的重复手动操作；证据天数按去重后的日期统计。",
  });
  assert.equal(result.post_confirmation_device_action_performed, false);
});
