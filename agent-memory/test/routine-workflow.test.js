import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PreferenceMemoryStore } from "../src/memory-store.js";
import { createRoutineMemoryWorkflow } from "../src/routine-workflow.js";

async function createWorkflow(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-routine-workflow-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new PreferenceMemoryStore({ filePath: path.join(directory, "memory.json") });
  return { store, workflow: createRoutineMemoryWorkflow({ store }) };
}

function routineEvent({ event_id, day, consent_to_observe = true, occurred_at, ...overrides }) {
  return {
    event_type: "routine_observation",
    event_id,
    occurred_at: occurred_at ?? `${day}T14:30:00Z`,
    routine_type: "sleep_time",
    observed_time: "22:30",
    confidence: 0.9,
    time_zone: "Asia/Shanghai",
    consent_to_observe,
    ...overrides,
  };
}

test("没有明确观察同意或有效来源字段时不写入习惯候选", async (t) => {
  const { workflow, store } = await createWorkflow(t);
  const noConsent = await workflow.observe(routineEvent({ event_id: "evt-no-consent", day: "2026-09-21", consent_to_observe: false }));
  assert.equal(noConsent.error.code, "MEMORY_CONSENT_REQUIRED");

  const invalidType = await workflow.observe(routineEvent({ event_id: "evt-wrong-type", day: "2026-09-21", event_type: "device_state_changed" }));
  assert.equal(invalidType.error.code, "UNSUPPORTED_EVENT_TYPE");

  const invalidZone = await workflow.observe(routineEvent({ event_id: "evt-wrong-zone", day: "2026-09-21", time_zone: "Not/AZone" }));
  assert.equal(invalidZone.error.code, "INVALID_TIME_ZONE");
  assert.deepEqual(await store.listMemories({ includePending: true }), []);
});

test("只按三个不同本地日期形成候选，确认后只生成提醒预览而不安排或控制设备", async (t) => {
  const { workflow, store } = await createWorkflow(t);
  const first = await workflow.observe(routineEvent({ event_id: "evt-sleep-1", day: "2026-09-21" }));
  const duplicateSameDay = await workflow.observe(routineEvent({ event_id: "evt-sleep-1b", day: "2026-09-21", occurred_at: "2026-09-21T15:00:00Z" }));
  const second = await workflow.observe(routineEvent({ event_id: "evt-sleep-2", day: "2026-09-22", observed_time: "22:34" }));

  assert.equal(first.memory.status, "observing");
  assert.equal(duplicateSameDay.deduplicated, true);
  assert.equal(duplicateSameDay.duplicate_reason, "OBSERVATION_DATE_ALREADY_COUNTED");
  assert.equal(second.observed_time_bucket, "22:30");
  assert.equal(second.memory.observation_count, 2);
  assert.equal(await store.getPreference({ memory_type: "sleep_time", time_zone: "Asia/Shanghai" }), null);

  const third = await workflow.observe(routineEvent({ event_id: "evt-sleep-3", day: "2026-09-23" }));
  assert.equal(third.memory.status, "pending_confirmation");
  assert.deepEqual(third.memory.evidence_dates, ["2026-09-21", "2026-09-22", "2026-09-23"]);

  const unconfirmedPreview = await workflow.previewRoutine({ routine_type: "sleep_time", time_zone: "Asia/Shanghai" });
  assert.equal(unconfirmedPreview.status, "NO_CONFIRMED_PREFERENCE");
  const confirmed = await workflow.confirm(third.memory.memory_id, { user_confirmed: true });
  assert.equal(confirmed.memory.status, "confirmed");

  const preview = await workflow.previewRoutine({ routine_type: "sleep_time", day_type: "weekday", time_zone: "Asia/Shanghai" });
  assert.equal(preview.status, "PREVIEW_ONLY");
  assert.equal(preview.suggestion.local_time, "22:30");
  assert.equal(preview.suggestion.time_zone, "Asia/Shanghai");
  assert.equal(preview.suggestion.proposed_action, "notify_user");
  assert.equal(preview.suggestion.requires_separate_user_authorization_to_schedule, true);
  assert.equal(preview.execution_performed, false);
  assert.equal(preview.automation_enabled, false);

  const reopenedStore = new PreferenceMemoryStore({ filePath: store.filePath });
  const afterRestart = await createRoutineMemoryWorkflow({ store: reopenedStore })
    .previewRoutine({ routine_type: "sleep_time", day_type: "weekday", time_zone: "Asia/Shanghai" });
  assert.equal(afterRestart.status, "PREVIEW_ONLY");
  assert.equal(afterRestart.suggestion.local_time, "22:30");
});

test("时间候选按周内/周末分组，且预览必须指定匹配时区", async (t) => {
  const { workflow } = await createWorkflow(t);
  const saturday = await workflow.observe(routineEvent({ event_id: "evt-weekend", day: "2026-09-26" }));
  assert.equal(saturday.memory.scope.day_type, "weekend");
  assert.equal(saturday.memory.scope.time_zone, "Asia/Shanghai");

  const missingZone = await workflow.previewRoutine({ routine_type: "sleep_time" });
  assert.equal(missingZone.error.code, "INVALID_TIME_ZONE");
  assert.equal((await workflow.previewRoutine({ routine_type: "sleep_time", time_zone: "Asia/Tokyo" })).status, "NO_CONFIRMED_PREFERENCE");
});

test("0.1 版未确认候选被保留但必须重新收集不同日期证据", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-routine-migration-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "memory.json");
  await fs.writeFile(filePath, JSON.stringify({
    schema_version: "0.1",
    memories: [{
      memory_id: "legacy-pending",
      memory_type: "sleep_time",
      value: "22:30",
      subject_id: "household",
      scope: {},
      status: "pending_confirmation",
      source: "repeated_observation_unconfirmed",
      evidence_event_ids: ["old-1", "old-2", "old-3"],
      observation_count: 3,
      confidence: 0.9,
      expires_at: null,
    }],
  }));

  const store = new PreferenceMemoryStore({ filePath });
  const old = await store.listMemories({ includePending: true });
  assert.equal(old[0].legacy_requires_reobservation, true);
  const refused = await store.confirmCandidate("legacy-pending", { user_confirmed: true });
  assert.equal(refused.error.code, "CANDIDATE_REQUIRES_REOBSERVATION");
  const disk = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.equal(disk.schema_version, "0.2");
  assert.equal(disk.memories[0].evidence_event_ids.length, 3);
});
