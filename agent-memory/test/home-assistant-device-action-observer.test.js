import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PreferenceMemoryStore } from "../src/memory-store.js";
import { createHomeAssistantDeviceActionObserver } from "../src/home-assistant-device-action-observer.js";

async function setup(t, { reviewed = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-ha-memory-observer-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new PreferenceMemoryStore({ filePath: path.join(directory, "memory.json") });
  const devices = reviewed ? [{
    device_id: "climate.bedroom",
    domain: "climate",
    approval_status: "approved",
    area_confirmed: true,
    area_id: "bedroom",
    presence_status: "present",
  }] : [];
  const deviceInventory = { list: () => ({ success: true, devices }) };
  const observer = createHomeAssistantDeviceActionObserver({
    store,
    deviceInventory,
    timeZone: "Asia/Shanghai",
  });
  return { store, observer, devices };
}

function event(day, suffix, value = 24) {
  return {
    event_type: "ha_user_service_action",
    trusted_source: "ha_call_service_context",
    event_id: suffix.padEnd(64, "0"),
    entity_id: "climate.bedroom",
    domain: "climate",
    action: "set_temperature",
    value,
    occurred_at: `${day}T16:00:00Z`,
  };
}

test("HA 手动调温学习需要独立授权、已核对房间、跨日重复和用户确认", async (t) => {
  const { store, observer } = await setup(t);
  const noConsent = await observer.observe(event("2026-09-20", "a"));
  assert.equal(noConsent.accepted, false);
  assert.equal(noConsent.ignored_reason, "DEVICE_OBSERVATION_CONSENT_REQUIRED");
  assert.deepEqual(await store.listMemories({ includePending: true }), []);

  await store.setDeviceActionObservationConsent({ enabled: true, user_explicit_confirmation: true });
  const results = [];
  results.push(await observer.observe(event("2026-09-20", "b")));
  results.push(await observer.observe(event("2026-09-21", "c")));
  assert.equal(results[0].observation_date, "2026-09-21");
  assert.equal(results[0].memory.status, "observing");
  assert.equal(results[1].memory.observation_count, 2);
  assert.equal(await store.getPreference({ memory_type: "comfort_temperature_c", room_id: "bedroom" }), null);

  const third = await observer.observe(event("2026-09-22", "d"));
  assert.equal(third.memory.status, "pending_confirmation");
  assert.equal(third.memory.scope.room_id, "bedroom");
  assert.equal(third.user_id_stored, false);
  assert.equal(third.device_id_stored, false);
  assert.equal(third.raw_event_stored, false);
  const serialized = JSON.stringify(await store.listMemories({ includePending: true }));
  assert.equal(serialized.includes("climate.bedroom"), false);
  assert.equal(serialized.includes("person-name"), false);

  const confirmationDenied = await store.confirmCandidate(third.memory.memory_id);
  assert.equal(confirmationDenied.error.code, "USER_CONFIRMATION_REQUIRED");
  await store.confirmCandidate(third.memory.memory_id, { user_confirmed: true });
  assert.equal((await store.getPreference({ memory_type: "comfort_temperature_c", room_id: "bedroom" })).value, 24);

  const reopened = new PreferenceMemoryStore({ filePath: store.filePath });
  assert.equal((await reopened.getPreference({ memory_type: "comfort_temperature_c", room_id: "bedroom" })).value, 24);
});

test("没有显式确认房间的设备不参与跨房间偏好学习", async (t) => {
  const { store, observer } = await setup(t, { reviewed: false });
  await store.setDeviceActionObservationConsent({ enabled: true, user_explicit_confirmation: true });
  const result = await observer.observe(event("2026-09-20", "e"));
  assert.equal(result.ignored_reason, "DEVICE_OR_ROOM_NOT_REVIEWED");
  assert.deepEqual(await store.listMemories({ includePending: true }), []);
});

test("撤回设备观察授权后不再记录，且清除该来源的推断记忆", async (t) => {
  const { store, observer } = await setup(t);
  await store.setDeviceActionObservationConsent({ enabled: true, user_explicit_confirmation: true });
  await observer.observe(event("2026-09-20", "f"));
  const revoked = await store.setDeviceActionObservationConsent({ enabled: false, user_explicit_confirmation: true });
  assert.equal(revoked.deleted_inferred_memory_count, 1);
  assert.equal((await observer.observe(event("2026-09-21", "g"))).ignored_reason, "DEVICE_OBSERVATION_CONSENT_REQUIRED");
  assert.deepEqual(await store.listMemories({ includePending: true }), []);
});

test("真实 HA 适配摘要的温度轻微波动会聚为 0.5°C 档，但原始观测值不落盘", async (t) => {
  const { store, observer } = await setup(t);
  await store.setDeviceActionObservationConsent({ enabled: true, user_explicit_confirmation: true });

  let candidate;
  for (const [day, suffix, value] of [
    ["2026-09-20", "1", 23.76],
    ["2026-09-21", "2", 24.1],
    ["2026-09-22", "3", 24.24],
  ]) {
    const result = await observer.observe(event(day, suffix, value));
    candidate = result.memory;
  }

  assert.equal(candidate.status, "pending_confirmation");
  assert.equal(candidate.value, 24);
  const saved = JSON.parse(await fs.readFile(store.filePath, "utf8"));
  assert.deepEqual(saved.memories.map(({ value }) => value), [24]);
  assert.equal(Object.hasOwn(saved.memories[0], "observed_values"), false);
});
