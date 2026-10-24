import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PreferenceMemoryStore } from "../src/memory-store.js";
import { createMockDeviceBehaviorObserver } from "../src/mock-device-behavior.js";

async function createObserver(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-mock-device-memory-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new PreferenceMemoryStore({ filePath: path.join(directory, "memory.json") });
  return { store, observer: createMockDeviceBehaviorObserver({ store }) };
}

function deviceEvent({ event_id, day, actor_source = "user_manual", ...overrides }) {
  return {
    event_type: "mock_device_action",
    origin: "mock",
    event_id,
    occurred_at: `${day}T20:00:00+08:00`,
    actor_source,
    device_id: "climate.bedroom",
    domain: "climate",
    action: "set_temperature",
    temperature_c: 25,
    room_id: "bedroom",
    time_zone: "Asia/Shanghai",
    ...overrides,
  };
}

test("设备操作观察有独立且默认关闭的授权，不借用作息授权", async (t) => {
  const { store, observer } = await createObserver(t);
  assert.equal((await store.getObservationConsent()).enabled, false);
  assert.equal((await store.getDeviceActionObservationConsent()).enabled, false);

  const denied = await observer.observe(deviceEvent({ event_id: "no-consent", day: "2026-10-01" }));
  assert.equal(denied.error.code, "DEVICE_OBSERVATION_CONSENT_REQUIRED");
  assert.deepEqual(await store.listMemories({ includePending: true }), []);

  assert.equal((await store.setObservationConsent({ enabled: true, user_explicit_confirmation: true })).success, true);
  const stillDenied = await observer.observe(deviceEvent({ event_id: "routine-consent-only", day: "2026-10-01" }));
  assert.equal(stillDenied.error.code, "DEVICE_OBSERVATION_CONSENT_REQUIRED");
  assert.equal((await store.setDeviceActionObservationConsent({ enabled: true, user_explicit_confirmation: true })).success, true);

  const accepted = await observer.observe(deviceEvent({ event_id: "device-consent", day: "2026-10-01" }));
  assert.equal(accepted.success, true);
  assert.equal(accepted.memory.observation_scope, "device_action");
  assert.equal(accepted.memory.observation_count, 1);
});

test("只累计 Mock 中可归因的手动空调调温；三天后经确认才成为偏好", async (t) => {
  const { store, observer } = await createObserver(t);
  await store.setDeviceActionObservationConsent({ enabled: true, user_explicit_confirmation: true });

  const automation = await observer.observe(deviceEvent({ event_id: "automation", day: "2026-10-01", actor_source: "automation" }));
  const agent = await observer.observe(deviceEvent({ event_id: "agent", day: "2026-10-01", actor_source: "agent" }));
  const unknown = await observer.observe(deviceEvent({ event_id: "unknown", day: "2026-10-01", actor_source: "unknown" }));
  assert.equal(automation.accepted, false);
  assert.equal(agent.accepted, false);
  assert.equal(unknown.accepted, false);
  assert.deepEqual(await store.listMemories({ includePending: true }), []);

  const first = await observer.observe(deviceEvent({ event_id: "manual-1", day: "2026-10-01" }));
  const duplicateDay = await observer.observe(deviceEvent({ event_id: "manual-1b", day: "2026-10-01" }));
  const second = await observer.observe(deviceEvent({ event_id: "manual-2", day: "2026-10-02" }));
  assert.equal(first.memory.status, "observing");
  assert.equal(duplicateDay.duplicate_reason, "OBSERVATION_DATE_ALREADY_COUNTED");
  assert.equal(second.memory.observation_count, 2);
  assert.equal(await store.getPreference({ memory_type: "comfort_temperature_c", room_id: "bedroom" }), null);

  const third = await observer.observe(deviceEvent({ event_id: "manual-3", day: "2026-10-03" }));
  assert.equal(third.memory.status, "pending_confirmation");
  assert.deepEqual(third.memory.evidence_dates, ["2026-10-01", "2026-10-02", "2026-10-03"]);
  assert.equal(await store.getPreference({ memory_type: "comfort_temperature_c", room_id: "bedroom" }), null);

  const confirmed = await store.confirmCandidate(third.memory.memory_id, { user_confirmed: true });
  assert.equal(confirmed.memory.status, "confirmed");
  assert.equal(confirmed.memory.observation_scope, "device_action");
  assert.equal((await store.getPreference({ memory_type: "comfort_temperature_c", room_id: "bedroom" })).value, 25);
});

test("拒绝真实 HA 来源和不受支持的操作，撤回设备授权只清理设备行为推断", async (t) => {
  const { store, observer } = await createObserver(t);
  await store.setDeviceActionObservationConsent({ enabled: true, user_explicit_confirmation: true });

  const realHa = await observer.observe(deviceEvent({ event_id: "ha-state", day: "2026-10-01", origin: "home-assistant" }));
  const unsupported = await observer.observe(deviceEvent({ event_id: "light-state", day: "2026-10-01", domain: "light", action: "turn_off" }));
  assert.equal(realHa.error.code, "UNTRUSTED_EVENT_ORIGIN");
  assert.equal(unsupported.error.code, "UNSUPPORTED_DEVICE_ACTION");

  await observer.observe(deviceEvent({ event_id: "manual-1", day: "2026-10-01" }));
  await observer.observe(deviceEvent({ event_id: "manual-2", day: "2026-10-02" }));
  const third = await observer.observe(deviceEvent({ event_id: "manual-3", day: "2026-10-03" }));
  await store.confirmCandidate(third.memory.memory_id, { user_confirmed: true });
  await store.saveExplicitPreference({ memory_type: "comfort_temperature_c", value: 23, user_explicit_request: true });
  await store.setObservationConsent({ enabled: true, user_explicit_confirmation: true });
  await store.proposeInferredCandidate({
    memory_type: "sleep_time",
    value: "22:30",
    event_id: "routine-preserved-on-device-revoke",
    observation_date: "2026-10-04",
    time_zone: "Asia/Shanghai",
    confidence: 0.9,
    observation_scope: "routine",
    consent_to_observe: true,
  });

  const revoked = await store.setDeviceActionObservationConsent({ enabled: false, user_explicit_confirmation: true });
  assert.equal(revoked.deleted_inferred_memory_count, 1);
  assert.equal((await store.getDeviceActionObservationConsent()).enabled, false);
  assert.equal((await store.getObservationConsent()).enabled, true);
  assert.equal((await store.getPreference({ memory_type: "comfort_temperature_c" })).value, 23);
  assert.equal((await store.listMemories({ includePending: true })).some((memory) => memory.observation_scope === "device_action"), false);
  assert.equal((await store.listMemories({ includePending: true })).some((memory) => memory.memory_type === "sleep_time"), true);
});

test("同一观察器也能归纳灯光亮度偏好，但关灯/开灯事件不会被误当成亮度偏好", async (t) => {
  const { store, observer } = await createObserver(t);
  await store.setDeviceActionObservationConsent({ enabled: true, user_explicit_confirmation: true });

  const brightnessEvents = ["2026-10-01", "2026-10-02", "2026-10-03"].map((day, index) => deviceEvent({
    event_id: `brightness-${index + 1}`,
    day,
    device_id: "light.living_room",
    domain: "light",
    action: "set_brightness",
    brightness_pct: 65,
    room_id: "living_room",
  }));
  const observed = [];
  for (const event of brightnessEvents) observed.push(await observer.observe(event));
  assert.equal(observed[2].memory.memory_type, "comfort_brightness_pct");
  assert.equal(observed[2].memory.unit, "%");
  assert.equal(observed[2].memory.status, "pending_confirmation");

  const ambiguousOff = await observer.observe(deviceEvent({
    event_id: "light-off-is-not-brightness",
    day: "2026-10-04",
    device_id: "light.living_room",
    domain: "light",
    action: "turn_off",
    brightness_pct: undefined,
  }));
  assert.equal(ambiguousOff.error.code, "UNSUPPORTED_DEVICE_ACTION");

  const confirmed = await store.confirmCandidate(observed[2].memory.memory_id, { user_confirmed: true });
  assert.equal(confirmed.success, true);
  assert.equal((await store.getPreference({ memory_type: "comfort_brightness_pct", room_id: "living_room" })).value, 65);
});

test("轻微不同的手动温度和亮度设置会先归一到保守档位再累计跨日证据", async (t) => {
  const { store, observer } = await createObserver(t);
  await store.setDeviceActionObservationConsent({ enabled: true, user_explicit_confirmation: true });

  const temperatures = [22.26, 22.34, 22.48];
  let temperatureCandidate;
  for (let index = 0; index < temperatures.length; index += 1) {
    const result = await observer.observe(deviceEvent({
      event_id: `temp-near-${index + 1}`,
      day: `2026-10-0${index + 1}`,
      temperature_c: temperatures[index],
    }));
    temperatureCandidate = result.memory;
  }
  assert.equal(temperatureCandidate.status, "pending_confirmation");
  assert.equal(temperatureCandidate.value, 22.5);
  assert.deepEqual(temperatureCandidate.evidence_dates, ["2026-10-01", "2026-10-02", "2026-10-03"]);

  const brightnessValues = [69, 70, 71];
  let brightnessCandidate;
  for (let index = 0; index < brightnessValues.length; index += 1) {
    const result = await observer.observe(deviceEvent({
      event_id: `brightness-near-${index + 1}`,
      day: `2026-10-0${index + 4}`,
      device_id: "light.living_room",
      domain: "light",
      action: "set_brightness",
      brightness_pct: brightnessValues[index],
      room_id: "living_room",
    }));
    brightnessCandidate = result.memory;
  }
  assert.equal(brightnessCandidate.status, "pending_confirmation");
  assert.equal(brightnessCandidate.value, 70);

  const stored = await store.listMemories({ includePending: true });
  assert.deepEqual(stored.map(({ memory_type, value }) => [memory_type, value]).sort(), [
    ["comfort_brightness_pct", 70],
    ["comfort_temperature_c", 22.5],
  ]);
  assert.equal(Object.hasOwn(stored[0], "observed_values"), false);
});
