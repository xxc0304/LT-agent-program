import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PreferenceMemoryStore } from "../src/memory-store.js";
import { createRoutineDueEvaluator } from "../src/routine-trigger.js";

async function createStore(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-routine-trigger-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return new PreferenceMemoryStore({ filePath: path.join(directory, "memory.json"), ...options });
}

async function saveBedtime(store, options = {}) {
  return store.saveExplicitPreference({
    memory_type: "sleep_time",
    value: "22:30",
    time_zone: "Asia/Shanghai",
    day_type: "weekday",
    user_explicit_request: true,
    ...options,
  });
}

test("作息到期检查默认关闭；没有单独授权时不产生日程事件", async (t) => {
  const now = Date.parse("2026-09-30T14:30:30.000Z");
  const store = await createStore(t);
  await saveBedtime(store);
  const evaluator = createRoutineDueEvaluator({ store, clock: () => now });

  const result = await evaluator.poll({ time_zone: "Asia/Shanghai" });
  assert.equal(result.status, "SCHEDULE_AUTHORIZATION_REQUIRED");
  assert.equal(result.execution_performed, false);
  assert.deepEqual(result.events, []);
});

test("已授权的本地调度器在到期窗口内生成稳定、可幂等去重的 routine_due 事件", async (t) => {
  let now = Date.parse("2026-09-30T14:30:30.000Z"); // Wednesday 22:30:30 in Shanghai
  const store = await createStore(t);
  const saved = await saveBedtime(store);
  const evaluator = createRoutineDueEvaluator({
    store,
    scheduleAuthorized: true,
    clock: () => now,
    triggerWindowMs: 60_000,
  });

  const first = await evaluator.poll({ time_zone: "Asia/Shanghai" });
  now += 20_000;
  const retry = await evaluator.poll({ time_zone: "Asia/Shanghai" });
  assert.equal(first.status, "DUE_EVENT_READY");
  assert.equal(first.execution_performed, false);
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].event_type, "routine_due");
  assert.equal(first.events[0].payload.routine_type, "sleep_time");
  assert.equal(first.events[0].payload.local_date, "2026-09-30");
  assert.equal(first.events[0].payload.local_time, "22:30");
  assert.equal(first.events[0].payload.preference_memory_id, saved.memory.memory_id);
  assert.equal(first.events[0].payload.requires_user_confirmation_before_device_action, true);
  assert.equal(first.events[0].event_id, retry.events[0].event_id);
  assert.equal(first.events[0].dedup_key, retry.events[0].dedup_key);
  assert.deepEqual(first.events[0], retry.events[0]);
  assert.equal(first.events[0].occurred_at, "2026-09-30T14:30:00.000Z");
});

test("未到时间、超出窗口、周末或无已确认偏好时不生成到期事件", async (t) => {
  const store = await createStore(t);
  await saveBedtime(store);

  const before = createRoutineDueEvaluator({
    store,
    scheduleAuthorized: true,
    clock: () => Date.parse("2026-09-30T14:29:30.000Z"),
    triggerWindowMs: 60_000,
  });
  assert.equal((await before.poll({ time_zone: "Asia/Shanghai" })).status, "NOT_DUE");

  const late = createRoutineDueEvaluator({
    store,
    scheduleAuthorized: true,
    clock: () => Date.parse("2026-09-30T14:32:00.000Z"),
    triggerWindowMs: 60_000,
  });
  assert.equal((await late.poll({ time_zone: "Asia/Shanghai" })).status, "NOT_DUE");

  const weekend = createRoutineDueEvaluator({
    store,
    scheduleAuthorized: true,
    clock: () => Date.parse("2026-10-03T14:30:30.000Z"),
  });
  assert.equal((await weekend.poll({ time_zone: "Asia/Shanghai" })).status, "NOT_DUE");
  assert.equal((await weekend.poll({ time_zone: "Asia/Tokyo" })).status, "NOT_DUE");
});

test("到期扫描使用记忆存储的有效性检查，不触发已过期的偏好", async (t) => {
  let now = Date.parse("2026-09-30T13:00:00.000Z");
  const store = await createStore(t, { clock: () => now });
  await saveBedtime(store, { expires_at: "2026-09-30T14:00:00.000Z" });
  now = Date.parse("2026-09-30T14:30:30.000Z");
  const evaluator = createRoutineDueEvaluator({ store, scheduleAuthorized: true, clock: () => now });

  assert.equal((await evaluator.poll({ time_zone: "Asia/Shanghai" })).status, "NOT_DUE");
});

test("无效时区和过大的触发窗口均安全拒绝", async (t) => {
  const store = await createStore(t);
  const evaluator = createRoutineDueEvaluator({ store, scheduleAuthorized: true });
  assert.equal((await evaluator.poll({ time_zone: "Not/AZone" })).error.code, "INVALID_TIME_ZONE");
  assert.equal((await evaluator.poll({})).error.code, "TIME_ZONE_REQUIRED");
  assert.throws(() => createRoutineDueEvaluator({ store, triggerWindowMs: 5 * 60_000 + 1 }), /triggerWindowMs/);
});
