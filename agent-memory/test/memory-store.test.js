import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PreferenceMemoryStore } from "../src/memory-store.js";

async function createStore(t, options = {}) {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-family-memory-"));
  t.after(() => fs.rm(tempDirectory, { recursive: true, force: true }));
  return new PreferenceMemoryStore({ filePath: path.join(tempDirectory, "preferences.json"), ...options });
}

test("只把用户明确要求长期记住的有效偏好保存到本地", async (t) => {
  let now = Date.parse("2026-09-24T08:00:00.000Z");
  const store = await createStore(t, { clock: () => now });
  const noConsent = await store.saveExplicitPreference({
    memory_type: "comfort_temperature_c",
    value: 25,
  });
  assert.equal(noConsent.success, false);
  assert.equal(noConsent.error.code, "EXPLICIT_INTENT_REQUIRED");

  const saved = await store.saveExplicitPreference({
    memory_type: "comfort_temperature_c",
    value: 25,
    room_id: "bedroom",
    subject_id: "household",
    user_explicit_request: true,
    raw_text: "这段聊天正文不应写入记忆文件",
  });
  assert.equal(saved.success, true);
  assert.equal(saved.memory.status, "confirmed");
  assert.equal(saved.memory.unit, "°C");
  assert.equal(saved.memory.source, "user_explicit");
  assert.equal((await store.getPreference({ memory_type: "comfort_temperature_c", room_id: "bedroom" })).value, 25);

  now += 1000;
  const updated = await store.saveExplicitPreference({
    memory_type: "comfort_temperature_c",
    value: 26,
    room_id: "bedroom",
    user_explicit_request: true,
  });
  assert.equal(updated.memory.memory_id, saved.memory.memory_id);
  assert.equal((await store.getPreference({ memory_type: "comfort_temperature_c", room_id: "bedroom" })).value, 26);

  const contents = await fs.readFile(store.filePath, "utf8");
  assert.doesNotMatch(contents, /raw_text|这段聊天正文/);
});

test("习惯推测只在同意后形成待确认候选，确认前不会成为可用偏好", async (t) => {
  const store = await createStore(t, { clock: () => Date.parse("2026-09-24T08:00:00.000Z") });
  const withoutConsent = await store.proposeInferredCandidate({
    memory_type: "sleep_time",
    value: "22:30",
    event_id: "evt-routine-1",
    confidence: 0.95,
  });
  assert.equal(withoutConsent.error.code, "MEMORY_CONSENT_REQUIRED");

  const lowConfidence = await store.proposeInferredCandidate({
    memory_type: "sleep_time",
    value: "22:30",
    event_id: "evt-routine-1",
    observation_date: "2026-09-21",
    time_zone: "Asia/Shanghai",
    confidence: 0.6,
    consent_to_observe: true,
  });
  assert.equal(lowConfidence.error.code, "LOW_CONFIDENCE");

  const first = await store.proposeInferredCandidate({
    memory_type: "sleep_time",
    value: "22:30",
    event_id: "evt-routine-1",
    observation_date: "2026-09-21",
    time_zone: "Asia/Shanghai",
    confidence: 0.9,
    consent_to_observe: true,
  });
  const duplicate = await store.proposeInferredCandidate({
    memory_type: "sleep_time",
    value: "22:30",
    event_id: "evt-routine-1",
    observation_date: "2026-09-21",
    time_zone: "Asia/Shanghai",
    confidence: 0.9,
    consent_to_observe: true,
  });
  const sameDay = await store.proposeInferredCandidate({
    memory_type: "sleep_time",
    value: "22:30",
    event_id: "evt-routine-same-day",
    observation_date: "2026-09-21",
    time_zone: "Asia/Shanghai",
    confidence: 0.9,
    consent_to_observe: true,
  });
  const second = await store.proposeInferredCandidate({
    memory_type: "sleep_time",
    value: "22:30",
    event_id: "evt-routine-2",
    observation_date: "2026-09-22",
    time_zone: "Asia/Shanghai",
    confidence: 0.8,
    consent_to_observe: true,
  });
  assert.equal(first.memory.status, "observing");
  assert.equal(duplicate.deduplicated, true);
  assert.equal(sameDay.deduplicated, true);
  assert.equal(second.memory.observation_count, 2);
  assert.equal(second.memory.status, "observing");
  assert.equal(await store.getPreference({ memory_type: "sleep_time", time_zone: "Asia/Shanghai" }), null);

  const third = await store.proposeInferredCandidate({
    memory_type: "sleep_time",
    value: "22:30",
    event_id: "evt-routine-3",
    observation_date: "2026-09-23",
    time_zone: "Asia/Shanghai",
    confidence: 0.85,
    consent_to_observe: true,
  });
  assert.equal(third.memory.observation_count, 3);
  assert.ok(Math.abs(third.memory.confidence - 0.85) < 1e-9);
  assert.equal(third.memory.status, "pending_confirmation");

  const deniedConfirmation = await store.confirmCandidate(first.memory.memory_id);
  assert.equal(deniedConfirmation.error.code, "USER_CONFIRMATION_REQUIRED");
  const confirmed = await store.confirmCandidate(third.memory.memory_id, { user_confirmed: true });
  assert.equal(confirmed.memory.status, "confirmed");
  assert.equal((await store.getPreference({ memory_type: "sleep_time", time_zone: "Asia/Shanghai" })).value, "22:30");
});

test("查询优先采用更具体的房间/日期偏好，并支持通用偏好回退", async (t) => {
  const store = await createStore(t);
  await store.saveExplicitPreference({
    memory_type: "comfort_temperature_c",
    value: 24,
    user_explicit_request: true,
  });
  await store.saveExplicitPreference({
    memory_type: "comfort_temperature_c",
    value: 26,
    room_id: "bedroom",
    user_explicit_request: true,
  });
  await store.saveExplicitPreference({
    memory_type: "wake_time",
    value: "07:30",
    day_type: "weekday",
    time_zone: "Asia/Shanghai",
    user_explicit_request: true,
  });
  assert.equal((await store.getPreference({ memory_type: "comfort_temperature_c", room_id: "bedroom" })).value, 26);
  assert.equal((await store.getPreference({ memory_type: "comfort_temperature_c", room_id: "living_room" })).value, 24);
  assert.equal((await store.getPreference({ memory_type: "wake_time", day_type: "weekday", time_zone: "Asia/Shanghai" })).value, "07:30");
  assert.equal(await store.getPreference({ memory_type: "wake_time", day_type: "weekend", time_zone: "Asia/Shanghai" }), null);
});

test("无效温度/时间和真实身份字符串会被拒绝", async (t) => {
  const store = await createStore(t);
  for (const input of [
    { memory_type: "comfort_temperature_c", value: 35 },
    { memory_type: "sleep_time", value: "晚上十点" },
    { memory_type: "wake_time", value: "07:30", subject_id: "张三" },
  ]) {
    const result = await store.saveExplicitPreference({ ...input, user_explicit_request: true });
    assert.equal(result.success, false);
  }
});

test("候选记忆会过期，用户也能主动删除已确认偏好", async (t) => {
  let now = Date.parse("2026-09-24T08:00:00.000Z");
  const store = await createStore(t, { clock: () => now, candidateTtlMs: 1000 });
  const candidate = await store.proposeInferredCandidate({
    memory_type: "wake_time",
    value: "07:00",
    event_id: "evt-wake-1",
    observation_date: "2026-09-21",
    time_zone: "Asia/Shanghai",
    confidence: 0.9,
    consent_to_observe: true,
  });
  now += 1001;
  assert.equal(await store.confirmCandidate(candidate.memory.memory_id, { user_confirmed: true }).then((result) => result.success), false);
  assert.deepEqual(await store.purgeExpired(), { success: true, deleted_count: 1 });

  const saved = await store.saveExplicitPreference({
    memory_type: "wake_time",
    value: "07:00",
    time_zone: "Asia/Shanghai",
    user_explicit_request: true,
  });
  assert.equal((await store.deleteMemory(saved.memory.memory_id)).deleted, true);
  assert.equal(await store.getPreference({ memory_type: "wake_time", time_zone: "Asia/Shanghai" }), null);
});

test("另一写入者持有文件锁时拒绝修改，正常写入后释放自己的锁", async (t) => {
  const store = await createStore(t);
  const lockPath = `${store.filePath}.lock`;
  await fs.writeFile(lockPath, JSON.stringify({ token: "another-writer", pid: 1234 }), "utf8");

  const blocked = await store.saveExplicitPreference({
    memory_type: "comfort_temperature_c",
    value: 25,
    user_explicit_request: true,
  });
  assert.equal(blocked.success, false);
  assert.equal(blocked.error.code, "MEMORY_STORE_LOCKED");
  await assert.rejects(fs.access(store.filePath), { code: "ENOENT" });
  assert.equal(JSON.parse(await fs.readFile(lockPath, "utf8")).token, "another-writer");
  await assert.rejects(store.listMemories({ includePending: true }), { code: "MEMORY_STORE_LOCKED" });

  await fs.rm(lockPath);
  const saved = await store.saveExplicitPreference({
    memory_type: "comfort_temperature_c",
    value: 25,
    user_explicit_request: true,
  });
  assert.equal(saved.success, true);
  await assert.rejects(fs.access(lockPath), { code: "ENOENT" });
});
