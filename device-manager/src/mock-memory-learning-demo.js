import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PreferenceMemoryStore } from "../../agent-memory/src/memory-store.js";
import { createMockDeviceBehaviorObserver } from "../../agent-memory/src/mock-device-behavior.js";
import { MockHomeAssistant } from "./mock-ha.js";
import { createScenePlanningTools } from "./scene-planning-tools.js";
import { createDeviceToolRuntime } from "./tools.js";

export async function runMockMemoryLearningDemo() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-mock-memory-demo-"));
  const store = new PreferenceMemoryStore({ filePath: path.join(directory, "memory.json") });
  const homeAssistant = new MockHomeAssistant();
  const observer = createMockDeviceBehaviorObserver({ store });
  const observations = [];
  let observationQueue = Promise.resolve();
  const monitor = homeAssistant.createMockBehaviorMonitor({
    onEvent: (event) => {
      observationQueue = observationQueue.then(() => observer.observe(event));
      observations.push(observationQueue);
    },
  });

  try {
    await store.setDeviceActionObservationConsent({ enabled: true, user_explicit_confirmation: true });
    await monitor.start();

    const simulatedActions = [
      { scenario: "空调温度", device_id: "climate.bedroom", action: "set_temperature", temperature_c: 24, room_id: "bedroom", event_id: "temp-manual-1", day: "2026-10-01", actor_source: "user_manual" },
      { scenario: "空调温度", device_id: "climate.bedroom", action: "set_temperature", temperature_c: 24, room_id: "bedroom", event_id: "temp-automation", day: "2026-10-02", actor_source: "automation" },
      { scenario: "空调温度", device_id: "climate.bedroom", action: "set_temperature", temperature_c: 24, room_id: "bedroom", event_id: "temp-agent", day: "2026-10-02", actor_source: "agent" },
      { scenario: "空调温度", device_id: "climate.bedroom", action: "set_temperature", temperature_c: 24, room_id: "bedroom", event_id: "temp-unknown", day: "2026-10-03", actor_source: "unknown" },
      { scenario: "空调温度", device_id: "climate.bedroom", action: "set_temperature", temperature_c: 24, room_id: "bedroom", event_id: "temp-manual-1-duplicate", day: "2026-10-01", actor_source: "user_manual" },
      { scenario: "空调温度", device_id: "climate.bedroom", action: "set_temperature", temperature_c: 24.2, room_id: "bedroom", event_id: "temp-manual-2", day: "2026-10-02", actor_source: "user_manual" },
      { scenario: "空调温度", device_id: "climate.bedroom", action: "set_temperature", temperature_c: 23.9, room_id: "bedroom", event_id: "temp-manual-3", day: "2026-10-03", actor_source: "user_manual" },
      { scenario: "灯光亮度", device_id: "light.living_room", action: "set_brightness", brightness_pct: 65, room_id: "living_room", event_id: "brightness-manual-1", day: "2026-10-01", actor_source: "user_manual" },
      { scenario: "灯光亮度", device_id: "light.living_room", action: "set_brightness", brightness_pct: 65, room_id: "living_room", event_id: "brightness-automation", day: "2026-10-02", actor_source: "automation" },
      { scenario: "灯光亮度", device_id: "light.living_room", action: "set_brightness", brightness_pct: 65, room_id: "living_room", event_id: "brightness-unknown", day: "2026-10-03", actor_source: "unknown" },
      { scenario: "灯光亮度", device_id: "light.living_room", action: "set_brightness", brightness_pct: 65, room_id: "living_room", event_id: "brightness-manual-1-duplicate", day: "2026-10-01", actor_source: "user_manual" },
      { scenario: "灯光亮度", device_id: "light.living_room", action: "set_brightness", brightness_pct: 67, room_id: "living_room", event_id: "brightness-manual-2", day: "2026-10-02", actor_source: "user_manual" },
      { scenario: "灯光亮度", device_id: "light.living_room", action: "set_brightness", brightness_pct: 64, room_id: "living_room", event_id: "brightness-manual-3", day: "2026-10-03", actor_source: "user_manual" },
    ];

    const actionResults = simulatedActions.map(({ day, scenario, ...action }) => homeAssistant.simulateBehaviorAction({
      ...action,
      occurred_at: `${day}T21:00:00+08:00`,
      time_zone: "Asia/Shanghai",
    }));
    if (actionResults.some((result) => !result.success)) {
      throw new Error("Mock 空调行为事件模拟失败");
    }

    const observationResults = await Promise.all(observations);
    const acceptedEventRecords = observationResults.filter((result) => result?.accepted === true).length;
    const memories = await store.listMemories({ includePending: true });
    const scenarioDefinitions = [
      { label: "空调温度", memory_type: "comfort_temperature_c", room_id: "bedroom", unit: "°C" },
      { label: "灯光亮度", memory_type: "comfort_brightness_pct", room_id: "living_room", unit: "%" },
    ];
    const scenarios = [];
    for (const definition of scenarioDefinitions) {
      const candidate = memories.find((memory) => memory.memory_type === definition.memory_type
        && memory.observation_scope === "device_action"
        && memory.scope.room_id === definition.room_id
        && memory.status === "pending_confirmation");
      if (!candidate) throw new Error(`${definition.label}的手动操作未生成待确认候选`);
      const preferenceQuery = { memory_type: definition.memory_type, room_id: definition.room_id };
      const beforeConfirmation = await store.getPreference(preferenceQuery);
      const confirmation = await store.confirmCandidate(candidate.memory_id, { user_confirmed: true });
      const learnedPreference = await store.getPreference(preferenceQuery);
      scenarios.push({
        label: definition.label,
        memory_type: definition.memory_type,
        candidate_status: candidate.status,
        observation_count: candidate.observation_count,
        evidence_dates: candidate.evidence_dates,
        confidence: candidate.confidence,
        confidence_semantics: candidate.confidence_semantics,
        candidate_value: `${candidate.value}${definition.unit}`,
        preference_visible_before_confirmation: beforeConfirmation !== null,
        user_confirmation_succeeded: confirmation.success === true,
        confirmed_preference: learnedPreference ? `${learnedPreference.value}${definition.unit}` : null,
      });
    }

    const scenePlanner = createScenePlanningTools({
      deviceRuntime: createDeviceToolRuntime(homeAssistant),
      getHouseholdPreference: (args) => store.getPreference(args),
    });
    const scenePlan = await scenePlanner.plan_scene({ scene_id: "home" });
    if (!scenePlan.success) throw new Error(`已确认的 Mock 偏好未能生成回家场景建议：${scenePlan.error?.code}`);
    const sceneRecommendation = {
      scene_id: scenePlan.scene_id,
      scene_name: scenePlan.scene_name,
      personalized_values: scenePlan.steps
        .filter((step) => ["set_temperature", "set_brightness"].includes(step.action))
        .map((step) => ({
          device_id: step.device_id,
          action: step.action,
          value: step.action === "set_temperature"
            ? step.parameters.temperature
            : step.parameters.brightness,
          unit: step.action === "set_temperature" ? "°C" : "%",
        })),
      temperature_adjustments: scenePlan.temperature_adjustments,
      brightness_adjustments: scenePlan.brightness_adjustments,
      execution_performed: scenePlan.execution_performed,
      user_confirmation_required_before_execution: scenePlan.user_confirmation_required_before_execution,
      note: "候选经三日证据和用户确认后进入只读场景建议；此处未执行场景控制。",
    };

    monitor.stop();
    return {
      demo: "Mock 温度/亮度轻微波动 -> 来源过滤与数值归一 -> 分别累计三个日期 -> 用户确认 -> 已确认偏好",
      numeric_preference_resolution: { temperature_c: 0.5, brightness_pct: 5 },
      authorization: "仅为本次临时演示数据显式开启设备行为观察授权；默认仍关闭",
      event_results: simulatedActions.map((event, index) => ({
        scenario: event.scenario,
        actor_source: event.actor_source,
        accepted_for_learning: observationResults[index]?.accepted === true,
        ...(observationResults[index]?.ignored_reason ? { ignored_reason: observationResults[index].ignored_reason } : {}),
        ...(observationResults[index]?.memory ? { observation_count: observationResults[index].memory.observation_count } : {}),
      })),
      event_summary: {
        total_event_records: simulatedActions.length,
        accepted_manual_event_records: acceptedEventRecords,
        ignored_nonmanual_event_records: simulatedActions.length - acceptedEventRecords,
        distinct_evidence_days: scenarios.reduce((total, scenario) => total + scenario.evidence_dates.length, 0),
        note: "事件记录数包含同一天的重复手动操作；证据天数按去重后的日期统计。",
      },
      scenarios,
      scene_recommendation: sceneRecommendation,
      real_home_assistant_connected: false,
      real_event_source_verified: false,
      llm_used: false,
      post_confirmation_device_action_performed: false,
      storage: "临时测试目录；演示结束后删除，不写入家庭正式记忆",
    };
  } finally {
    monitor.stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMockMemoryLearningDemo()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
