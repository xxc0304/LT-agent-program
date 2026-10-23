import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAdaptiveEnergySceneTools } from "./adaptive-energy-scene-tools.js";
import { createInventoryGuardedDeviceRuntime, DeviceInventory } from "./device-inventory.js";
import { MockHomeAssistant } from "./mock-ha.js";
import { createDeviceToolRuntime } from "./tools.js";
import { ScenarioAdaptationStore } from "./scenario-adaptation-store.js";

function show(title, value) {
  console.log(`\n${title}`);
  console.log(JSON.stringify(value, null, 2));
}

const tempDirectory = mkdtempSync(join(tmpdir(), "lt-adaptive-energy-demo-"));
try {
  const mock = new MockHomeAssistant({ devices: [
    {
      device_id: "light.study_main",
      name: "模拟书房灯",
      domain: "light",
      state: "on",
      available: true,
      area: "study_room",
      attributes: { brightness: 75 },
      capabilities: { actions: { turn_off: { supported: true, evidence: "Mock HA fixture: switch service available" } } },
    },
    {
      device_id: "switch.study_plug",
      name: "模拟书桌插座",
      domain: "switch",
      state: "on",
      available: true,
      area: "study_room",
      attributes: {},
      capabilities: { actions: { turn_off: { supported: true, evidence: "Mock HA fixture: switch service available" } } },
    },
    {
      device_id: "light.study_unknown",
      name: "能力未知的模拟灯",
      domain: "light",
      state: "on",
      available: true,
      area: "study_room",
      attributes: {},
      capabilities: { actions: { turn_off: { supported: null, evidence: "Mock HA fixture: capability omitted" } } },
    },
  ] });
  const baseRuntime = createDeviceToolRuntime(mock);
  const inventory = new DeviceInventory({
    deviceClient: { listDevices: () => baseRuntime.invoke("list_devices") },
    filePath: join(tempDirectory, "device-inventory.json"),
  });
  const runtime = createInventoryGuardedDeviceRuntime(baseRuntime, inventory);
  await inventory.discover();
  for (const device_id of ["light.study_main", "switch.study_plug", "light.study_unknown"]) {
    inventory.review({
      device_id,
      approval_status: "approved",
      area_id: "study_room",
      energy_opt_in: true,
      reason: "Mock 演示：模拟用户核对设备并逐台授权节能",
    });
  }

  const tools = createAdaptiveEnergySceneTools({
    deviceRuntime: runtime,
    deviceInventory: inventory,
    scenarioAdaptationStore: new ScenarioAdaptationStore({ filePath: join(tempDirectory, "scenario-adaptation.json") }),
  });
  const baseline = await tools.analyze_room_energy_adaptation({ area_id: "study_room" });
  show("0. 房间场景缺口分析（只读）", baseline);
  show("1. 用户明确反馈（Mock 合成：排除书桌插座）", await tools.record_room_energy_scenario_feedback({
    area_id: "study_room",
    feedback_type: "exclude_device",
    device_id: "switch.study_plug",
    user_explicit_feedback: true,
  }));
  const plan = await tools.plan_room_energy_saving({ area_id: "study_room" });
  show("2. 应用个性化偏好后的最小计划（只读，尚未执行）", {
    scenario_name: plan.scenario_name,
    area_id: plan.area_id,
    steps: plan.steps,
    omitted_devices: plan.omitted_devices,
    personalization: plan.personalization,
    execution_performed: plan.execution_performed,
  });

  const execution = await tools.execute_room_energy_saving_plan({ plan_id: plan.plan_id, user_confirmed: true });
  show("3. Mock 确认后的执行与回读", {
    success: execution.success,
    execution_performed: execution.execution_performed,
    verification: execution.verification,
    note: "全程只使用 Mock Home Assistant 和临时清单，不代表真实家庭设备已联调。",
  });
  show("4. 本房间适配与效果报告", tools.get_room_energy_adaptation_report({ area_id: "study_room" }));
} finally {
  rmSync(tempDirectory, { recursive: true, force: true });
}
