import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectMaintenanceScheduleLock, MaintenanceScheduleStore, resolveMaintenanceSchedulePath } from "../src/maintenance-store.js";

const NOW = Date.parse("2026-10-17T08:00:00.000Z");

function schedule(overrides = {}) {
  return {
    schedule_id: "air-filter",
    device_id: "air.purifier",
    device_name: "客厅空气净化器",
    maintenance_type: "filter_replacement",
    last_completed_at: "2026-08-01T08:00:00.000Z",
    interval_days: 60,
    usage_since_service: 92,
    usage_limit: 100,
    usage_unit: "hours",
    ...overrides,
  };
}

async function withStore(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-maintenance-store-"));
  const filePath = path.join(directory, "nested", "schedules.json");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new MaintenanceScheduleStore({ filePath, clock: () => NOW, ...options });
  return { store, filePath, directory };
}

test("维护计划路径支持显式覆写、OpenClaw 状态目录与默认状态目录", () => {
  assert.equal(resolveMaintenanceSchedulePath({ DEVICE_MANAGER_MAINTENANCE_SCHEDULE_PATH: "./custom.json" }), path.resolve("./custom.json"));
  assert.equal(resolveMaintenanceSchedulePath({ OPENCLAW_STATE_DIR: "./state" }), path.join(path.resolve("./state"), "device-manager", "maintenance-schedules.json"));
  assert.equal(resolveMaintenanceSchedulePath({}), path.join(os.homedir(), ".openclaw", "device-manager", "maintenance-schedules.json"));
});

test("锁等待时长默认 1 秒，且只接受 0 到 5000ms 的整数", async (t) => {
  const { filePath } = await withStore(t);
  const store = new MaintenanceScheduleStore({ filePath, clock: () => NOW });
  assert.equal(store.lockWaitMs, 1_000);
  assert.equal(new MaintenanceScheduleStore({ filePath, lockWaitMs: 0 }).lockWaitMs, 0);
  assert.equal(new MaintenanceScheduleStore({ filePath, lockWaitMs: 5_000 }).lockWaitMs, 5_000);
  for (const lockWaitMs of [-1, 5_001, 1.5]) {
    assert.throws(() => new MaintenanceScheduleStore({ filePath, lockWaitMs }), /lockWaitMs 必须为 0 到 5000 的整数/);
  }
});

test("计划可新增、更新并由新 store 实例重启后读取", async (t) => {
  const { store, filePath } = await withStore(t);
  const created = await store.upsertSchedule(schedule());
  assert.equal(created.success, true);
  assert.equal(created.created, true);
  const updated = await store.upsertSchedule(schedule({ device_name: "净化器", usage_since_service: 12 }));
  assert.equal(updated.created, false);

  const restored = new MaintenanceScheduleStore({ filePath, clock: () => NOW });
  const items = await restored.listSchedules();
  assert.equal(items.length, 1);
  assert.equal(items[0].device_name, "净化器");
  assert.equal(items[0].usage_since_service, 12);
  assert.equal((await restored.listCompletions()).length, 0);
});

test("局部更新保留未提供字段，null 清除字段，稳定身份不可重新绑定", async (t) => {
  const { store } = await withStore(t);
  await store.upsertSchedule(schedule());
  const partial = await store.upsertSchedule({
    schedule_id: "air-filter",
    device_id: "air.purifier",
    maintenance_type: "filter_replacement",
    device_name: "净化器",
  });
  assert.equal(partial.success, true);
  assert.equal(partial.schedule.interval_days, 60);
  assert.equal(partial.schedule.usage_since_service, 92);
  assert.equal(partial.schedule.device_name, "净化器");

  const cleared = await store.upsertSchedule({
    schedule_id: "air-filter",
    device_id: "air.purifier",
    maintenance_type: "filter_replacement",
    device_name: null,
  });
  assert.equal(cleared.success, true);
  assert.equal(Object.hasOwn(cleared.schedule, "device_name"), false);
  const identity = await store.upsertSchedule({
    schedule_id: "air-filter",
    device_id: "air.other",
    maintenance_type: "filter_replacement",
  });
  assert.equal(identity.error.code, "SCHEDULE_IDENTITY_IMMUTABLE");
  await assert.rejects(store.upsertSchedule({
    schedule_id: "air-filter",
    device_id: "air.purifier",
    maintenance_type: "filter_replacement",
    usage_since_service: null,
  }), /必须同时传 null/);
});

test("维护完成必须明确确认，并更新到期日、用量和完成历史", async (t) => {
  const { store } = await withStore(t);
  await store.upsertSchedule(schedule({ next_due_at: "2026-10-10T08:00:00.000Z" }));
  const refused = await store.recordCompletion({ schedule_id: "air-filter", user_confirmed: false });
  assert.equal(refused.error.code, "EXPLICIT_CONFIRMATION_REQUIRED");
  assert.equal((await store.listCompletions()).length, 0);

  const result = await store.recordCompletion({ schedule_id: "air-filter", user_confirmed: true });
  assert.equal(result.success, true);
  assert.equal(result.physical_maintenance_performed_by_agent, false);
  assert.equal(result.schedule.last_completed_at, new Date(NOW).toISOString());
  assert.equal(result.schedule.next_due_at, new Date(NOW + 60 * 24 * 60 * 60 * 1000).toISOString());
  assert.equal(result.schedule.usage_since_service, 0);
  assert.deepEqual(result.completion.usage_before, { value: 92, unit: "hours" });
  assert.equal((await store.listCompletions({ schedule_id: "air-filter" })).length, 1);
});

test("缺少维护间隔时不猜下一次日期，并拒绝未来时间与未知计划", async (t) => {
  const { store } = await withStore(t);
  await store.upsertSchedule(schedule({ schedule_id: "manual-date", interval_days: undefined }));
  const future = await store.recordCompletion({
    schedule_id: "manual-date",
    completed_at: "2026-10-18T08:00:00.000Z",
    user_confirmed: true,
  });
  assert.equal(future.error.code, "COMPLETION_TIME_IN_FUTURE");
  const missing = await store.recordCompletion({ schedule_id: "unknown", user_confirmed: true });
  assert.equal(missing.error.code, "SCHEDULE_NOT_FOUND");

  const result = await store.recordCompletion({ schedule_id: "manual-date", user_confirmed: true });
  assert.equal(result.success, true);
  assert.equal(result.next_due_known, false);
  assert.equal(Object.hasOwn(result.schedule, "next_due_at"), false);
});

test("维护完成时间不能倒退，重试记录幂等", async (t) => {
  const { store } = await withStore(t);
  await store.upsertSchedule(schedule({ installed_at: "2026-07-01T08:00:00.000Z" }));
  const outOfOrder = await store.recordCompletion({
    schedule_id: "air-filter",
    completed_at: "2026-07-20T08:00:00.000Z",
    user_confirmed: true,
  });
  assert.equal(outOfOrder.error.code, "COMPLETION_TIME_OUT_OF_ORDER");

  const first = await store.recordCompletion({ schedule_id: "air-filter", user_confirmed: true });
  const retry = await store.recordCompletion({ schedule_id: "air-filter", user_confirmed: true });
  assert.equal(first.completion_recorded, true);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.completion_recorded, false);
  assert.equal(retry.completion.record_id, first.completion.record_id);
  assert.equal((await store.listCompletions()).length, 1);

  const sameExplicitTime = "2026-10-17T07:59:00.000Z";
  const explicit = await store.recordCompletion({ schedule_id: "air-filter", completed_at: sameExplicitTime, user_confirmed: true });
  assert.equal(explicit.error.code, "COMPLETION_TIME_OUT_OF_ORDER");
});

test("并发维护计划写入在进程内串行化且保留全部记录", async (t) => {
  const { store } = await withStore(t);
  await Promise.all([
    store.upsertSchedule(schedule({ schedule_id: "one", device_id: "air.one" })),
    store.upsertSchedule(schedule({ schedule_id: "two", device_id: "air.two" })),
  ]);
  assert.deepEqual((await store.listSchedules()).map((item) => item.schedule_id), ["one", "two"]);
});

test("维护存储的跨进程锁冲突会失败关闭且不会覆盖数据或清理他方锁", async (t) => {
  const { store, filePath } = await withStore(t, { lockWaitMs: 10 });
  await store.upsertSchedule(schedule());
  const lockPath = `${filePath}.lock`;
  const childLockScript = `import { open, readFile, rm } from "node:fs/promises";\nconst lockPath = ${JSON.stringify(lockPath)};\nconst lock = { token: "child-process", pid: process.pid, created_at: ${JSON.stringify(new Date(NOW).toISOString())} };\nconst handle = await open(lockPath, "wx", 0o600);\nawait handle.writeFile(JSON.stringify(lock));\nawait handle.close();\nprocess.stdout.write("LOCKED\\n");\nawait new Promise((resolve) => process.stdin.once("data", resolve));\nconst current = JSON.parse(await readFile(lockPath, "utf8"));\nif (current.token === lock.token) await rm(lockPath);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childLockScript], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit").catch(() => {});
    }
  });
  const [ready] = await once(child.stdout, "data");
  assert.match(ready.toString("utf8"), /LOCKED/);
  const otherWriterLock = await fs.readFile(lockPath, "utf8");
  assert.equal(JSON.parse(otherWriterLock).token, "child-process");
  assert.notEqual(JSON.parse(otherWriterLock).pid, process.pid);
  const liveLockReport = await inspectMaintenanceScheduleLock({ filePath, clock: () => NOW });
  assert.equal(liveLockReport.status, "LOCK_OWNER_PROCESS_ALIVE");
  assert.equal(liveLockReport.owner_pid, JSON.parse(otherWriterLock).pid);
  assert.equal(liveLockReport.automatic_cleanup, false);
  assert.equal(JSON.stringify(liveLockReport).includes("child-process"), false, "诊断结果不泄露锁 token");

  const update = await store.upsertSchedule(schedule({ device_name: "不应写入的新名称" }));
  assert.equal(update.success, false);
  assert.equal(update.error.code, "MAINTENANCE_STORE_LOCKED");
  const completion = await store.recordCompletion({ schedule_id: "air-filter", user_confirmed: true });
  assert.equal(completion.success, false);
  assert.equal(completion.error.code, "MAINTENANCE_STORE_LOCKED");
  await assert.rejects(store.listSchedules(), (error) => error.code === "MAINTENANCE_STORE_LOCKED");
  await assert.rejects(store.listCompletions(), (error) => error.code === "MAINTENANCE_STORE_LOCKED");
  await assert.rejects(store.readSnapshot(), (error) => error.code === "MAINTENANCE_STORE_LOCKED");
  assert.equal(await fs.readFile(lockPath, "utf8"), otherWriterLock);
  const unchanged = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.equal(unchanged.schedules[0].device_name, "客厅空气净化器");
  assert.equal(unchanged.completions.length, 0);

  const childExit = once(child, "exit");
  child.stdin.end("release\n");
  const [exitCode] = await childExit;
  assert.equal(exitCode, 0);
  assert.equal(await fs.access(lockPath).then(() => true, () => false), false);
  const snapshot = await store.readSnapshot();
  assert.equal(snapshot.schedules[0].device_name, "客厅空气净化器");
  assert.equal(snapshot.completions.length, 0);
  assert.equal((await inspectMaintenanceScheduleLock({ filePath })).status, "UNLOCKED");
  const retried = await store.upsertSchedule(schedule({ device_name: "净化器" }));
  assert.equal(retried.success, true);
  assert.equal(retried.schedule.device_name, "净化器");
  assert.equal(await fs.access(lockPath).then(() => true, () => false), false);
});

test("短暂跨进程锁冲突会等待释放后成功完成写入", async (t) => {
  const { store, filePath } = await withStore(t);
  const lockPath = `${filePath}.lock`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const childLockScript = `import { open, readFile, rm } from "node:fs/promises";\nconst lockPath = ${JSON.stringify(lockPath)};\nconst lock = { token: "short-lived-child-lock", pid: process.pid, created_at: ${JSON.stringify(new Date(NOW).toISOString())} };\nconst handle = await open(lockPath, "wx", 0o600);\nawait handle.writeFile(JSON.stringify(lock));\nawait handle.close();\nprocess.stdout.write("LOCKED\\n");\nawait new Promise((resolve) => setTimeout(resolve, 100));\nconst current = JSON.parse(await readFile(lockPath, "utf8"));\nif (current.token === lock.token) await rm(lockPath);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childLockScript], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit").catch(() => {});
    }
  });
  const [ready] = await once(child.stdout, "data");
  assert.match(ready.toString("utf8"), /LOCKED/);
  const childExit = once(child, "exit");

  const update = await store.upsertSchedule(schedule({ device_name: "等待释放后写入" }));
  assert.equal(update.success, true);
  assert.equal(update.schedule.device_name, "等待释放后写入");
  const [exitCode] = await childExit;
  assert.equal(exitCode, 0);
  assert.equal(await fs.access(lockPath).then(() => true, () => false), false);
  const snapshot = await store.readSnapshot();
  assert.equal(snapshot.schedules.length, 1);
  assert.equal(snapshot.schedules[0].device_name, "等待释放后写入");
  assert.deepEqual(snapshot.completions, []);
  assert.equal((await inspectMaintenanceScheduleLock({ filePath })).status, "UNLOCKED");
});

test("多个独立 Node 写入进程同时竞争时所有维护计划均保留且最终解锁", async (t) => {
  const { store, filePath } = await withStore(t);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  const moduleUrl = new URL("../src/maintenance-store.js", import.meta.url).href;
  const ids = ["writer-0", "writer-1", "writer-2", "writer-3"];
  const runs = ids.map((scheduleId, index) => {
    const childSchedule = schedule({ schedule_id: scheduleId, device_id: `air.writer_${index}` });
    const script = `const { MaintenanceScheduleStore } = await import(${JSON.stringify(moduleUrl)});\nconst store = new MaintenanceScheduleStore({ filePath: ${JSON.stringify(filePath)}, lockWaitMs: 5000 });\nconst result = await store.upsertSchedule(${JSON.stringify(childSchedule)});\nif (!result.success) { process.stderr.write(JSON.stringify(result.error)); process.exitCode = 1; } else process.stdout.write("SAVED:" + result.schedule.schedule_id + "\\n");`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const result = once(child, "exit").then(([exitCode, signal]) => ({ scheduleId, exitCode, signal, stdout, stderr }));
    return { child, result };
  });
  t.after(async () => {
    await Promise.all(runs.map(async ({ child }) => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await once(child, "exit").catch(() => {});
      }
    }));
  });

  const outcomes = await Promise.all(runs.map(({ result }) => result));
  for (const outcome of outcomes) {
    assert.equal(outcome.exitCode, 0, `${outcome.scheduleId}: ${outcome.stderr}`);
    assert.equal(outcome.signal, null);
    assert.match(outcome.stdout, new RegExp(`SAVED:${outcome.scheduleId}`));
  }
  const snapshot = await store.readSnapshot();
  assert.deepEqual(snapshot.schedules.map((item) => item.schedule_id).sort(), ids);
  assert.deepEqual(snapshot.completions, []);
  assert.equal(await fs.access(lockPath).then(() => true, () => false), false);
  assert.equal((await inspectMaintenanceScheduleLock({ filePath })).status, "UNLOCKED");
});

test("写入进程退出留下孤儿锁时诊断并拒绝写入，但不自动清理", async (t) => {
  const { store, filePath } = await withStore(t, { lockWaitMs: 0 });
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  const childLockScript = `import { open } from "node:fs/promises";\nconst lockPath = ${JSON.stringify(lockPath)};\nconst lock = { token: "orphaned-lock-test", pid: process.pid, created_at: ${JSON.stringify(new Date(NOW).toISOString())} };\nconst handle = await open(lockPath, "wx", 0o600);\nawait handle.writeFile(JSON.stringify(lock));\nawait handle.close();\nprocess.stdout.write(JSON.stringify({ pid: process.pid }) + "\\n");`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childLockScript], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit").catch(() => {});
    }
  });
  const childExit = once(child, "exit");
  const [ready] = await once(child.stdout, "data");
  const { pid } = JSON.parse(ready.toString("utf8"));
  const [exitCode] = await childExit;
  assert.equal(exitCode, 0);

  const lockText = await fs.readFile(lockPath, "utf8");
  const report = await inspectMaintenanceScheduleLock({ filePath, clock: () => NOW + 1_000 });
  assert.equal(report.status, "LOCK_OWNER_PROCESS_NOT_FOUND");
  assert.equal(report.owner_pid, pid);
  assert.equal(report.age_ms, 1_000);
  assert.equal(report.automatic_cleanup, false);
  assert.match(report.message, /人工确认/);

  const write = await store.upsertSchedule(schedule());
  assert.equal(write.success, false);
  assert.equal(write.error.code, "MAINTENANCE_STORE_LOCKED");
  assert.equal(await fs.access(filePath).then(() => true, () => false), false);
  assert.equal(await fs.readFile(lockPath, "utf8"), lockText);
  const cliPath = fileURLToPath(new URL("../src/inspect-maintenance-store-lock.js", import.meta.url));
  const cli = spawnSync(process.execPath, [cliPath, "--path", filePath], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).status, "LOCK_OWNER_PROCESS_NOT_FOUND");
  assert.equal(await fs.readFile(lockPath, "utf8"), lockText);
});

test("只读锁诊断 CLI 可检查自定义路径且不修改锁文件", async (t) => {
  const { filePath } = await withStore(t);
  const cliPath = fileURLToPath(new URL("../src/inspect-maintenance-store-lock.js", import.meta.url));
  const unlocked = spawnSync(process.execPath, [cliPath, "--path", filePath], { encoding: "utf8" });
  assert.equal(unlocked.status, 0, unlocked.stderr);
  assert.equal(JSON.parse(unlocked.stdout).status, "UNLOCKED");

  const lockPath = `${filePath}.lock`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const lockText = JSON.stringify({ token: "diagnostic-test-token", pid: process.pid, created_at: new Date(NOW).toISOString() });
  await fs.writeFile(lockPath, lockText, "utf8");
  const locked = spawnSync(process.execPath, [cliPath, "--path", filePath], { encoding: "utf8" });
  assert.equal(locked.status, 0, locked.stderr);
  const report = JSON.parse(locked.stdout);
  assert.equal(report.status, "LOCK_OWNER_PROCESS_ALIVE");
  assert.equal(report.automatic_cleanup, false);
  assert.equal(locked.stdout.includes("diagnostic-test-token"), false);
  assert.equal(await fs.readFile(lockPath, "utf8"), lockText);

  const malformedLock = "not-json";
  await fs.writeFile(lockPath, malformedLock, "utf8");
  const invalid = spawnSync(process.execPath, [cliPath, "--path", filePath], { encoding: "utf8" });
  assert.equal(invalid.status, 0, invalid.stderr);
  assert.equal(JSON.parse(invalid.stdout).status, "LOCK_METADATA_INVALID");
  assert.equal(await fs.readFile(lockPath, "utf8"), malformedLock);
});

test("损坏或不兼容的文件 fail-closed，不会被存储写入覆盖", async (t) => {
  const { store, filePath } = await withStore(t);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "{broken", "utf8");
  await assert.rejects(store.upsertSchedule(schedule()), /不是有效 JSON/);
  assert.equal(await fs.readFile(filePath, "utf8"), "{broken");

  const unsupported = JSON.stringify({
    schema_version: "device-manager.maintenance-schedules/0.2",
    schedules: [],
    completions: [],
  });
  await fs.writeFile(filePath, unsupported, "utf8");
  await assert.rejects(store.upsertSchedule(schedule()), /版本不受支持/);
  assert.equal(await fs.readFile(filePath, "utf8"), unsupported);
});

test("未知维护字段不会被静默持久化", async (t) => {
  const { store } = await withStore(t);
  await assert.rejects(store.upsertSchedule(schedule({ access_token: "not-allowed" })), /未支持字段/);
});
