import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DeviceInventory } from "../src/device-inventory.js";

function fixtureCapability(supported) {
  return { actions: { turn_off: { supported, evidence: `turn_off=${supported}` } } };
}

test("扫描会报告运行期间的在线变化和动作能力变化，且能力降级不被静默隐藏", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-inventory-monitor-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let device = {
    device_id: "light.study",
    name: "书房灯",
    domain: "light",
    state: "on",
    available: true,
    capabilities: fixtureCapability(true),
  };
  const inventory = new DeviceInventory({
    filePath: path.join(directory, "inventory.json"),
    deviceClient: { listDevices: async () => ({ success: true, devices: [structuredClone(device)] }) },
    clock: () => Date.parse("2026-10-10T00:00:00Z"),
  });

  const initial = await inventory.discover();
  assert.deepEqual(initial.capability_changes, []);
  assert.deepEqual(initial.availability_changes, []);

  device = { ...device, available: false, capabilities: fixtureCapability(false) };
  const changed = await inventory.discover();
  assert.deepEqual(changed.availability_changes.map((item) => [item.previous_available, item.available]), [[true, false]]);
  assert.deepEqual(changed.capability_changes[0].changed_actions, [
    { action: "turn_off", previous: true, current: false },
  ]);
  assert.equal(changed.devices[0].last_capability_change.changed_actions[0].current, false);

  const afterRestart = new DeviceInventory({
    filePath: path.join(directory, "inventory.json"),
    deviceClient: { listDevices: async () => ({ success: true, devices: [structuredClone(device)] }) },
    clock: () => Date.parse("2026-10-10T00:00:00Z"),
  });
  const restartedScan = await afterRestart.discover();
  assert.deepEqual(restartedScan.capability_changes, []);
  // Volatile availability transitions are intentionally process-local; the
  // persistent record contains the capability audit but not a stale state.
  assert.deepEqual(restartedScan.availability_changes, []);
});
