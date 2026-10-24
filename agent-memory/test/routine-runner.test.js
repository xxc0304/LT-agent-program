import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PreferenceMemoryStore } from "../src/memory-store.js";
import { createRoutineDueEvaluator } from "../src/routine-trigger.js";
import { createRoutineReminderRunner } from "../src/routine-runner.js";

function makeDueEvaluator(events) {
  return { poll: async () => ({ success: true, status: events.length ? "DUE_EVENT_READY" : "NOT_DUE", events }) };
}

const dueEvent = Object.freeze({
  event_id: "evt-routine-reminder-memory-1-2026-10-16",
  event_type: "routine_due",
  dedup_key: "routine-reminder:memory-1:2026-10-16",
  payload: { routine_type: "sleep_time", proposed_action: "notify_user" },
});

test("默认无授权时不启动定时器，也不调用接收器", async () => {
  let intervalCalls = 0;
  let deliveryCalls = 0;
  const runner = createRoutineReminderRunner({
    evaluator: makeDueEvaluator([dueEvent]),
    time_zone: "Asia/Shanghai",
    onDueEvent: async () => { deliveryCalls += 1; },
    setIntervalFn: () => { intervalCalls += 1; return 1; },
  });

  assert.equal((await runner.start()).status, "SCHEDULE_AUTHORIZATION_REQUIRED");
  assert.equal((await runner.poll()).status, "SCHEDULE_AUTHORIZATION_REQUIRED");
  assert.equal(runner.getStatus().running, false);
  assert.equal(intervalCalls, 0);
  assert.equal(deliveryCalls, 0);
});

test("显式授权后启动、停止周期检查，并把稳定幂等键交给事件接收器", async () => {
  let callback;
  let intervalMs;
  let cleared = false;
  const received = [];
  const runner = createRoutineReminderRunner({
    evaluator: makeDueEvaluator([dueEvent]),
    time_zone: "Asia/Shanghai",
    scheduleAuthorized: true,
    pollIntervalMs: 5_000,
    onDueEvent: async (event, metadata) => { received.push({ event, metadata }); },
    setIntervalFn: (fn, ms) => { callback = fn; intervalMs = ms; return "timer-1"; },
    clearIntervalFn: (timer) => { assert.equal(timer, "timer-1"); cleared = true; },
  });

  assert.equal((await runner.start()).status, "RUNNING");
  assert.equal(intervalMs, 5_000);
  await runner.poll();
  await runner.poll();
  assert.equal(received.length, 1);
  assert.equal(received[0].metadata.idempotencyKey, dueEvent.dedup_key);
  assert.equal(received[0].metadata.eventId, dueEvent.event_id);
  assert.notEqual(received[0].event, dueEvent, "接收器拿到独立副本，不能篡改原事件对象");
  assert.equal(runner.getStatus().delivered_keys_in_process, 1);

  const stopped = runner.stop();
  assert.equal(stopped.status, "STOPPED");
  assert.equal(cleared, true);
  assert.equal(runner.getStatus().running, false);
  assert.equal(typeof callback, "function");
});

test("接收器拒绝或异常时不记为已交付，后续轮询可重试", async () => {
  let calls = 0;
  const runner = createRoutineReminderRunner({
    evaluator: makeDueEvaluator([dueEvent]),
    time_zone: "Asia/Shanghai",
    scheduleAuthorized: true,
    onDueEvent: async () => {
      calls += 1;
      if (calls === 1) return { success: false, error: { code: "NOTIFY_CHANNEL_OFFLINE" } };
      return { success: true };
    },
  });

  assert.equal((await runner.poll()).status, "DELIVERY_PARTIAL");
  assert.equal((await runner.poll()).status, "EVENTS_DELIVERED");
  assert.equal((await runner.poll()).status, "EVENTS_ALREADY_DELIVERED");
  assert.equal(calls, 2);
});

test("轮询重入会安全跳过，不并发重复调用事件接收器", async () => {
  let release;
  let calls = 0;
  const blocked = new Promise((resolve) => { release = resolve; });
  const runner = createRoutineReminderRunner({
    evaluator: { poll: async () => { await blocked; return { success: true, status: "DUE_EVENT_READY", events: [dueEvent] }; } },
    time_zone: "Asia/Shanghai",
    scheduleAuthorized: true,
    onDueEvent: async () => { calls += 1; },
  });

  const firstPoll = runner.poll();
  await Promise.resolve();
  const concurrent = await runner.poll();
  assert.equal(concurrent.status, "POLL_ALREADY_RUNNING");
  release();
  await firstPoll;
  assert.equal(calls, 1);
});

test("合成已确认作息偏好可经到期评估器和运行器形成端到端事件", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-routine-runner-e2e-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const clock = () => Date.parse("2026-09-30T14:30:30.000Z");
  const store = new PreferenceMemoryStore({ filePath: path.join(directory, "memory.json"), clock });
  await store.saveExplicitPreference({
    memory_type: "sleep_time",
    value: "22:30",
    time_zone: "Asia/Shanghai",
    day_type: "weekday",
    user_explicit_request: true,
  });
  const evaluator = createRoutineDueEvaluator({ store, scheduleAuthorized: true, clock });
  const received = [];
  const runner = createRoutineReminderRunner({
    evaluator,
    time_zone: "Asia/Shanghai",
    scheduleAuthorized: true,
    onDueEvent: async (event, metadata) => { received.push({ event, metadata }); },
  });

  const result = await runner.poll();
  assert.equal(result.status, "EVENTS_DELIVERED");
  assert.equal(received.length, 1);
  assert.equal(received[0].event.event_type, "routine_due");
  assert.equal(received[0].event.payload.local_time, "22:30");
  assert.equal(received[0].event.payload.proposed_action, "notify_user");
  assert.equal(received[0].metadata.idempotencyKey, "routine-reminder:" + received[0].event.payload.preference_memory_id + ":2026-09-30");
  assert.equal(result.execution_performed, false);
});

test("无效时区、过短轮询周期和缺失接收器均在创建时拒绝", () => {
  assert.throws(() => createRoutineReminderRunner({ evaluator: makeDueEvaluator([]), time_zone: "Bad/Zone", onDueEvent() {} }), /IANA 时区/);
  assert.throws(() => createRoutineReminderRunner({ evaluator: makeDueEvaluator([]), time_zone: "Asia/Shanghai", pollIntervalMs: 999, onDueEvent() {} }), /pollIntervalMs/);
  assert.throws(() => createRoutineReminderRunner({ evaluator: makeDueEvaluator([]), time_zone: "Asia/Shanghai" }), /接收器/);
});

test("持久化用户撤回作息提醒授权后，下一次轮询立即停止运行器", async () => {
  let consentEnabled = false;
  let intervalCleared = false;
  let intervalCalls = 0;
  const runner = createRoutineReminderRunner({
    evaluator: makeDueEvaluator([]),
    time_zone: "Asia/Shanghai",
    scheduleAuthorized: true,
    authorizationProvider: async () => ({ success: true, enabled: consentEnabled }),
    onDueEvent: async () => ({ success: true }),
    setIntervalFn: () => { intervalCalls += 1; return 42; },
    clearIntervalFn: (timer) => { assert.equal(timer, 42); intervalCleared = true; },
  });

  assert.equal((await runner.start()).status, "SCHEDULE_AUTHORIZATION_REQUIRED");
  assert.equal(intervalCalls, 0);
  consentEnabled = true;
  assert.equal((await runner.start()).status, "RUNNING");
  assert.equal(intervalCalls, 1);
  consentEnabled = false;
  const revoked = await runner.poll();
  assert.equal(revoked.status, "SCHEDULE_AUTHORIZATION_REQUIRED");
  assert.equal(revoked.reason, "USER_CONSENT_DISABLED");
  assert.equal(runner.getStatus().running, false);
  assert.equal(intervalCleared, true);
});
