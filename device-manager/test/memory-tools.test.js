import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PreferenceMemoryStore } from "../../agent-memory/src/memory-store.js";
import { createHouseholdMemoryTools, HOUSEHOLD_MEMORY_TOOL_DEFINITIONS } from "../src/memory-tools.js";

test("OpenClaw 记忆工具只读已确认偏好，写入/确认/删除均有显式授权门槛", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-memory-tools-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new PreferenceMemoryStore({ filePath: path.join(directory, "preferences.json") });
  const tools = createHouseholdMemoryTools(store);
  const names = HOUSEHOLD_MEMORY_TOOL_DEFINITIONS.map((definition) => definition.name);

  assert.deepEqual(names, [
    "get_household_preference",
    "list_household_memories",
    "remember_household_preference",
    "propose_household_memory_candidate",
    "confirm_household_memory_candidate",
    "preview_household_routine",
    "forget_household_memory",
  ]);

  const deniedWrite = await tools.remember_household_preference({
    memory_type: "comfort_temperature_c",
    value: 26,
    user_explicit_request: false,
  });
  assert.equal(deniedWrite.error.code, "EXPLICIT_INTENT_REQUIRED");

  const saved = await tools.remember_household_preference({
    memory_type: "comfort_temperature_c",
    value: 26,
    room_id: "bedroom",
    user_explicit_request: true,
  });
  assert.equal(saved.memory.value, 26);
  assert.equal((await tools.get_household_preference({ memory_type: "comfort_temperature_c", room_id: "bedroom" })).value, 26);

  for (let index = 1; index <= 3; index += 1) {
    await tools.propose_household_memory_candidate({
      routine_type: "sleep_time",
      observed_time: "22:30",
      occurred_at: `2026-09-${20 + index}T14:30:00Z`,
      event_id: `sleep-${index}`,
      time_zone: "Asia/Shanghai",
      confidence: 0.9,
      consent_to_observe: true,
    });
  }
  assert.equal((await tools.get_household_preference({ memory_type: "sleep_time", time_zone: "Asia/Shanghai" })), null);
  const pending = await tools.list_household_memories({ include_pending: true });
  const candidate = pending.find((memory) => memory.memory_type === "sleep_time");
  assert.equal(candidate.status, "pending_confirmation");

  const notConfirmed = await tools.confirm_household_memory_candidate({ memory_id: candidate.memory_id, user_confirmed: false });
  assert.equal(notConfirmed.error.code, "USER_CONFIRMATION_REQUIRED");
  await tools.confirm_household_memory_candidate({ memory_id: candidate.memory_id, user_confirmed: true });
  assert.equal((await tools.get_household_preference({
    memory_type: "sleep_time",
    time_zone: "Asia/Shanghai",
    day_type: "weekday",
  })).value, "22:30");
  const routinePreview = await tools.preview_household_routine({
    routine_type: "sleep_time",
    day_type: "weekday",
    time_zone: "Asia/Shanghai",
  });
  assert.equal(routinePreview.status, "PREVIEW_ONLY");
  assert.equal(routinePreview.suggestion.local_time, "22:30");
  assert.equal(routinePreview.execution_performed, false);
  assert.equal(routinePreview.automation_enabled, false);

  assert.equal((await tools.forget_household_memory({ memory_id: saved.memory.memory_id })).deleted, true);
  assert.equal(await tools.get_household_preference({ memory_type: "comfort_temperature_c", room_id: "bedroom" }), null);
});

test("OpenClaw 作息工具自行计算家庭本地日期，并拒绝未授权或不带时区的观察", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-memory-routine-tool-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new PreferenceMemoryStore({ filePath: path.join(directory, "preferences.json") });
  const tools = createHouseholdMemoryTools(store);
  const observation = {
    routine_type: "sleep_time",
    observed_time: "22:34",
    occurred_at: "2026-09-20T16:34:00Z",
    event_id: "routine-event-001",
    time_zone: "Asia/Shanghai",
    confidence: 0.95,
    consent_to_observe: true,
  };

  const noConsent = await tools.propose_household_memory_candidate({ ...observation, consent_to_observe: false });
  assert.equal(noConsent.error.code, "MEMORY_CONSENT_REQUIRED");

  const noOffset = await tools.propose_household_memory_candidate({
    ...observation,
    occurred_at: "2026-09-20T16:34:00",
  });
  assert.equal(noOffset.error.code, "INVALID_OCCURRED_AT");

  const accepted = await tools.propose_household_memory_candidate(observation);
  assert.equal(accepted.success, true);
  assert.equal(accepted.observation_date, "2026-09-21");
  assert.equal(accepted.observed_time_bucket, "22:30");
  assert.equal(accepted.memory.status, "observing");
  assert.equal(accepted.memory.observation_count, 1);
});
