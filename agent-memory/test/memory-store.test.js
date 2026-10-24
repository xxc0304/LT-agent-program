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

test("Windows rename 返回 EPERM 时首次写入和更新都走安全回退", async (t) => {
  const store = await createStore(t, {
    rename: async () => {
      const error = new Error("rename is not permitted in this filesystem");
      error.code = "EPERM";
      throw error;
    },
  });
  const firstWrite = await store.saveExplicitPreference({
    memory_type: "comfort_temperature_c",
    value: 24,
    user_explicit_request: true,
  });
  assert.equal(firstWrite.success, true);
  assert.equal(firstWrite.memory.confidence_semantics, "explicit_user_assertion");
  assert.equal((await store.getPreference({ memory_type: "comfort_temperature_c" })).value, 24);

  const update = await store.saveExplicitPreference({
    memory_type: "comfort_temperature_c",
    value: 25,
    user_explicit_request: true,
  });
  assert.equal(update.success, true);
  assert.equal((await store.getPreference({ memory_type: "comfort_temperature_c" })).value, 25);
  assert.equal(JSON.parse(await fs.readFile(store.filePath, "utf8")).memories.length, 1);
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

  const callerClaimedConsent = await store.proposeInferredCandidate({
    memory_type: "sleep_time",
    value: "22:30",
    event_id: "evt-untrusted-consent",
    observation_date: "2026-09-21",
    time_zone: "Asia/Shanghai",
    confidence: 0.95,
    consent_to_observe: true,
  });
  assert.equal(callerClaimedConsent.error.code, "MEMORY_CONSENT_REQUIRED");

  const enabled = await store.setObservationConsent({ enabled: true, user_explicit_confirmation: true });
  assert.equal(enabled.success, true);
  assert.equal((await store.getObservationConsent()).enabled, true);

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
  assert.equal(third.memory.confidence_semantics, "mean_input_observation_confidence");
  assert.equal(third.memory.status, "pending_confirmation");

  const deniedConfirmation = await store.confirmCandidate(first.memory.memory_id);
  assert.equal(deniedConfirmation.error.code, "USER_CONFIRMATION_REQUIRED");
  const confirmed = await store.confirmCandidate(third.memory.memory_id, { user_confirmed: true });
  assert.equal(confirmed.memory.status, "confirmed");
  assert.equal((await store.getPreference({ memory_type: "sleep_time", time_zone: "Asia/Shanghai" })).value, "22:30");
});

test("同一偏好范围出现不同数值时进入冲突待处理，用户选择后只保留所选候选", async (t) => {
  const store = await createStore(t);
  await store.setDeviceActionObservationConsent({ enabled: true, user_explicit_confirmation: true });
  const observe = (value, event_id, observation_date) => store.proposeInferredCandidate({
    memory_type: "comfort_temperature_c",
    value,
    room_id: "bedroom",
    observation_scope: "device_action",
    event_id,
    observation_date,
    confidence: 0.9,
    consent_to_observe: true,
  });

  await observe(24, "temp-24-1", "2026-09-21");
  const competing = await observe(26, "temp-26-1", "2026-09-21");
  assert.equal(competing.conflict_detected, true);
  assert.equal(competing.memory.status, "conflict_review");
  assert.equal(competing.conflicting_candidates[0].value, 24);
  await observe(24, "temp-24-2", "2026-09-22");
  const thirdDay = await observe(24, "temp-24-3", "2026-09-23");
  assert.equal(thirdDay.memory.observation_count, 3);
  assert.equal(thirdDay.memory.status, "conflict_review", "出现分歧后不能自动降为可确认状态");
  const conflictedPreference = await store.getPreference({ memory_type: "comfort_temperature_c", room_id: "bedroom" });
  assert.equal(conflictedPreference.status, "conflict_review");
  assert.deepEqual(conflictedPreference.candidates.map(({ value }) => value), [24, 26]);

  const [selected] = (await store.listMemories({ includePending: true }))
    .filter((memory) => memory.value === 24);
  const confirmation = await store.confirmCandidate(selected.memory_id, { user_confirmed: true });
  assert.equal(confirmation.success, true);
  assert.equal(confirmation.resolved_conflict_count, 1);
  assert.equal((await store.getPreference({ memory_type: "comfort_temperature_c", room_id: "bedroom" })).value, 24);
  assert.deepEqual((await store.listMemories({ includePending: true })).map(({ value }) => value), [24]);
});

test("用户明确保存偏好值可解决冲突并清除同范围的观察候选", async (t) => {
  const store = await createStore(t);
  await store.setDeviceActionObservationConsent({ enabled: true, user_explicit_confirmation: true });
  const observe = (value, event_id) => store.proposeInferredCandidate({
    memory_type: "comfort_temperature_c",
    value,
    room_id: "bedroom",
    observation_scope: "device_action",
    event_id,
    observation_date: "2026-09-21",
    confidence: 0.9,
    consent_to_observe: true,
  });
  await observe(24, "override-24");
  await observe(26, "override-26");

  const saved = await store.saveExplicitPreference({
    memory_type: "comfort_temperature_c",
    value: 25,
    room_id: "bedroom",
    user_explicit_request: true,
  });
  assert.equal(saved.success, true);
  assert.equal((await store.listMemories({ includePending: true })).length, 1);
  assert.equal((await store.getPreference({ memory_type: "comfort_temperature_c", room_id: "bedroom" })).value, 25);
});

test("新观察与已确认偏好不同也进入冲突待处理，用户确认后才替换旧值", async (t) => {
  const store = await createStore(t);
  await store.saveExplicitPreference({
    memory_type: "comfort_temperature_c",
    value: 24,
    room_id: "bedroom",
    user_explicit_request: true,
  });
  await store.setDeviceActionObservationConsent({ enabled: true, user_explicit_confirmation: true });
  const observe = (event_id, observation_date) => store.proposeInferredCandidate({
    memory_type: "comfort_temperature_c",
    value: 26,
    room_id: "bedroom",
    observation_scope: "device_action",
    event_id,
    observation_date,
    confidence: 0.9,
    consent_to_observe: true,
  });

  await observe("changed-1", "2026-09-21");
  await observe("changed-2", "2026-09-22");
  const candidate = await observe("changed-3", "2026-09-23");
  assert.equal(candidate.memory.status, "conflict_review");
  assert.equal(candidate.conflicting_candidates[0].value, 24);
  const conflictedPreference = await store.getPreference({ memory_type: "comfort_temperature_c", room_id: "bedroom" });
  assert.equal(conflictedPreference.status, "conflict_review");
  assert.deepEqual(conflictedPreference.candidates.map(({ value }) => value), [24, 26]);

  const confirmation = await store.confirmCandidate(candidate.memory.memory_id, { user_confirmed: true });
  assert.equal(confirmation.success, true);
  assert.equal(confirmation.resolved_conflict_count, 1);
  assert.equal((await store.getPreference({ memory_type: "comfort_temperature_c", room_id: "bedroom" })).value, 26);
});

test("更具体房间的冲突会阻止回退到全屋已确认值，但不影响其他房间", async (t) => {
  const store = await createStore(t);
  await store.saveExplicitPreference({
    memory_type: "comfort_temperature_c",
    value: 22,
    user_explicit_request: true,
  });
  await store.setDeviceActionObservationConsent({ enabled: true, user_explicit_confirmation: true });
  const observe = (value, event_id) => store.proposeInferredCandidate({
    memory_type: "comfort_temperature_c",
    value,
    room_id: "bedroom",
    observation_scope: "device_action",
    event_id,
    observation_date: "2026-09-21",
    confidence: 0.9,
    consent_to_observe: true,
  });
  await observe(24, "bedroom-24");
  await observe(26, "bedroom-26");

  const bedroom = await store.getPreference({ memory_type: "comfort_temperature_c", room_id: "bedroom" });
  const livingRoom = await store.getPreference({ memory_type: "comfort_temperature_c", room_id: "living_room" });
  assert.equal(bedroom.status, "conflict_review");
  assert.deepEqual(bedroom.candidates.map(({ value }) => value), [24, 26]);
  assert.equal(livingRoom.value, 22);
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
    { memory_type: "comfort_brightness_pct", value: 101 },
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
  await store.setObservationConsent({ enabled: true, user_explicit_confirmation: true });
  const reopened = new PreferenceMemoryStore({ filePath: store.filePath });
  assert.equal((await reopened.getObservationConsent()).enabled, true);
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

test("观察授权持久化；撤回授权删除推断记忆但保留用户明确保存的偏好", async (t) => {
  const store = await createStore(t);
  await store.saveExplicitPreference({
    memory_type: "comfort_temperature_c",
    value: 24,
    user_explicit_request: true,
  });
  const refused = await store.setObservationConsent({ enabled: true, user_explicit_confirmation: false });
  assert.equal(refused.error.code, "EXPLICIT_CONSENT_REQUIRED");
  assert.equal((await store.getObservationConsent()).enabled, false);

  await store.setObservationConsent({ enabled: true, user_explicit_confirmation: true });
  const candidate = await store.proposeInferredCandidate({
    memory_type: "sleep_time",
    value: "22:30",
    event_id: "consent-revoke-1",
    observation_date: "2026-09-21",
    time_zone: "Asia/Shanghai",
    confidence: 0.9,
    consent_to_observe: true,
  });
  await store.proposeInferredCandidate({
    memory_type: "sleep_time",
    value: "22:30",
    event_id: "consent-revoke-2",
    observation_date: "2026-09-22",
    time_zone: "Asia/Shanghai",
    confidence: 0.9,
    consent_to_observe: true,
  });
  const confirmed = await store.proposeInferredCandidate({
    memory_type: "sleep_time",
    value: "22:30",
    event_id: "consent-revoke-3",
    observation_date: "2026-09-23",
    time_zone: "Asia/Shanghai",
    confidence: 0.9,
    consent_to_observe: true,
  });
  await store.confirmCandidate(confirmed.memory.memory_id, { user_confirmed: true });

  const revoked = await store.setObservationConsent({ enabled: false, user_explicit_confirmation: true });
  assert.equal(revoked.deleted_inferred_memory_count, 1);
  assert.equal((await store.getObservationConsent()).enabled, false);
  assert.equal((await store.listMemories({ includePending: true })).length, 1);
  assert.equal((await store.getPreference({ memory_type: "comfort_temperature_c" })).value, 24);
  const denied = await store.proposeInferredCandidate({
    memory_type: "sleep_time",
    value: "22:30",
    event_id: "consent-revoke-4",
    observation_date: "2026-09-24",
    time_zone: "Asia/Shanghai",
    confidence: 0.9,
    consent_to_observe: true,
  });
  assert.equal(denied.error.code, "MEMORY_CONSENT_REQUIRED");
  assert.equal(candidate.success, true);
});

test("作息提醒授权独立、默认关闭、需要当前明确同意且可跨重启撤回", async (t) => {
  const store = await createStore(t);
  assert.equal((await store.getRoutineReminderConsent()).enabled, false);

  const denied = await store.setRoutineReminderConsent({ enabled: true, user_explicit_confirmation: false });
  assert.equal(denied.error.code, "EXPLICIT_CONSENT_REQUIRED");
  assert.equal((await store.getRoutineReminderConsent()).enabled, false);

  const preference = await store.saveExplicitPreference({
    memory_type: "sleep_time",
    value: "22:30",
    time_zone: "Asia/Shanghai",
    day_type: "weekday",
    user_explicit_request: true,
  });
  const enabled = await store.setRoutineReminderConsent({ enabled: true, user_explicit_confirmation: true });
  assert.equal(enabled.enabled, true);
  assert.equal((await store.getRoutineReminderConsent()).scope, "confirmed_routine_reminders_only");

  const reopened = new PreferenceMemoryStore({ filePath: store.filePath });
  assert.equal((await reopened.getRoutineReminderConsent()).enabled, true);
  const revoked = await reopened.setRoutineReminderConsent({ enabled: false, user_explicit_confirmation: true });
  assert.equal(revoked.enabled, false);
  assert.equal((await store.getRoutineReminderConsent()).enabled, false);
  assert.equal((await store.getPreference({ memory_type: "sleep_time", time_zone: "Asia/Shanghai", day_type: "weekday" })).memory_id,
    preference.memory.memory_id, "撤回提醒授权不删除已确认作息偏好");
  assert.equal((await reopened.getObservationConsent()).enabled, false, "提醒授权不等于作息观察授权");
});

test("0.2 版迁移后观察授权默认关闭，旧待确认推断候选必须重新采集", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-family-memory-v02-migration-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "preferences.json");
  await fs.writeFile(filePath, JSON.stringify({
    schema_version: "0.2",
    memories: [{
      memory_id: "legacy-v02-candidate",
      memory_type: "sleep_time",
      value: "22:30",
      subject_id: "household",
      scope: { time_zone: "Asia/Shanghai" },
      status: "pending_confirmation",
      source: "repeated_observation_unconfirmed",
      evidence_event_ids: ["evt-1", "evt-2", "evt-3"],
      evidence_dates: ["2026-09-21", "2026-09-22", "2026-09-23"],
      observation_count: 3,
      confidence: 0.9,
      expires_at: null,
    }],
  }));
  const store = new PreferenceMemoryStore({ filePath });
  assert.equal((await store.getObservationConsent()).enabled, false);
  assert.equal((await store.getDeviceActionObservationConsent()).enabled, false);
  assert.equal((await store.getRoutineReminderConsent()).enabled, false);
  const [candidate] = await store.listMemories({ includePending: true });
  assert.equal(candidate.legacy_requires_reobservation, true);
  const confirmation = await store.confirmCandidate(candidate.memory_id, { user_confirmed: true });
  assert.equal(confirmation.error.code, "CANDIDATE_REQUIRES_REOBSERVATION");
});

test("0.3 版迁移保留既有授权，新增灯光亮度偏好并以百分比保存", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-family-memory-v03-migration-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "preferences.json");
  await fs.writeFile(filePath, JSON.stringify({
    schema_version: "0.3",
    settings: { behavior_observation_enabled: true, device_action_observation_enabled: false },
    memories: [],
  }));

  const store = new PreferenceMemoryStore({ filePath });
  assert.equal((await store.getObservationConsent()).enabled, true);
  assert.equal((await store.getDeviceActionObservationConsent()).enabled, false);
  const saved = await store.saveExplicitPreference({
    memory_type: "comfort_brightness_pct",
    value: 65,
    room_id: "living_room",
    user_explicit_request: true,
  });
  assert.equal(saved.success, true);
  assert.equal(saved.memory.unit, "%");
  assert.equal((await store.getPreference({ memory_type: "comfort_brightness_pct", room_id: "living_room" })).value, 65);
  assert.equal(JSON.parse(await fs.readFile(filePath, "utf8")).schema_version, "0.6");
});

test("0.4 版迁移保留记忆和授权，并区分数值来源语义", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-family-memory-v04-migration-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "preferences.json");
  await fs.writeFile(filePath, JSON.stringify({
    schema_version: "0.4",
    settings: { behavior_observation_enabled: true, device_action_observation_enabled: false },
    memories: [
      {
        memory_id: "legacy-explicit",
        memory_type: "comfort_temperature_c",
        value: 24,
        subject_id: "household",
        scope: {},
        status: "confirmed",
        source: "user_explicit",
        confidence: 1,
        consent: "explicit",
        evidence_event_ids: [],
        observation_count: 0,
      },
      {
        memory_id: "legacy-inferred",
        memory_type: "comfort_brightness_pct",
        value: 65,
        subject_id: "household",
        scope: {},
        status: "confirmed",
        source: "repeated_observation_user_confirmed",
        confidence: 0.9,
        consent: "user_confirmed",
        evidence_event_ids: ["event-1", "event-2", "event-3"],
        observation_count: 3,
      },
    ],
  }));

  const store = new PreferenceMemoryStore({ filePath });
  assert.equal((await store.getObservationConsent()).enabled, true);
  const memories = await store.listMemories({ includePending: true });
  assert.equal(memories.find(({ memory_id }) => memory_id === "legacy-explicit").confidence_semantics, "explicit_user_assertion");
  assert.equal(memories.find(({ memory_id }) => memory_id === "legacy-inferred").confidence_semantics,
    "mean_input_observation_confidence");
  assert.equal(JSON.parse(await fs.readFile(filePath, "utf8")).schema_version, "0.4",
    "只读迁移不改写原文件；下次正常写入才会保存新版本");
});

test("0.5 版中已有的不同值候选在确认时被识别为冲突", async (t) => {
  const store = await createStore(t);
  const document = {
    schema_version: "0.5",
    settings: { device_action_observation_enabled: true },
    memories: [24, 26].map((value) => ({
      memory_id: `legacy-${value}`,
      memory_type: "comfort_temperature_c",
      value,
      subject_id: "household",
      scope: { room_id: "bedroom" },
      status: "pending_confirmation",
      source: "repeated_observation_unconfirmed",
      observation_scope: "device_action",
      confidence: 0.9,
      consent: "observation_opt_in",
      evidence_event_ids: [`${value}-1`, `${value}-2`, `${value}-3`],
      evidence_dates: ["2026-09-21", "2026-09-22", "2026-09-23"],
      observation_count: 3,
      expires_at: null,
    })),
  };
  await fs.writeFile(store.filePath, JSON.stringify(document));

  const firstAttempt = await store.confirmCandidate("legacy-24", { user_confirmed: true });
  assert.equal(firstAttempt.error.code, "CONFLICTING_CANDIDATES");
  assert.deepEqual(firstAttempt.conflicting_candidates.map(({ value }) => value), [24, 26]);
  assert.deepEqual((await store.listMemories({ includePending: true })).map(({ status }) => status), [
    "conflict_review",
    "conflict_review",
  ]);

  const selected = await store.confirmCandidate("legacy-24", { user_confirmed: true });
  assert.equal(selected.success, true);
  assert.equal(selected.resolved_conflict_count, 1);
  assert.equal((await store.getPreference({ memory_type: "comfort_temperature_c", room_id: "bedroom" })).value, 24);
  assert.equal(JSON.parse(await fs.readFile(store.filePath, "utf8")).schema_version, "0.6");
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
