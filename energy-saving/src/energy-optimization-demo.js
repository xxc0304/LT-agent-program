import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEnergyOperationsTools } from "../../device-manager/src/energy-operations-tools.js";
import { createInventoryGuardedDeviceRuntime, DeviceInventory } from "../../device-manager/src/device-inventory.js";
import { MockHomeAssistant } from "../../device-manager/src/mock-ha.js";
import { createOrchestratorBridge } from "../../device-manager/src/orchestrator-bridge.js";
import { MaintenanceScheduleStore } from "../../device-manager/src/maintenance-store.js";
import { createDeviceToolRuntime } from "../../device-manager/src/tools.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const mockNow = Date.now();
const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "lt-energy-optimization-demo-"));

function summary(result, approvalResult, stateAfter) {
  return {
    schema_version: "energy-saving.optimization-demo/0.1",
    source: "MOCK",
    generated_at: new Date(mockNow).toISOString(),
    scenario: "合成分时电价 + 明确可延后的洗碗机负载 + 标记为待机的智能插座负载",
    report: result,
    mock_confirmation: {
      type: "DEMO_FIXTURE_ONLY",
      message: "以下同意信号由演示脚本合成，用于展示确认链路，不代表真实用户已授权设备操作。",
      result: approvalResult,
    },
    device_state_after_confirmation: stateAfter,
    interpretation: [
      "样例电量、电价、待机标记和用户同意均为演示数据。",
      "低谷时段只生成建议，没有安装定时任务或启动洗碗机。",
      "插座关闭通过设备管家计划校验、确认、Mock 控制和状态回读完成。",
      "此报告不代表真实家庭的节能率或节省金额。",
    ],
  };
}

try {
  const mock = new MockHomeAssistant({ devices: [{
    device_id: "switch.demo_standby_plug",
    name: "演示待机插座",
    domain: "switch",
    state: "on",
    available: true,
    area: "kitchen",
    attributes: { power_w: 12 },
    capabilities: {
      actions: {
        turn_off: { supported: true, evidence: "Mock fixture 明确提供 turn_off 服务" },
      },
    },
  }] });
  const baseRuntime = createDeviceToolRuntime(mock);
  const inventory = new DeviceInventory({
    deviceClient: { listDevices: () => baseRuntime.invoke("list_devices") },
    filePath: path.join(tempDirectory, "device-inventory.json"),
    clock: () => mockNow,
  });
  await inventory.discover();
  const reviewed = inventory.review({
    device_id: "switch.demo_standby_plug",
    approval_status: "approved",
    area_id: "kitchen",
    energy_opt_in: true,
    reason: "Mock 演示：合成的用户设备登记与节能授权",
  });
  if (!reviewed.success) throw new Error("无法准备隔离的 Mock 设备清单");

  const guardedRuntime = createInventoryGuardedDeviceRuntime(baseRuntime, inventory);
  const bridge = createOrchestratorBridge(guardedRuntime, { deviceInventory: inventory, clock: () => mockNow });
  const tools = createEnergyOperationsTools({
    energyAgent: bridge.energyAgent,
    maintenanceStore: new MaintenanceScheduleStore({ filePath: path.join(tempDirectory, "maintenance-schedules.json") }),
    deviceInventory: inventory,
    agentPlanTools: bridge.agentPlanTools,
    clock: () => mockNow,
  });
  const result = await tools.plan_energy_optimization({
    timezone: "Asia/Shanghai",
    tariff: {
      currency: "CNY",
      segments: [
        { name: "off_peak", tier: "off_peak", start: "00:00", end: "07:00", price_per_kwh: 0.30 },
        { name: "shoulder", tier: "shoulder", start: "07:00", end: "10:00", price_per_kwh: 0.65 },
        { name: "peak", tier: "peak", start: "10:00", end: "22:00", price_per_kwh: 1.20 },
        { name: "night_off_peak", tier: "off_peak", start: "22:00", end: "00:00", price_per_kwh: 0.30 },
      ],
    },
    readings: [{
      device_id: "meter.demo_coffee_machine",
      control_device_id: "switch.demo_standby_plug",
      area: "kitchen",
      recorded_at: new Date(mockNow).toISOString(),
      interval_kwh: 0.02,
      power_w: 12,
      device_state: "on",
      load_mode: "standby",
    }],
    flexible_loads: [{
      load_id: "dishwasher-demo",
      name: "洗碗机",
      energy_kwh: 1.2,
      duration_minutes: 120,
      earliest_start: new Date(mockNow).toISOString(),
      deadline_at: new Date(mockNow + 12 * 60 * 60_000).toISOString(),
      user_marked_flexible: true,
    }],
  });
  if (result?.success !== true) throw new Error(result?.error?.message ?? "能源优化 Mock 演示未能生成结果");

  let approvalResult = { workflow_status: "NO_APPROVAL_CREATED", execution_performed: false };
  const approvalId = result?.device_action_workflow?.approval?.approval_id;
  if (result.device_action_workflow?.status !== "WAITING_FOR_APPROVAL" || !approvalId) {
    throw new Error(`设备动作没有进入用户确认环节：${result.device_action_workflow?.status ?? "UNKNOWN"}`);
  }
  const stateBeforeConfirmation = await baseRuntime.invoke("get_state", { device_id: "switch.demo_standby_plug" });
  if (stateBeforeConfirmation?.device?.state !== "on") throw new Error("确认前 Mock 插座状态应保持 on");
  approvalResult = await bridge.agentPlanTools.resolveApproval({ approval_id: approvalId, decision: "approve" });
  const stateAfter = await baseRuntime.invoke("get_state", { device_id: "switch.demo_standby_plug" });
  if (approvalResult?.workflow_status !== "COMPLETED" || stateAfter?.device?.state !== "off") {
    throw new Error(`Mock 确认、控制或回读链路未完成：${approvalResult?.workflow_status ?? "UNKNOWN"}, state=${stateAfter?.device?.state ?? "UNKNOWN"}`);
  }
  const report = summary(result, approvalResult, stateAfter);
  const artifactPath = path.join(projectRoot, "tmp", "energy-operations", `optimization-demo-${randomUUID()}.json`);
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    source: report.source,
    schedule_recommendations: result.report?.schedule_recommendations ?? [],
    standby_candidates: result.report?.standby_action_candidates ?? [],
    device_action_workflow: result.device_action_workflow?.status ?? null,
    mock_confirmation_status: approvalResult.workflow_status,
    device_state_after: stateAfter?.device?.state ?? null,
    artifact_path: path.relative(projectRoot, artifactPath),
  }, null, 2));
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}
