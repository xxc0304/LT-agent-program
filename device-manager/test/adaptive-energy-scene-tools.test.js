import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DeviceInventory } from "../src/device-inventory.js";
import { createAdaptiveEnergySceneTools } from "../src/adaptive-energy-scene-tools.js";
import { ScenarioAdaptationStore } from "../src/scenario-adaptation-store.js";

function observedCapability(supported, evidence = "fixture HA capability") {
  return {
    source: "home_assistant_entity",
    status: "observed",
    actions: { turn_off: { supported, evidence, source: "fixture" } },
  };
}

async function fixture(t, devices, { approve = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-adaptive-energy-scene-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let rows = structuredClone(devices);
  const controlCalls = [];
  const scenarioProfilePath = path.join(directory, "scenario-adaptation.json");
  const deviceClient = {
    listDevices: async () => ({ success: true, devices: structuredClone(rows) }),
  };
  const inventory = new DeviceInventory({
    deviceClient,
    filePath: path.join(directory, "inventory.json"),
    clock: () => Date.parse("2026-10-10T00:00:00Z"),
  });
  await inventory.discover();
  if (approve) {
    for (const device of devices) {
      const reviewed = inventory.review({
        device_id: device.device_id,
        approval_status: "approved",
        area_id: "study_room",
        energy_opt_in: true,
        reason: "测试：用户明确核对房间并授权节能",
      });
      assert.equal(reviewed.success, true);
    }
  }
  const runtime = {
    async invoke(toolName, params) {
      if (toolName !== "control_device") return { success: false, error: { code: "TOOL_NOT_FOUND" } };
      controlCalls.push(structuredClone(params));
      const row = rows.find((item) => item.device_id === params.device_id);
      if (!row) return { success: false, error: { code: "DEVICE_NOT_FOUND" } };
      row.state = "off";
      return { success: true, verified: true, device_id: row.device_id, action: params.action };
    },
  };
  const scenarioAdaptationStore = new ScenarioAdaptationStore({
    filePath: scenarioProfilePath,
    clock: () => Date.parse("2026-10-10T00:00:00Z"),
  });
  return {
    inventory,
    controlCalls,
    runtime,
    scenarioProfilePath,
    scenarioAdaptationStore,
    setRows(next) { rows = structuredClone(next); },
    tools: createAdaptiveEnergySceneTools({
      deviceRuntime: runtime,
      deviceInventory: inventory,
      scenarioAdaptationStore,
      now: () => Date.parse("2026-10-10T00:00:00Z"),
      createPlanId: () => "adaptive-test-plan",
    }),
  };
}

test("最小节能场景按本房间已授权且明确支持的设备生成部分计划，逐项说明缺项", async (t) => {
  const { tools, controlCalls } = await fixture(t, [
    { device_id: "light.study", name: "书房灯", domain: "light", state: "on", available: true, area: "study_room", capabilities: observedCapability(true) },
    { device_id: "switch.study_plug", name: "书桌插座", domain: "switch", state: "on", available: true, area: "study_room", capabilities: observedCapability(true) },
    { device_id: "light.study_unknown", name: "能力未知灯", domain: "light", state: "on", available: true, area: "study_room", capabilities: observedCapability(null) },
    { device_id: "light.study_unsupported", name: "不支持关灯设备", domain: "light", state: "on", available: true, area: "study_room", capabilities: observedCapability(false) },
    { device_id: "switch.study_off", name: "已关闭插座", domain: "switch", state: "off", available: true, area: "study_room", capabilities: observedCapability(true) },
    { device_id: "climate.study", name: "书房空调", domain: "climate", state: "on", available: true, area: "study_room", capabilities: observedCapability(true) },
  ]);

  const plan = await tools.plan_room_energy_saving({ area_id: "Study Room" });
  assert.equal(plan.success, true);
  assert.equal(plan.execution_performed, false);
  assert.deepEqual(plan.steps.map((step) => step.device_id), ["light.study", "switch.study_plug"]);
  assert.deepEqual(plan.already_satisfied.map((item) => item.device_id), ["switch.study_off"]);
  assert.ok(plan.omitted_devices.some((item) => item.device_id === "light.study_unknown" && item.reason === "CAPABILITY_UNKNOWN"));
  assert.ok(plan.omitted_devices.some((item) => item.device_id === "light.study_unsupported" && item.reason === "ACTION_UNSUPPORTED"));
  assert.ok(plan.omitted_devices.some((item) => item.device_id === "climate.study" && item.reason === "ACTION_NOT_IN_MINIMAL_SCENE"));

  const notConfirmed = await tools.execute_room_energy_saving_plan({ plan_id: plan.plan_id, user_confirmed: false });
  assert.equal(notConfirmed.error.code, "CONFIRMATION_REQUIRED");
  assert.equal(controlCalls.length, 0);

  const executed = await tools.execute_room_energy_saving_plan({ plan_id: plan.plan_id, user_confirmed: true });
  assert.equal(executed.success, true);
  assert.equal(executed.execution_performed, true);
  assert.ok(executed.verification.every((item) => item.verified));
  assert.deepEqual(controlCalls.map((call) => call.device_id), ["light.study", "switch.study_plug"]);
});

test("预览后设备状态或能力变化会废弃旧计划，不执行陈旧动作", async (t) => {
  const initial = [
    { device_id: "light.study", name: "书房灯", domain: "light", state: "on", available: true, area: "study_room", capabilities: observedCapability(true) },
  ];
  const { tools, controlCalls, setRows } = await fixture(t, initial);
  const plan = await tools.plan_room_energy_saving({ area_id: "study_room" });
  setRows([{ ...initial[0], state: "off" }]);

  const result = await tools.execute_room_energy_saving_plan({ plan_id: plan.plan_id, user_confirmed: true });
  assert.equal(result.error.code, "PLAN_STALE");
  assert.equal(result.execution_performed, false);
  assert.equal(controlCalls.length, 0);
});

test("房间未由用户确认时不推断房间并拒绝生成计划", async (t) => {
  const { tools, inventory } = await fixture(t, [
    { device_id: "light.study", name: "书房灯", domain: "light", state: "on", available: true, area: "study_room", capabilities: observedCapability(true) },
  ], { approve: false });

  const result = await tools.plan_room_energy_saving({ area_id: "study_room" });
  assert.equal(result.success, false);
  assert.equal(result.error.code, "ROOM_NOT_CONFIRMED");
});

test("场景缺口分析说明待审核设备和完善动作，不进行控制", async (t) => {
  const { tools, inventory, controlCalls } = await fixture(t, [
    { device_id: "light.study", name: "书房灯", domain: "light", state: "on", available: true, area: "study_room", capabilities: observedCapability(true) },
    { device_id: "switch.study_pending", name: "待审核插座", domain: "switch", state: "on", available: true, area: "study_room", capabilities: observedCapability(true) },
  ], { approve: false });
  assert.equal(inventory.review({
    device_id: "light.study",
    approval_status: "approved",
    area_id: "study_room",
    energy_opt_in: true,
    reason: "测试：明确登记和授权",
  }).success, true);
  assert.equal(inventory.review({
    device_id: "switch.study_pending",
    approval_status: "excluded",
    area_id: "study_room",
    reason: "测试：房间已核对，但设备尚未批准参与控制",
  }).success, true);

  const analysis = await tools.analyze_room_energy_adaptation({ area_id: "study_room" });
  assert.equal(analysis.success, true);
  assert.equal(analysis.readiness, "partial");
  assert.equal(analysis.coverage.actionable_device_count, 1);
  assert.ok(analysis.omitted_devices.some((item) => item.device_id === "switch.study_pending" && item.reason === "DEVICE_NOT_APPROVED"));
  assert.ok(analysis.improvement_suggestions.some((item) => item.code === "DEVICE_NOT_APPROVED" && item.action === "review_device"));
  assert.equal(analysis.execution_performed, false);
  assert.equal(controlCalls.length, 0);
});

test("明确排除偏好持久化并应用到后续计划；恢复默认后重新纳入", async (t) => {
  const { tools, inventory, scenarioProfilePath, runtime } = await fixture(t, [
    { device_id: "light.study", name: "书房灯", domain: "light", state: "on", available: true, area: "study_room", capabilities: observedCapability(true) },
    { device_id: "switch.study_plug", name: "书桌插座", domain: "switch", state: "on", available: true, area: "study_room", capabilities: observedCapability(true) },
  ]);

  const saved = await tools.record_room_energy_scenario_feedback({
    area_id: "study_room",
    feedback_type: "exclude_device",
    device_id: "switch.study_plug",
    user_explicit_feedback: true,
  });
  assert.equal(saved.success, true);
  assert.equal(saved.preference_effect, "future_plans_will_exclude_device");

  const reloadedTools = createAdaptiveEnergySceneTools({
    deviceRuntime: runtime,
    deviceInventory: inventory,
    scenarioAdaptationStore: new ScenarioAdaptationStore({ filePath: scenarioProfilePath }),
  });
  const excludedPlan = await reloadedTools.plan_room_energy_saving({ area_id: "study_room" });
  assert.deepEqual(excludedPlan.steps.map((step) => step.device_id), ["light.study"]);
  assert.ok(excludedPlan.omitted_devices.some((item) => item.device_id === "switch.study_plug" && item.reason === "USER_PERSONALIZATION_EXCLUDED"));

  const reset = await reloadedTools.record_room_energy_scenario_feedback({
    area_id: "study_room",
    feedback_type: "reset_device_preference",
    device_id: "switch.study_plug",
    user_explicit_feedback: true,
  });
  assert.equal(reset.success, true);
  const defaultPlan = await reloadedTools.plan_room_energy_saving({ area_id: "study_room" });
  assert.deepEqual(defaultPlan.steps.map((step) => step.device_id), ["light.study", "switch.study_plug"]);
});

test("用户明确偏好的合格设备会在方案中优先展示", async (t) => {
  const { tools } = await fixture(t, [
    { device_id: "light.study", name: "书房灯", domain: "light", state: "on", available: true, area: "study_room", capabilities: observedCapability(true) },
    { device_id: "switch.study_plug", name: "书桌插座", domain: "switch", state: "on", available: true, area: "study_room", capabilities: observedCapability(true) },
  ]);
  const saved = await tools.record_room_energy_scenario_feedback({
    area_id: "study_room",
    feedback_type: "prefer_device",
    device_id: "switch.study_plug",
    user_explicit_feedback: true,
  });
  assert.equal(saved.success, true);
  const plan = await tools.plan_room_energy_saving({ area_id: "study_room" });
  assert.equal(plan.steps[0].device_id, "switch.study_plug");
  assert.equal(plan.steps[0].user_preference, "preferred");
  assert.equal(plan.personalization.preferred_devices[0].status, "eligible_and_prioritized");
});

test("优先设备反馈不会绕过设备审核和授权", async (t) => {
  const { tools, inventory } = await fixture(t, [
    { device_id: "light.study", name: "已授权灯", domain: "light", state: "on", available: true, area: "study_room", capabilities: observedCapability(true) },
    { device_id: "switch.study_pending", name: "未审核插座", domain: "switch", state: "on", available: true, area: "study_room", capabilities: observedCapability(true) },
  ], { approve: false });
  assert.equal(inventory.review({
    device_id: "light.study",
    approval_status: "approved",
    area_id: "study_room",
    energy_opt_in: true,
    reason: "测试：明确登记和授权",
  }).success, true);
  assert.equal(inventory.review({
    device_id: "switch.study_pending",
    approval_status: "excluded",
    area_id: "study_room",
    reason: "测试：房间已核对，但设备尚未批准参与控制",
  }).success, true);

  const preference = await tools.record_room_energy_scenario_feedback({
    area_id: "study_room",
    feedback_type: "prefer_device",
    device_id: "switch.study_pending",
    user_explicit_feedback: true,
  });
  assert.equal(preference.success, true);
  assert.equal(preference.device_not_yet_eligible, true);
  const plan = await tools.plan_room_energy_saving({ area_id: "study_room" });
  assert.deepEqual(plan.steps.map((step) => step.device_id), ["light.study"]);
  assert.ok(plan.omitted_devices.some((item) => item.device_id === "switch.study_pending" && item.reason === "DEVICE_NOT_APPROVED"));
  assert.equal(plan.personalization.preferred_devices[0].status, "preference_saved_but_not_eligible");
});

test("显式反馈和执行回读统计持久化，但不虚报节能量", async (t) => {
  const { tools, scenarioProfilePath } = await fixture(t, [
    { device_id: "light.study", name: "书房灯", domain: "light", state: "on", available: true, area: "study_room", capabilities: observedCapability(true) },
  ]);
  const rejected = await tools.record_room_energy_scenario_feedback({
    area_id: "study_room",
    feedback_type: "not_effective",
    user_explicit_feedback: false,
  });
  assert.equal(rejected.error.code, "EXPLICIT_FEEDBACK_REQUIRED");

  const feedback = await tools.record_room_energy_scenario_feedback({
    area_id: "study_room",
    feedback_type: "not_effective",
    user_explicit_feedback: true,
  });
  assert.equal(feedback.success, true);
  const analysis = await tools.analyze_room_energy_adaptation({ area_id: "study_room" });
  assert.ok(analysis.improvement_suggestions.some((item) => item.code === "ENERGY_EFFECT_NOT_MEASURED"));

  const plan = await tools.plan_room_energy_saving({ area_id: "study_room" });
  const executed = await tools.execute_room_energy_saving_plan({ plan_id: plan.plan_id, user_confirmed: true });
  assert.equal(executed.success, true);
  assert.equal(executed.evaluation_recorded, true);

  const reloaded = createAdaptiveEnergySceneTools({
    deviceRuntime: { invoke: async () => ({ success: true, verified: true }) },
    deviceInventory: { discover: async () => ({ success: true, devices: [] }), list: () => ({ success: true, devices: [] }) },
    scenarioAdaptationStore: new ScenarioAdaptationStore({ filePath: scenarioProfilePath }),
  });
  const report = reloaded.get_room_energy_adaptation_report({ area_id: "study_room" });
  assert.equal(report.operational_effectiveness.execution_count, 1);
  assert.equal(report.operational_effectiveness.attempted_actions, 1);
  assert.equal(report.operational_effectiveness.verification_rate, 1);
  assert.equal(report.personalization.feedback_counts.not_effective, 1);
  assert.equal(report.energy_effectiveness.quantified, false);
  assert.equal(report.energy_effectiveness.saved_kwh, null);
});

