import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInventoryGuardedDeviceRuntime, DeviceInventory } from "./device-inventory.js";
import { MockHomeAssistant } from "./mock-ha.js";
import { createOrchestratorBridge } from "./orchestrator-bridge.js";
import { createDeviceToolRuntime } from "./tools.js";

function show(title, value) {
  console.log(`\n${title}`);
  console.log(JSON.stringify(value, null, 2));
}

const tempDirectory = mkdtempSync(join(tmpdir(), "lt-household-inventory-demo-"));
try {
  const template = new MockHomeAssistant().listDevices().devices;
  const mockDevices = template.map((device) => (
    ["light.living_room", "switch.living_room_plug"].includes(device.device_id)
      ? { ...device, state: "on" }
      : device
  ));
  const baseRuntime = createDeviceToolRuntime(new MockHomeAssistant({ devices: mockDevices }));
  const inventory = new DeviceInventory({
    deviceClient: { listDevices: () => baseRuntime.invoke("list_devices") },
    filePath: join(tempDirectory, "device-inventory.json"),
  });
  const runtime = createInventoryGuardedDeviceRuntime(baseRuntime, inventory);

  const scan = await inventory.discover();
  show("1. 只读扫描摘要", {
    success: scan.success,
    discovered_count: scan.discovered_count,
    newly_discovered_count: scan.newly_discovered_count,
    pending_review_count: scan.pending_review_count,
    first_candidates: scan.devices.slice(0, 3).map(({ device_id, name, domain, approval_status, area_id }) => ({
      device_id, name, domain, approval_status, area_id,
    })),
  });

  const beforeApproval = await runtime.invoke("control_device", {
    device_id: "light.living_room",
    action: "turn_off",
  });
  show("2. 未登记设备的控制请求", beforeApproval);

  const reviewed = ["light.living_room", "switch.living_room_plug"].map((device_id) => inventory.review({
    device_id,
    approval_status: "approved",
    area_id: "living_room",
    energy_opt_in: true,
    reason: "Mock 演示：模拟用户核对房间并授权节能",
  }));
  show("3. 用户登记后的授权结果", reviewed.map((result) => ({
    success: result.success,
    device_id: result.device?.device_id,
    approval_status: result.device?.approval_status,
    energy_opt_in: result.device?.energy_opt_in,
  })));

  const bridge = createOrchestratorBridge(runtime, { deviceInventory: inventory });
  const energyResult = await bridge.energyAgent.handleEvent({
    schema_version: "0.1",
    event_id: "evt-inventory-demo-away",
    source_agent: "demo-home-mode",
    event_type: "home_mode_changed",
    occurred_at: new Date().toISOString(),
    privacy_level: "family",
    payload: { mode: "away" },
  });
  show("4. 节能 Agent 只为已授权设备生成候选任务", {
    status: energyResult.status,
    target_devices: energyResult.tasks.map((task) => task.target_ref.device_id),
    task_count: energyResult.tasks.length,
    note: "演示只生成 Task，不执行设备动作；全程使用临时 Mock HA 与临时清单。",
  });
} finally {
  rmSync(tempDirectory, { recursive: true, force: true });
}

