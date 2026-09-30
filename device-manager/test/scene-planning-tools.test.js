import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PreferenceMemoryStore } from "../../agent-memory/src/memory-store.js";
import { MockHomeAssistant } from "../src/mock-ha.js";
import { createScenePlanningTools } from "../src/scene-planning-tools.js";
import { createDeviceToolRuntime } from "../src/tools.js";

async function makeFixture(t, { climateAttributes = null } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-scene-plan-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const store = new PreferenceMemoryStore({ filePath: path.join(directory, "preferences.json") });
  const homeAssistant = new MockHomeAssistant();
  const runtime = createDeviceToolRuntime(homeAssistant);
  const deviceRuntime = climateAttributes
    ? {
        invoke(toolName, args) {
          if (toolName !== "get_state") return runtime.invoke(toolName, args);
          const result = runtime.invoke(toolName, args);
          if (result.success && args.device_id === "climate.bedroom") {
            result.device.attributes = { ...result.device.attributes, ...climateAttributes };
          }
          return result;
        },
      }
    : runtime;
  const tools = createScenePlanningTools({
    deviceRuntime,
    getHouseholdPreference: (args) => store.getPreference(args),
  });

  return { homeAssistant, runtime, store, tools };
}

test("睡眠场景把已确认卧室温度偏好放入建议计划，但不执行设备动作", async (t) => {
  const { homeAssistant, runtime, store, tools } = await makeFixture(t);
  await store.saveExplicitPreference({
    memory_type: "comfort_temperature_c",
    value: 24,
    room_id: "bedroom",
    user_explicit_request: true,
  });

  const beforeState = runtime.invoke("get_state", { device_id: "climate.bedroom" });
  const beforeAudit = homeAssistant.getAuditLog().length;
  const plan = await tools.plan_scene({ scene_id: "sleep" });
  const temperatureStep = plan.steps.find((step) => step.action === "set_temperature");
  const afterState = runtime.invoke("get_state", { device_id: "climate.bedroom" });

  assert.equal(plan.success, true);
  assert.equal(plan.execution_performed, false);
  assert.equal(plan.user_confirmation_required_before_execution, true);
  assert.equal(temperatureStep.parameters.temperature, 24);
  assert.equal(plan.temperature_adjustments[0].status, "SUGGESTED");
  assert.equal(plan.temperature_adjustments[0].configured_temperature_c, 26);
  assert.equal(plan.temperature_adjustments[0].applied_to_proposal, true);
  assert.equal(beforeState.device.attributes.temperature, 26);
  assert.equal(afterState.device.attributes.temperature, 26);
  assert.equal(homeAssistant.getAuditLog().length, beforeAudit);
});

test("个性化场景必须收到匹配口令，执行前重校验，执行后逐项回读并防止重放", async (t) => {
  const { homeAssistant, runtime, store, tools } = await makeFixture(t);
  await store.saveExplicitPreference({
    memory_type: "comfort_temperature_c",
    value: 24,
    room_id: "bedroom",
    user_explicit_request: true,
  });

  const plan = await tools.plan_scene({ scene_id: "sleep" });
  const beforeAudit = homeAssistant.getAuditLog().length;
  const rejected = await tools.execute_scene_plan({
    plan_id: plan.plan_id,
    confirmation_phrase: "确认执行方案 wrong-plan-id",
  });

  assert.equal(plan.success, true);
  assert.match(plan.confirmation_phrase, new RegExp(`^确认执行方案 ${plan.plan_id}$`));
  assert.equal(rejected.success, false);
  assert.equal(rejected.error.code, "CONFIRMATION_REQUIRED");
  assert.equal(runtime.invoke("get_state", { device_id: "climate.bedroom" }).device.attributes.temperature, 26);
  assert.equal(homeAssistant.getAuditLog().length, beforeAudit);

  const executed = await tools.execute_scene_plan({
    plan_id: plan.plan_id,
    confirmation_phrase: plan.confirmation_phrase,
  });
  assert.equal(executed.success, true);
  assert.equal(executed.confirmation_verified, true);
  assert.equal(executed.plan_revalidated, true);
  assert.equal(executed.execution_performed, true);
  assert.equal(executed.planned_temperature_c, 24);
  assert.ok(executed.verification.every((entry) => entry.verified));
  assert.equal(runtime.invoke("get_state", { device_id: "climate.bedroom" }).device.attributes.temperature, 24);

  const audit = homeAssistant.getAuditLog();
  assert.equal(audit.length, beforeAudit + 4);
  assert.ok(audit.every((entry) => entry.task_id === plan.plan_id && entry.trace_id === plan.plan_id));
  assert.equal(audit.find((entry) => entry.action === "set_temperature").parameters.temperature, 24);

  const replay = await tools.execute_scene_plan({
    plan_id: plan.plan_id,
    confirmation_phrase: plan.confirmation_phrase,
  });
  assert.equal(replay.success, false);
  assert.equal(replay.error.code, "PLAN_NOT_FOUND_OR_EXPIRED");
  assert.equal(homeAssistant.getAuditLog().length, audit.length);
});

test("确认前偏好或设备条件变化时废弃旧计划且不执行", async (t) => {
  const { homeAssistant, store, tools } = await makeFixture(t);
  await store.saveExplicitPreference({
    memory_type: "comfort_temperature_c",
    value: 24,
    room_id: "bedroom",
    user_explicit_request: true,
  });
  const plan = await tools.plan_scene({ scene_id: "sleep" });
  await store.saveExplicitPreference({
    memory_type: "comfort_temperature_c",
    value: 23,
    room_id: "bedroom",
    user_explicit_request: true,
  });

  const result = await tools.execute_scene_plan({
    plan_id: plan.plan_id,
    confirmation_phrase: plan.confirmation_phrase,
  });

  assert.equal(result.success, false);
  assert.equal(result.error.code, "PLAN_STALE");
  assert.equal(result.execution_performed, false);
  assert.equal(result.error.current_steps.find((step) => step.action === "set_temperature").parameters.temperature, 23);
  assert.equal(homeAssistant.getAuditLog().length, 0);
});

test("场景计划超过十分钟后不能执行", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-scene-expiry-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let currentTime = Date.parse("2026-09-24T00:00:00.000Z");
  const store = new PreferenceMemoryStore({ filePath: path.join(directory, "preferences.json") });
  const homeAssistant = new MockHomeAssistant();
  const runtime = createDeviceToolRuntime(homeAssistant);
  const tools = createScenePlanningTools({
    deviceRuntime: runtime,
    getHouseholdPreference: (args) => store.getPreference(args),
    now: () => currentTime,
    createPlanId: () => "test-plan-expiry",
  });
  const plan = await tools.plan_scene({ scene_id: "sleep" });
  currentTime += 10 * 60 * 1000;

  const result = await tools.execute_scene_plan({
    plan_id: plan.plan_id,
    confirmation_phrase: plan.confirmation_phrase,
  });

  assert.equal(result.success, false);
  assert.equal(result.error.code, "PLAN_NOT_FOUND_OR_EXPIRED");
  assert.equal(homeAssistant.getAuditLog().length, 0);
});

test("没有已确认偏好时保留场景默认值，待确认候选不会用于计划", async (t) => {
  const { store, tools } = await makeFixture(t);
  for (const event_id of ["candidate-1", "candidate-2", "candidate-3"]) {
    await store.proposeInferredCandidate({
      memory_type: "comfort_temperature_c",
      value: 23,
      room_id: "bedroom",
      event_id,
      observation_date: `2026-09-2${event_id.at(-1)}`,
      confidence: 0.9,
      consent_to_observe: true,
    });
  }

  const plan = await tools.plan_scene({ scene_id: "home" });
  const temperatureStep = plan.steps.find((step) => step.action === "set_temperature");

  assert.equal(plan.success, true);
  assert.equal(temperatureStep.parameters.temperature, 26);
  assert.equal(plan.temperature_adjustments[0].status, "NO_CONFIRMED_PREFERENCE");
});

test("超出设备温控范围的已确认偏好只报告冲突，不改写建议步骤", async (t) => {
  const { store, tools } = await makeFixture(t, {
    climateAttributes: { min_temperature: 25, max_temperature: 30 },
  });
  await store.saveExplicitPreference({
    memory_type: "comfort_temperature_c",
    value: 24,
    room_id: "bedroom",
    user_explicit_request: true,
  });

  const plan = await tools.plan_scene({ scene_id: "sleep" });
  const temperatureStep = plan.steps.find((step) => step.action === "set_temperature");

  assert.equal(plan.success, true);
  assert.equal(plan.execution_performed, false);
  assert.equal(temperatureStep.parameters.temperature, 26);
  assert.equal(plan.temperature_adjustments[0].status, "PREFERENCE_OUTSIDE_DEVICE_RANGE");
  assert.equal(plan.temperature_adjustments[0].applied_to_proposal, false);
});

test("设备温控范围未知时不把记忆偏好写入建议步骤", async (t) => {
  const { store, tools } = await makeFixture(t, {
    climateAttributes: { min_temperature: undefined, max_temperature: undefined },
  });
  await store.saveExplicitPreference({
    memory_type: "comfort_temperature_c",
    value: 24,
    room_id: "bedroom",
    user_explicit_request: true,
  });

  const plan = await tools.plan_scene({ scene_id: "sleep" });

  assert.equal(plan.steps.find((step) => step.action === "set_temperature").parameters.temperature, 26);
  assert.equal(plan.temperature_adjustments[0].status, "DEVICE_RANGE_UNKNOWN");
  assert.equal(plan.temperature_adjustments[0].applied_to_proposal, false);
});

test("空调离线时不把记忆偏好写入建议步骤", async (t) => {
  const { store, runtime } = await makeFixture(t);
  await store.saveExplicitPreference({
    memory_type: "comfort_temperature_c",
    value: 24,
    room_id: "bedroom",
    user_explicit_request: true,
  });
  const tools = createScenePlanningTools({
    deviceRuntime: {
      invoke(toolName, args) {
        if (toolName !== "get_state") return runtime.invoke(toolName, args);
        const result = runtime.invoke(toolName, args);
        result.device.available = false;
        return result;
      },
    },
    getHouseholdPreference: (args) => store.getPreference(args),
  });

  const plan = await tools.plan_scene({ scene_id: "sleep" });

  assert.equal(plan.steps.find((step) => step.action === "set_temperature").parameters.temperature, 26);
  assert.equal(plan.temperature_adjustments[0].status, "DEVICE_UNAVAILABLE");
  assert.equal(plan.temperature_adjustments[0].applied_to_proposal, false);
});

test("离家场景不读取无关的温度偏好，未知场景安全失败", async () => {
  let preferenceReads = 0;
  const tools = createScenePlanningTools({
    deviceRuntime: { invoke: () => ({ success: false }) },
    getHouseholdPreference: async () => {
      preferenceReads += 1;
      return null;
    },
  });

  const awayPlan = await tools.plan_scene({ scene_id: "away" });
  const invalidPlan = await tools.plan_scene({ scene_id: "unknown" });

  assert.equal(awayPlan.success, true);
  assert.equal(awayPlan.execution_performed, false);
  assert.equal(preferenceReads, 0);
  assert.equal(invalidPlan.success, false);
  assert.equal(invalidPlan.error.code, "SCENE_NOT_FOUND");
});

test("偏好读取失败时不生成个性化场景计划", async () => {
  const tools = createScenePlanningTools({
    deviceRuntime: { invoke: () => ({ success: true, device: { attributes: { min_temperature: 16, max_temperature: 30 } } }) },
    getHouseholdPreference: async () => {
      throw new Error("storage unavailable");
    },
  });

  const plan = await tools.plan_scene({ scene_id: "sleep" });

  assert.equal(plan.success, false);
  assert.equal(plan.execution_performed, false);
  assert.equal(plan.error.code, "PREFERENCE_READ_FAILED");
});
