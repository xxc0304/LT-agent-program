import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildMaintenancePlan } from "./maintenance-planner.js";

const STORE_SCHEMA = "device-manager.maintenance-schedules/0.1";
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOCK_WAIT_MS = 1_000;
const LOCK_RETRY_INTERVAL_MS = 25;
const MAX_LOCK_WAIT_MS = 5_000;
const SCHEDULE_FIELDS = new Set([
  "schedule_id",
  "device_id",
  "device_name",
  "maintenance_type",
  "installed_at",
  "last_completed_at",
  "interval_days",
  "next_due_at",
  "usage_since_service",
  "usage_limit",
  "usage_unit",
]);

function emptyDocument() {
  return { schema_version: STORE_SCHEMA, schedules: [], completions: [] };
}

function parseTimestamp(value, field) {
  const timestamp = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) throw new Error(`${field} 必须是有效 ISO 时间字符串`);
  return timestamp;
}

function normalizeSchedule(schedule, { allowNullClears = false } = {}) {
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
    throw new Error("maintenance_schedule 必须是对象");
  }
  const unknown = Object.keys(schedule).filter((key) => !SCHEDULE_FIELDS.has(key));
  if (unknown.length > 0) throw new Error(`maintenance_schedule 存在未支持字段：${unknown.join(", ")}`);
  const normalized = structuredClone(schedule);
  if (allowNullClears) {
    for (const [key, value] of Object.entries(normalized)) {
      if (value === null && !["schedule_id", "device_id", "maintenance_type"].includes(key)) delete normalized[key];
    }
  }
  buildMaintenancePlan({ schedules: [normalized], now: new Date(0) });
  return normalized;
}

function validateDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schema_version !== STORE_SCHEMA
    || !Array.isArray(value.schedules)
    || !Array.isArray(value.completions)) {
    throw new Error("维护计划文件结构无效或版本不受支持；为避免覆盖数据，已停止读写");
  }
  const schedules = value.schedules.map(normalizeSchedule);
  const ids = new Set();
  for (const schedule of schedules) {
    if (ids.has(schedule.schedule_id)) throw new Error(`维护计划文件中 schedule_id 重复：${schedule.schedule_id}`);
    ids.add(schedule.schedule_id);
  }
  for (const [index, completion] of value.completions.entries()) {
    if (!completion || typeof completion !== "object" || Array.isArray(completion)
      || typeof completion.record_id !== "string"
      || typeof completion.schedule_id !== "string"
      || typeof completion.device_id !== "string") {
      throw new Error(`维护完成记录 ${index} 结构无效；为避免覆盖数据，已停止读写`);
    }
    parseTimestamp(completion.completed_at, `completions[${index}].completed_at`);
    parseTimestamp(completion.recorded_at, `completions[${index}].recorded_at`);
  }
  return { schema_version: STORE_SCHEMA, schedules, completions: structuredClone(value.completions) };
}

async function readDocument(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return emptyDocument();
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("维护计划文件不是有效 JSON；为避免覆盖数据，已停止读写");
  }
  return validateDocument(parsed);
}

async function writeDocument(filePath, document) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  try {
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EEXIST") {
      const backupPath = `${filePath}.${randomUUID()}.backup`;
      let originalExists = false;
      try {
        await fs.copyFile(filePath, backupPath, fsConstants.COPYFILE_EXCL);
        originalExists = true;
      } catch (backupError) {
        if (backupError?.code !== "ENOENT") {
          await fs.rm(temporaryPath, { force: true }).catch(() => {});
          throw backupError;
        }
      }
      try {
        await fs.copyFile(temporaryPath, filePath);
        await fs.rm(temporaryPath, { force: true });
        if (originalExists) await fs.rm(backupPath, { force: true });
        return;
      } catch (copyError) {
        try {
          if (originalExists) await fs.copyFile(backupPath, filePath);
          else await fs.rm(filePath, { force: true });
        } catch (restoreError) {
          copyError.restore_error = restoreError instanceof Error ? restoreError.message : String(restoreError);
        }
        await fs.rm(temporaryPath, { force: true }).catch(() => {});
        throw copyError;
      }
    }
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function resolveMaintenanceSchedulePath(env = process.env) {
  if (typeof env.DEVICE_MANAGER_MAINTENANCE_SCHEDULE_PATH === "string"
    && env.DEVICE_MANAGER_MAINTENANCE_SCHEDULE_PATH.trim()) {
    return path.resolve(env.DEVICE_MANAGER_MAINTENANCE_SCHEDULE_PATH.trim());
  }
  const stateDir = typeof env.OPENCLAW_STATE_DIR === "string" && env.OPENCLAW_STATE_DIR.trim()
    ? path.resolve(env.OPENCLAW_STATE_DIR.trim())
    : path.join(os.homedir(), ".openclaw");
  return path.join(stateDir, "device-manager", "maintenance-schedules.json");
}

function inspectProcess(pid) {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error?.code === "ESRCH") return "not_found";
    if (error?.code === "EPERM") return "alive";
    return "unknown";
  }
}

/** Read lock metadata only. This function never removes or changes the lock. */
export async function inspectMaintenanceScheduleLock({ filePath = resolveMaintenanceSchedulePath(), clock = () => Date.now() } = {}) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    return { success: false, error: { code: "INVALID_STORE_PATH", message: "维护计划存储需要有效的 filePath。" } };
  }
  if (typeof clock !== "function") {
    return { success: false, error: { code: "INVALID_CLOCK", message: "诊断 clock 必须是函数。" } };
  }
  const lockPath = `${path.resolve(filePath)}.lock`;
  let text;
  try {
    text = await fs.readFile(lockPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { success: true, status: "UNLOCKED", lock_present: false, automatic_cleanup: false };
    }
    return { success: false, error: { code: "LOCK_INSPECTION_FAILED", message: error instanceof Error ? error.message : String(error) } };
  }

  let lock;
  try {
    lock = JSON.parse(text);
  } catch {
    return {
      success: true,
      status: "LOCK_METADATA_INVALID",
      lock_present: true,
      automatic_cleanup: false,
      message: "锁文件存在但元数据无法解析；不能判断持有者，不应自动删除。请先检查是否仍有维护写入进程。",
    };
  }
  const createdAtMs = typeof lock?.created_at === "string" ? Date.parse(lock.created_at) : NaN;
  if (!lock || typeof lock !== "object" || Array.isArray(lock)
    || !Number.isInteger(lock.pid) || lock.pid < 1
    || typeof lock.token !== "string" || !lock.token
    || !Number.isFinite(createdAtMs)) {
    return {
      success: true,
      status: "LOCK_METADATA_INVALID",
      lock_present: true,
      automatic_cleanup: false,
      message: "锁文件字段不完整或无效；不能判断持有者，不应自动删除。请先检查是否仍有维护写入进程。",
    };
  }

  const processStatus = inspectProcess(lock.pid);
  const nowMs = clock();
  const status = processStatus === "alive"
    ? "LOCK_OWNER_PROCESS_ALIVE"
    : processStatus === "not_found"
      ? "LOCK_OWNER_PROCESS_NOT_FOUND"
      : "LOCK_OWNER_STATUS_UNKNOWN";
  return {
    success: true,
    status,
    lock_present: true,
    owner_pid: lock.pid,
    owner_process_status: processStatus,
    created_at: lock.created_at,
    age_ms: Number.isFinite(nowMs) && nowMs >= createdAtMs ? nowMs - createdAtMs : null,
    automatic_cleanup: false,
    message: processStatus === "alive"
      ? "锁的 PID 当前仍存在；不要删除锁文件，请稍后重试。"
      : processStatus === "not_found"
        ? "锁记录的 PID 当前不存在，锁可能是进程异常退出后遗留；仍需人工确认没有其他写入者，再按运维流程处理。"
        : "无法确认锁持有进程状态；请勿自动删除锁文件，先人工核查。",
  };
}

/**
 * Local durable store for user-supplied maintenance schedules and explicit
 * completion records. Reads and mutations are serialized in-process and
 * guarded by a fail-closed lock file across processes.
 * No chat text, credentials, sensor history, or device commands are stored.
 */
export class MaintenanceScheduleStore {
  constructor({ filePath = resolveMaintenanceSchedulePath(), clock = () => Date.now(), lockWaitMs = DEFAULT_LOCK_WAIT_MS } = {}) {
    if (typeof filePath !== "string" || !filePath.trim()) throw new Error("维护计划存储需要有效的 filePath");
    if (typeof clock !== "function") throw new Error("维护计划存储 clock 必须是函数");
    if (!Number.isInteger(lockWaitMs) || lockWaitMs < 0 || lockWaitMs > MAX_LOCK_WAIT_MS) {
      throw new Error(`维护计划存储 lockWaitMs 必须为 0 到 ${MAX_LOCK_WAIT_MS} 的整数`);
    }
    this.filePath = path.resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.clock = clock;
    this.lockWaitMs = lockWaitMs;
    this.operation = Promise.resolve();
  }

  #serialize(action) {
    const result = this.operation.then(action);
    this.operation = result.catch(() => {});
    return result;
  }

  async #withLock(action, { throwOnConflict = false } = {}) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const token = randomUUID();
    let handle;
    const deadline = Date.now() + this.lockWaitMs;
    while (!handle) {
      try {
        handle = await fs.open(this.lockPath, "wx", 0o600);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          const lockError = new Error(`维护计划存储等待 ${this.lockWaitMs}ms 后仍被另一个读写者占用；请稍后重试。若进程异常退出留下锁文件，请先由维护人员核对后处理，不会自动清除。`);
          lockError.code = "MAINTENANCE_STORE_LOCKED";
          if (throwOnConflict) throw lockError;
          return { success: false, error: { code: lockError.code, message: lockError.message } };
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(LOCK_RETRY_INTERVAL_MS, remainingMs)));
      }
    }

    try {
      await handle.writeFile(JSON.stringify({ token, pid: process.pid, created_at: new Date(this.clock()).toISOString() }), "utf8");
      return await action();
    } finally {
      await handle.close().catch(() => {});
      try {
        const lock = JSON.parse(await fs.readFile(this.lockPath, "utf8"));
        if (lock.token === token) await fs.rm(this.lockPath, { force: true });
      } catch {
        // Leave malformed or replaced lock files in place; a later writer fails closed.
      }
    }
  }

  readSnapshot() {
    return this.#serialize(async () => {
      const document = await this.#withLock(() => readDocument(this.filePath), { throwOnConflict: true });
      return {
        schedules: structuredClone(document.schedules),
        completions: structuredClone(document.completions),
      };
    });
  }

  async listSchedules() {
    return (await this.readSnapshot()).schedules;
  }

  listCompletions({ schedule_id } = {}) {
    return this.readSnapshot().then(({ completions }) => schedule_id === undefined
      ? completions
      : completions.filter((item) => item.schedule_id === schedule_id));
  }

  upsertSchedule(schedule) {
    return this.#serialize(() => this.#withLock(async () => {
      if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
        throw new Error("maintenance_schedule 必须是对象");
      }
      const patch = structuredClone(schedule);
      normalizeSchedule(patch, { allowNullClears: true });
      const document = await readDocument(this.filePath);
      const index = document.schedules.findIndex((item) => item.schedule_id === patch.schedule_id);
      const existing = index < 0 ? null : document.schedules[index];
      if (existing && (existing.device_id !== patch.device_id || existing.maintenance_type !== patch.maintenance_type)) {
        return {
          success: false,
          error: {
            code: "SCHEDULE_IDENTITY_IMMUTABLE",
            message: "已有维护计划的 schedule_id 绑定设备和维护类型不可更换；如目标不同，请创建新的 schedule_id。",
            schedule_id: patch.schedule_id,
          },
        };
      }

      const normalized = existing ? { ...existing } : {};
      for (const [key, value] of Object.entries(patch)) {
        if (key === "schedule_id" && existing) continue;
        if (value === null) delete normalized[key];
        else normalized[key] = value;
      }
      const usageFields = ["usage_since_service", "usage_limit", "usage_unit"];
      const usageClearFields = usageFields.filter((key) => Object.hasOwn(patch, key) && patch[key] === null);
      if (usageClearFields.length > 0 && usageClearFields.length !== usageFields.length) {
        throw new Error("如需清除使用量维护阈值，usage_since_service、usage_limit、usage_unit 必须同时传 null");
      }
      if (usageClearFields.length === usageFields.length) {
        for (const key of usageFields) delete normalized[key];
      }
      const validatedSchedule = normalizeSchedule(normalized);
      if (existing) document.schedules[index] = validatedSchedule;
      else document.schedules.push(validatedSchedule);
      document.schedules.sort((left, right) => left.schedule_id.localeCompare(right.schedule_id));
      await writeDocument(this.filePath, document);
      return { success: true, created: index < 0, updated: index >= 0, schedule: structuredClone(validatedSchedule) };
    }));
  }

  recordCompletion({ schedule_id, completed_at, user_confirmed } = {}) {
    return this.#serialize(() => this.#withLock(async () => {
      if (user_confirmed !== true) {
        return { success: false, error: { code: "EXPLICIT_CONFIRMATION_REQUIRED", message: "只有用户明确表示实体维护已经完成后，才能记录；未修改维护计划。" } };
      }
      if (typeof schedule_id !== "string" || !schedule_id.trim()) {
        return { success: false, error: { code: "INVALID_SCHEDULE_ID", message: "schedule_id 必须是非空字符串。" } };
      }
      const completedAtMs = completed_at === undefined ? this.clock() : parseTimestamp(completed_at, "completed_at");
      const nowMs = this.clock();
      if (completedAtMs > nowMs) {
        return { success: false, error: { code: "COMPLETION_TIME_IN_FUTURE", message: "completed_at 不能晚于当前时间；未修改维护计划。" } };
      }

      const document = await readDocument(this.filePath);
      const index = document.schedules.findIndex((item) => item.schedule_id === schedule_id);
      if (index < 0) return { success: false, error: { code: "SCHEDULE_NOT_FOUND", message: "没有找到该维护计划；未记录完成。", schedule_id } };

      const current = document.schedules[index];
      const completionTimestamp = new Date(completedAtMs).toISOString();
      const sameTimestampRecord = document.completions.find((item) => item.schedule_id === schedule_id
        && item.completed_at === completionTimestamp);
      const latestForSchedule = document.completions
        .filter((item) => item.schedule_id === schedule_id)
        .sort((left, right) => Date.parse(right.recorded_at) - Date.parse(left.recorded_at))[0];
      const recentOmittedTimeRetry = completed_at === undefined
        && latestForSchedule
        && nowMs >= Date.parse(latestForSchedule.recorded_at)
        && nowMs - Date.parse(latestForSchedule.recorded_at) <= 60_000;
      const duplicate = sameTimestampRecord ?? (recentOmittedTimeRetry ? latestForSchedule : null);
      if (duplicate) {
        return {
          success: true,
          duplicate: true,
          completion_recorded: false,
          physical_maintenance_performed_by_agent: false,
          schedule: structuredClone(current),
          completion: structuredClone(duplicate),
          next_due_known: Number.isFinite(current.interval_days),
        };
      }
      const installedAtMs = current.installed_at ? Date.parse(current.installed_at) : null;
      const lastCompletedAtMs = current.last_completed_at ? Date.parse(current.last_completed_at) : null;
      if ((installedAtMs !== null && completedAtMs < installedAtMs)
        || (lastCompletedAtMs !== null && completedAtMs < lastCompletedAtMs)) {
        return {
          success: false,
          error: {
            code: "COMPLETION_TIME_OUT_OF_ORDER",
            message: "完成时间不能早于设备安装时间或最近一次维护记录；未修改维护计划。",
            schedule_id,
          },
        };
      }
      const previousNextDueAt = current.next_due_at ?? null;
      const usageBefore = Number.isFinite(current.usage_since_service)
        ? { value: current.usage_since_service, unit: current.usage_unit }
        : null;
      const nextDueMs = Number.isFinite(current.interval_days)
        ? completedAtMs + current.interval_days * DAY_MS
        : null;
      const updated = { ...current, last_completed_at: new Date(completedAtMs).toISOString() };
      if (Number.isFinite(current.usage_since_service)) updated.usage_since_service = 0;
      if (nextDueMs === null) delete updated.next_due_at;
      else updated.next_due_at = new Date(nextDueMs).toISOString();

      const completion = {
        record_id: randomUUID(),
        schedule_id,
        device_id: current.device_id,
        maintenance_type: current.maintenance_type,
        completed_at: updated.last_completed_at,
        recorded_at: new Date(nowMs).toISOString(),
        previous_next_due_at: previousNextDueAt,
        next_due_at: updated.next_due_at ?? null,
        usage_before: usageBefore,
        usage_reset_to: usageBefore ? 0 : null,
      };
      document.schedules[index] = updated;
      document.completions.push(completion);
      await writeDocument(this.filePath, document);
      return {
        success: true,
        completion_recorded: true,
        physical_maintenance_performed_by_agent: false,
        schedule: structuredClone(updated),
        completion: structuredClone(completion),
        next_due_known: nextDueMs !== null,
      };
    }));
  }
}

export const MAINTENANCE_SCHEDULE_STORE_SCHEMA = STORE_SCHEMA;
