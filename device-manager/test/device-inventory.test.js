import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createInventoryGuardedDeviceRuntime, DeviceInventory } from "../src/device-inventory.js";
import { MockHomeAssistant } from "../src/mock-ha.js";
import { createDeviceToolRuntime } from "../src/tools.js";
import { createOrchestratorBridge } from "../src/orchestrator-bridge.js";

function testInventory(t, devices = [
  { device_id: "light.study", name: "台灯", domain: "light", state: "on", available: true, attributes: {} },
  { device_id: "switch.study_plug", name: "书桌插座", domain: "switch", state: "on", available: true, attributes: {} },
  { device_id: "lock.front_door", name: "门锁", domain: "lock", state: "locked", available: true, attributes: {} },
  { device_id: "sensor.study_temperature", name: "温度", domain: "sensor", state: "22", available: true, attributes: {} },
]) {
  const directory = mkdtempSync(join(tmpdir(), "lt-device-inventory-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let currentDevices = structuredClone(devices);
  const deviceClient = {
    listDevices: () => ({ success: true, count: currentDevices.length, devices: structuredClone(currentDevices) }),
  };
  return {
    filePath: join(directory, "inventory.json"),
    deviceClient,
    replaceDevices(next) { currentDevices = structuredClone(next); },
  };
}

test("发现只读生成待核对清单，不保存实时状态，也不默认授予节能权限", async (t) => {
  const fixture = testInventory(t);
  const inventory = new DeviceInventory({ deviceClient: fixture.deviceClient, filePath: fixture.filePath });

  const scan = await inventory.discover();
  assert.equal(scan.success, true);
  assert.equal(scan.discovered_count, 4);
  assert.equal(scan.newly_discovered_count, 4);
  assert.equal(scan.pending_review_count, 4);
  assert.equal(scan.devices.find((device) => device.device_id === "light.study").current_state, "on");
  assert.equal(scan.devices.find((device) => device.device_id === "light.study").energy_opt_in, false);

  const saved = readFileSync(fixture.filePath, "utf8");
  assert.equal(saved.includes('"state"'), false);
  assert.equal(saved.includes('"current_state"'), false);
});

test("HA 房间仅作为建议导入；实体按物理设备分组，节能需用户显式核对房间", async (t) => {
  const registryDevices = [
    {
      device_id: "light.study_desk",
      name: "台灯",
      domain: "light",
      state: "on",
      available: true,
      attributes: {},
      ha_device_id: "ha-device-1",
      ha_entity_unique_id: "entity-1",
      ha_area_id: "area-1",
      area_name: "书房",
      source_device_name: "书桌灯设备",
      manufacturer: "Example",
      model: "L1",
    },
    {
      device_id: "sensor.study_desk_power",
      name: "灯具功率",
      domain: "sensor",
      state: "8",
      available: true,
      attributes: {},
      ha_device_id: "ha-device-1",
      ha_entity_unique_id: "entity-2",
      ha_area_id: "area-1",
      area_name: "书房",
      source_device_name: "书桌灯设备",
      manufacturer: "Example",
      model: "L1",
    },
  ];
  const fixture = testInventory(t, registryDevices);
  fixture.deviceClient.listDevices = () => ({
    success: true,
    count: registryDevices.length,
    registry_enrichment: { status: "available" },
    devices: structuredClone(registryDevices),
  });
  const inventory = new DeviceInventory({ deviceClient: fixture.deviceClient, filePath: fixture.filePath });
  const scan = await inventory.discover();

  assert.equal(scan.registry_enrichment.status, "available");
  assert.equal(scan.physical_devices.length, 1);
  assert.equal(scan.physical_devices[0].ha_device_id, "ha-device-1");
  assert.equal(scan.physical_devices[0].entity_count, 2);
  const light = scan.devices.find((item) => item.device_id === "light.study_desk");
  assert.equal(light.ha_area_id, "area-1");
  assert.equal(light.area_id, "书房".toLowerCase());
  assert.equal(light.area_confirmed, false);
  assert.equal(light.approval_status, "pending_review");
  assert.equal(light.energy_opt_in, false);

  const needsRoomReview = inventory.review({
    device_id: "light.study_desk",
    approval_status: "approved",
    energy_opt_in: true,
    reason: "用户批准设备并尝试授权节能",
  });
  assert.equal(needsRoomReview.error.code, "ENERGY_AREA_CONFIRMATION_REQUIRED");

  const approved = inventory.review({
    device_id: "light.study_desk",
    approval_status: "approved",
    area_id: "study_room",
    energy_opt_in: true,
    reason: "用户核对 HA 建议房间为书房，并授权节能",
  });
  assert.equal(approved.success, true);
  assert.equal(approved.device.area_confirmed, true);
  assert.equal((await inventory.listEnergyEligibleDevices()).devices.length, 1);
});

test("节能授权要求设备已确认、属于支持类型且有明确房间", async (t) => {
  const fixture = testInventory(t);
  const inventory = new DeviceInventory({ deviceClient: fixture.deviceClient, filePath: fixture.filePath });
  await inventory.discover();

  assert.equal(inventory.review({
    device_id: "light.study",
    approval_status: "approved",
    energy_opt_in: true,
    reason: "用户授权纳入节能",
  }).error.code, "ENERGY_AREA_REQUIRED");
  assert.equal(inventory.review({
    device_id: "lock.front_door",
    approval_status: "approved",
    area_id: "entry",
    energy_opt_in: true,
    reason: "用户授权",
  }).error.code, "ENERGY_DOMAIN_NOT_SUPPORTED");
  assert.equal(inventory.review({
    device_id: "light.study",
    approval_status: "excluded",
    area_id: "study_room",
    energy_opt_in: true,
    reason: "测试拒绝状态",
  }).error.code, "ENERGY_REQUIRES_APPROVAL");

  const approved = inventory.review({
    device_id: "light.study",
    approval_status: "approved",
    area_id: "study_room",
    energy_opt_in: true,
    reason: "用户确认房间并授权节能",
  });
  assert.equal(approved.success, true);
  assert.equal(inventory.isControlApproved("light.study"), true);
  assert.equal(inventory.isControlApproved("switch.study_plug"), false);

  const eligible = await inventory.listEnergyEligibleDevices();
  assert.equal(eligible.success, true);
  assert.deepEqual(eligible.devices.map((device) => device.device_id), ["light.study"]);
  assert.equal(eligible.devices[0].area, "study_room");

  const renamed = inventory.review({
    device_id: "light.study",
    approval_status: "approved",
    name: "书房台灯",
    reason: "用户修正设备名称",
  });
  assert.equal(renamed.success, true);
  assert.equal(renamed.device.energy_opt_in, true);
  assert.equal(renamed.device.area_id, "study_room");
});

test("清单持久化；HA 后续扫描不到实体时撤销旧授权并要求重新核对", async (t) => {
  const fixture = testInventory(t);
  const first = new DeviceInventory({ deviceClient: fixture.deviceClient, filePath: fixture.filePath });
  await first.discover();
  first.review({
    device_id: "light.study",
    approval_status: "approved",
    area_id: "study_room",
    energy_opt_in: true,
    reason: "用户授权",
  });

  const restarted = new DeviceInventory({ deviceClient: fixture.deviceClient, filePath: fixture.filePath });
  const present = await restarted.discover();
  assert.equal(present.success, true);
  assert.equal(restarted.isControlApproved("light.study"), true);

  fixture.replaceDevices([]);
  const missing = await restarted.discover();
  assert.deepEqual(missing.missing, ["light.study", "switch.study_plug", "lock.front_door", "sensor.study_temperature"]);
  const record = restarted.list().devices.find((device) => device.device_id === "light.study");
  assert.equal(record.approval_status, "pending_review");
  assert.equal(record.energy_opt_in, false);
  assert.equal(record.presence_status, "not_found");
  assert.equal(restarted.isControlApproved("light.study"), false);
  assert.equal((await restarted.listEnergyEligibleDevices()).devices.length, 0);
});

test("节能 Agent 通过家庭清单读取已授权设备，而非全量 HA 实体", async (t) => {
  const fixture = testInventory(t, [
    { device_id: "light.study", name: "台灯", domain: "light", state: "on", available: true, attributes: {} },
    { device_id: "switch.study_plug", name: "书桌插座", domain: "switch", state: "on", available: true, attributes: {} },
  ]);
  const inventory = new DeviceInventory({ deviceClient: fixture.deviceClient, filePath: fixture.filePath });
  await inventory.discover();
  inventory.review({
    device_id: "light.study",
    approval_status: "approved",
    area_id: "study_room",
    energy_opt_in: true,
    reason: "用户授权",
  });

  const bridge = createOrchestratorBridge(createDeviceToolRuntime(new MockHomeAssistant({ devices: [] })), {
    deviceInventory: inventory,
  });
  const planned = await bridge.energyAgent.handleEvent({
    schema_version: "0.1",
    event_id: "evt-inventory-energy",
    source_agent: "home-occupancy",
    event_type: "occupancy_changed",
    occurred_at: new Date().toISOString(),
    privacy_level: "family",
    payload: { area: "study_room", occupied: false, observed_for_ms: 600_000 },
  });

  assert.deepEqual(planned.tasks.map((task) => task.target_ref.device_id), ["light.study"]);
});

test("未登记设备的控制请求被运行时拦截，用户登记后才允许进入控制器", async (t) => {
  const homeAssistant = new MockHomeAssistant({ devices: [
    { device_id: "light.study", name: "台灯", domain: "light", state: "on", available: true, attributes: { brightness: 100 } },
  ] });
  const baseRuntime = createDeviceToolRuntime(homeAssistant);
  const fixture = testInventory(t);
  const inventory = new DeviceInventory({
    deviceClient: { listDevices: () => baseRuntime.invoke("list_devices") },
    filePath: fixture.filePath,
  });
  const guarded = createInventoryGuardedDeviceRuntime(baseRuntime, inventory);

  const denied = await guarded.invoke("control_device", { device_id: "light.study", action: "turn_off" });
  assert.equal(denied.error.code, "DEVICE_APPROVAL_REQUIRED");
  assert.equal(baseRuntime.invoke("get_state", { device_id: "light.study" }).device.state, "on");

  const reviewed = inventory.review({
    device_id: "light.study",
    approval_status: "approved",
    area_id: "study_room",
    reason: "用户核对设备身份",
  });
  assert.equal(reviewed.success, true);
  const executed = await guarded.invoke("control_device", { device_id: "light.study", action: "turn_off" });
  assert.equal(executed.success, true);
  assert.equal(baseRuntime.invoke("get_state", { device_id: "light.study" }).device.state, "off");
});

test("HA 清单读取失败时不清空、不降级或改写已有登记", async (t) => {
  const fixture = testInventory(t);
  const inventory = new DeviceInventory({ deviceClient: fixture.deviceClient, filePath: fixture.filePath });
  await inventory.discover();
  inventory.review({
    device_id: "light.study",
    approval_status: "approved",
    area_id: "study_room",
    energy_opt_in: true,
    reason: "用户授权",
  });
  fixture.deviceClient.listDevices = () => ({
    success: false,
    error: { code: "HA_TIMEOUT", message: "模拟超时" },
  });

  const failed = await inventory.discover();
  assert.equal(failed.success, false);
  assert.equal(failed.error.code, "HA_TIMEOUT");
  const record = inventory.list().devices.find((device) => device.device_id === "light.study");
  assert.equal(record.approval_status, "approved");
  assert.equal(record.energy_opt_in, true);
  assert.equal(record.area_id, "study_room");
});

test("Registry 暂不可用时保留已有物理设备/房间元数据与用户登记", async (t) => {
  const registryDevice = {
    device_id: "light.study",
    name: "台灯",
    domain: "light",
    state: "on",
    available: true,
    attributes: {},
    ha_device_id: "ha-device-1",
    ha_area_id: "area-1",
    area_name: "书房",
    source_device_name: "桌面灯",
  };
  const fixture = testInventory(t, [registryDevice]);
  let registryAvailable = true;
  fixture.deviceClient.listDevices = () => ({
    success: true,
    count: 1,
    registry_enrichment: { status: registryAvailable ? "available" : "unavailable" },
    devices: [structuredClone(registryAvailable ? registryDevice : {
      ...registryDevice,
      ha_device_id: undefined,
      ha_area_id: undefined,
      area_name: undefined,
      source_device_name: undefined,
    })],
  });
  const inventory = new DeviceInventory({ deviceClient: fixture.deviceClient, filePath: fixture.filePath });
  await inventory.discover();
  inventory.review({
    device_id: "light.study",
    approval_status: "approved",
    area_id: "study_room",
    energy_opt_in: true,
    reason: "用户核对房间并授权",
  });

  registryAvailable = false;
  const fallback = await inventory.discover();
  assert.equal(fallback.registry_enrichment.status, "unavailable");
  const record = inventory.list().devices[0];
  assert.equal(record.ha_device_id, "ha-device-1");
  assert.equal(record.area_name, "书房");
  assert.equal(record.area_id, "study_room");
  assert.equal(record.area_confirmed, true);
  assert.equal(record.energy_opt_in, true);
});

