import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RoutineNotificationInbox } from "../src/routine-notification-inbox.js";

function dueEvent({ key = "routine-reminder:memory-1:2026-10-16", routineType = "sleep_time" } = {}) {
  return {
    schema_version: "0.1",
    event_id: `evt-${key}`,
    source_agent: "household-memory",
    event_type: "routine_due",
    occurred_at: "2026-10-16T14:30:00.000Z",
    privacy_level: "family",
    data_level: "L0",
    trace_id: `trace-${key}`,
    dedup_key: key,
    payload: {
      routine_type: routineType,
      local_date: "2026-10-16",
      local_time: "22:30",
      day_type: "weekday",
      time_zone: "Asia/Shanghai",
      preference_memory_id: "private-memory-reference-not-persisted",
      proposed_action: "notify_user",
      requires_user_confirmation_before_device_action: true,
      private_extra_data: "must-not-be-persisted",
    },
  };
}

async function tempInbox(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-routine-inbox-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "notifications.json");
  return { directory, filePath, inbox: new RoutineNotificationInbox({ filePath, ...options }) };
}

test("收件箱只接收安全的 routine_due 事件，并只落盘最小提醒字段", async (t) => {
  const { filePath, inbox } = await tempInbox(t, { clock: () => Date.parse("2026-10-16T14:31:00.000Z") });
  const invalid = await inbox.enqueue({ ...dueEvent(), event_type: "device_action" });
  assert.equal(invalid.success, false);
  assert.equal(invalid.error.code, "INVALID_ROUTINE_DUE_EVENT");

  const queued = await inbox.enqueue(dueEvent());
  assert.equal(queued.status, "QUEUED");
  const persisted = await fs.readFile(filePath, "utf8");
  assert.equal(persisted.includes("preference_memory_id"), false);
  assert.equal(persisted.includes("private_extra_data"), false);
  assert.equal(persisted.includes("must-not-be-persisted"), false);
  assert.deepEqual(Object.keys(JSON.parse(persisted).notifications[0]).sort(), [
    "acknowledged_at", "created_at", "local_date", "local_time", "notification_id", "routine_type", "status", "time_zone",
  ]);
});

test("幂等去重跨实例和进程文件重载有效", async (t) => {
  const { filePath, inbox } = await tempInbox(t);
  const event = dueEvent();
  const first = await inbox.enqueue(event);
  const duplicate = await new RoutineNotificationInbox({ filePath }).enqueue(event);
  assert.equal(first.status, "QUEUED");
  assert.equal(duplicate.status, "DUPLICATE");
  assert.equal(duplicate.notification_id, first.notification_id);
  assert.equal((await inbox.list()).notifications.length, 1);
});

test("用户明确确认后只更新提醒状态，重复确认幂等", async (t) => {
  const { inbox } = await tempInbox(t);
  const queued = await inbox.enqueue(dueEvent());
  const denied = await inbox.acknowledge({ notification_id: queued.notification_id, user_acknowledged: false });
  assert.equal(denied.error.code, "USER_ACKNOWLEDGEMENT_REQUIRED");
  assert.equal((await inbox.list()).notifications[0].status, "pending");

  const acknowledged = await inbox.acknowledge({ notification_id: queued.notification_id, user_acknowledged: true });
  assert.equal(acknowledged.status, "ACKNOWLEDGED");
  const repeated = await inbox.acknowledge({ notification_id: queued.notification_id, user_acknowledged: true });
  assert.equal(repeated.status, "ALREADY_ACKNOWLEDGED");
  assert.deepEqual((await inbox.list()).notifications, []);
  assert.equal((await inbox.list({ include_acknowledged: true })).notifications[0].status, "acknowledged");
});

test("容量上限不丢待处理提醒，且 retentionLimit 为 1 时正确裁剪已确认记录", async (t) => {
  const { inbox } = await tempInbox(t, { retentionLimit: 1 });
  const first = await inbox.enqueue(dueEvent());
  const full = await inbox.enqueue(dueEvent({ key: "routine-reminder:memory-2:2026-10-16", routineType: "wake_time" }));
  assert.equal(full.error.code, "INBOX_CAPACITY_REACHED");
  assert.equal((await inbox.list()).notifications[0].notification_id, first.notification_id);

  await inbox.acknowledge({ notification_id: first.notification_id, user_acknowledged: true });
  const next = await inbox.enqueue(dueEvent({ key: "routine-reminder:memory-2:2026-10-16", routineType: "wake_time" }));
  assert.equal(next.status, "QUEUED");
  const all = (await inbox.list({ include_acknowledged: true, limit: 50 })).notifications;
  assert.equal(all.length, 1);
  assert.equal(all[0].notification_id, next.notification_id);
  assert.equal(all[0].status, "pending");
});

test("写锁冲突和损坏文件均失败关闭，不覆盖收件箱", async (t) => {
  const { filePath, inbox } = await tempInbox(t);
  const lockPath = `${filePath}.lock`;
  await fs.writeFile(lockPath, "another-writer", "utf8");
  const locked = await inbox.enqueue(dueEvent());
  assert.equal(locked.error.code, "INBOX_LOCKED");
  await fs.rm(lockPath);

  await fs.writeFile(filePath, "{broken", "utf8");
  const rejected = await inbox.enqueue(dueEvent());
  assert.equal(rejected.error.code, "INBOX_READ_FAILED");
  assert.equal(await fs.readFile(filePath, "utf8"), "{broken");
  assert.equal((await inbox.acknowledge({ notification_id: "routine-aaaaaaaaaaaaaaaaaaaaaaaa", user_acknowledged: true })).error.code, "INBOX_READ_FAILED");
});

test("拒绝错误时区、时间、提醒类型和不匹配幂等键", async (t) => {
  const { inbox } = await tempInbox(t);
  for (const event of [
    { ...dueEvent(), payload: { ...dueEvent().payload, time_zone: "Mars/Olympus" } },
    { ...dueEvent(), payload: { ...dueEvent().payload, local_time: "25:00" } },
    { ...dueEvent(), payload: { ...dueEvent().payload, routine_type: "energy_saving" } },
  ]) {
    assert.equal((await inbox.enqueue(event)).error.code, "INVALID_ROUTINE_DUE_EVENT");
  }
  assert.equal((await inbox.enqueue(dueEvent(), { idempotencyKey: "different" })).error.code, "INVALID_ROUTINE_DUE_EVENT");
  assert.deepEqual((await inbox.list()).notifications, []);
});

