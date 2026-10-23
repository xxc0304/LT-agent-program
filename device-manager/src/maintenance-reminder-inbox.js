import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";

const SCHEMA_VERSION = "device-manager.maintenance-reminder-inbox/0.4";
const LEGACY_SCHEMA_VERSIONS = new Set([
  "device-manager.maintenance-reminder-inbox/0.1",
  "device-manager.maintenance-reminder-inbox/0.2",
  "device-manager.maintenance-reminder-inbox/0.3",
]);
const VALID_DUE_STATUSES = new Set(["DUE_SOON", "DUE", "OVERDUE"]);
const VALID_NOTIFICATION_STATES = new Set(["pending", "acknowledged", "snoozed", "completed"]);
const STATUS_RANK = Object.freeze({ DUE_SOON: 1, DUE: 2, OVERDUE: 3 });
const MAX_ITEMS = 500;
const MIN_SNOOZE_MINUTES = 5;
const MAX_SNOOZE_MINUTES = 30 * 24 * 60;

function emptyDocument() {
  return { schema_version: SCHEMA_VERSION, notifications: [], archived_notifications: [] };
}

function isoTime(value, field) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} 必须是有效 ISO 时间字符串`);
  }
  return value;
}

function validateNotification(item, index, { archived = false } = {}) {
  if (!item || typeof item !== "object" || Array.isArray(item)
    || typeof item.notification_id !== "string"
    || typeof item.cycle_key !== "string"
    || typeof item.schedule_id !== "string"
    || typeof item.device_id !== "string"
    || typeof item.maintenance_type !== "string"
    || !VALID_DUE_STATUSES.has(item.maintenance_status)
    || !VALID_NOTIFICATION_STATES.has(item.status)) {
    throw new Error(`维护提醒记录 ${index} 结构无效；为避免覆盖数据，已停止读写`);
  }
  if (item.device_name !== undefined && typeof item.device_name !== "string") {
    throw new Error(`维护提醒记录 ${index}.device_name 无效；为避免覆盖数据，已停止读写`);
  }
  if (item.next_due_at !== null) isoTime(item.next_due_at, `notifications[${index}].next_due_at`);
  isoTime(item.created_at, `notifications[${index}].created_at`);
  isoTime(item.updated_at, `notifications[${index}].updated_at`);
  const snoozedUntil = item.snoozed_until ?? null;
  const completedAt = item.completed_at ?? null;
  if (item.status === "pending" && (item.acknowledged_at !== null || completedAt !== null)) {
    throw new Error(`维护提醒记录 ${index} 的 pending 状态不能带 acknowledged_at`);
  }
  if (item.status === "acknowledged") {
    isoTime(item.acknowledged_at, `notifications[${index}].acknowledged_at`);
    if (completedAt !== null) throw new Error(`维护提醒记录 ${index} 的 acknowledged 状态不能带 completed_at`);
  }
  if (item.status === "snoozed") {
    isoTime(snoozedUntil, `notifications[${index}].snoozed_until`);
    if (item.acknowledged_at !== null || completedAt !== null) throw new Error(`维护提醒记录 ${index} 的 snoozed 状态不能带 acknowledged_at/completed_at`);
  } else if (snoozedUntil !== null) {
    throw new Error(`维护提醒记录 ${index} 的非 snoozed 状态不能带 snoozed_until`);
  }
  if (item.status === "completed") {
    isoTime(completedAt, `notifications[${index}].completed_at`);
    if (item.acknowledged_at !== null) isoTime(item.acknowledged_at, `notifications[${index}].acknowledged_at`);
  } else if (completedAt !== null) {
    throw new Error(`维护提醒记录 ${index} 的非 completed 状态不能带 completed_at`);
  }
  if (archived) {
    if (item.status !== "completed") throw new Error(`归档提醒记录 ${index} 不是 completed 状态；为避免覆盖数据，已停止读写`);
    isoTime(item.archived_at, `archived_notifications[${index}].archived_at`);
  } else if (item.archived_at !== undefined) {
    throw new Error(`活动提醒记录 ${index} 不能包含 archived_at；为避免覆盖数据，已停止读写`);
  }
  return { ...structuredClone(item), snoozed_until: snoozedUntil, completed_at: completedAt };
}

function validateDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (value.schema_version !== SCHEMA_VERSION && !LEGACY_SCHEMA_VERSIONS.has(value.schema_version))
    || !Array.isArray(value.notifications)
    || value.notifications.length > MAX_ITEMS
    || (value.schema_version === SCHEMA_VERSION && !Array.isArray(value.archived_notifications))) {
    throw new Error("维护提醒收件箱结构无效或版本不受支持；为避免覆盖数据，已停止读写");
  }
  const notifications = value.notifications.map((item, index) => validateNotification(item, index));
  const archivedNotifications = (value.archived_notifications ?? [])
    .map((item, index) => validateNotification(item, index, { archived: true }));
  const ids = new Set();
  for (const item of [...notifications, ...archivedNotifications]) {
    if (ids.has(item.notification_id)) throw new Error(`维护提醒 notification_id 重复：${item.notification_id}`);
    ids.add(item.notification_id);
  }
  return { schema_version: SCHEMA_VERSION, notifications, archived_notifications: archivedNotifications };
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
    throw new Error("维护提醒收件箱不是有效 JSON；为避免覆盖数据，已停止读写");
  }
  return validateDocument(parsed);
}

async function writeDocument(filePath, document) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    if (error?.code !== "EPERM" && error?.code !== "EEXIST") {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
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
}

function notificationId(cycleKey) {
  return `maintenance-${createHash("sha256").update(cycleKey).digest("hex").slice(0, 24)}`;
}

export function resolveMaintenanceReminderInboxPath(env = process.env) {
  if (typeof env.DEVICE_MANAGER_MAINTENANCE_REMINDER_INBOX_PATH === "string"
    && env.DEVICE_MANAGER_MAINTENANCE_REMINDER_INBOX_PATH.trim()) {
    return path.resolve(env.DEVICE_MANAGER_MAINTENANCE_REMINDER_INBOX_PATH.trim());
  }
  const stateDir = typeof env.OPENCLAW_STATE_DIR === "string" && env.OPENCLAW_STATE_DIR.trim()
    ? path.resolve(env.OPENCLAW_STATE_DIR.trim())
    : path.join(os.homedir(), ".openclaw");
  return path.join(stateDir, "device-manager", "maintenance-reminders.json");
}

/** Durable local inbox. It queues maintenance reminders but never sends them externally. */
export class MaintenanceReminderInbox {
  constructor({ filePath = resolveMaintenanceReminderInboxPath(), clock = () => Date.now() } = {}) {
    if (typeof filePath !== "string" || !filePath.trim()) throw new Error("维护提醒收件箱需要有效 filePath");
    if (typeof clock !== "function") throw new Error("维护提醒收件箱 clock 必须是函数");
    this.filePath = path.resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.clock = clock;
    this.operation = Promise.resolve();
  }

  #serialize(action) {
    const result = this.operation.then(action, action);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  async #withLock(action) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const token = randomUUID();
    let handle;
    try {
      handle = await fs.open(this.lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") return { success: false, error: { code: "INBOX_LOCKED", message: "维护提醒收件箱正被另一个写入者使用；请稍后重试。" } };
      throw error;
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

  upsertDueReminders({ plan_items, schedules, observed_at = new Date(this.clock()).toISOString() } = {}) {
    if (!Array.isArray(plan_items) || !Array.isArray(schedules)) {
      return Promise.resolve({ success: false, error: { code: "INVALID_REMINDER_INPUT", message: "plan_items 和 schedules 必须是数组。" } });
    }
    try {
      isoTime(observed_at, "observed_at");
    } catch (error) {
      return Promise.resolve({ success: false, error: { code: "INVALID_REMINDER_INPUT", message: error.message } });
    }
    const schedulesById = new Map(schedules.map((schedule) => [schedule.schedule_id, schedule]));
    const eligible = plan_items.filter((item) => VALID_DUE_STATUSES.has(item?.maintenance_status));
    return this.#serialize(() => this.#withLock(async () => {
      let document;
      try {
        document = await readDocument(this.filePath);
      } catch (error) {
        return { success: false, error: { code: "INBOX_READ_FAILED", message: error instanceof Error ? error.message : String(error) } };
      }
      const nowIso = new Date(this.clock()).toISOString();
      let created = 0;
      let updated = 0;
      let duplicate = 0;
      let reopenedSnoozes = 0;
      for (const entry of document.notifications) {
        if (entry.status === "snoozed" && Date.parse(entry.snoozed_until) <= Date.parse(nowIso)) {
          entry.status = "pending";
          entry.snoozed_until = null;
          entry.updated_at = nowIso;
          reopenedSnoozes += 1;
        }
      }
      for (const item of eligible) {
        const schedule = schedulesById.get(item.schedule_id);
        if (!schedule || typeof item.schedule_id !== "string" || typeof item.device_id !== "string") continue;
        const anchor = item.next_due_at
          ?? schedule.last_completed_at
          ?? schedule.installed_at
          ?? "usage-cycle-unanchored";
        const cycleKey = `${item.schedule_id}|${anchor}`;
        const id = notificationId(cycleKey);
        const existing = document.notifications.find((entry) => entry.notification_id === id)
          ?? document.archived_notifications.find((entry) => entry.notification_id === id);
        if (existing) {
          if (existing.status === "completed") {
            duplicate += 1;
            continue;
          }
          const isEscalation = STATUS_RANK[item.maintenance_status] > STATUS_RANK[existing.maintenance_status];
          if (!isEscalation) {
            duplicate += 1;
            continue;
          }
          existing.maintenance_status = item.maintenance_status;
          existing.next_due_at = item.next_due_at ?? null;
          existing.updated_at = nowIso;
          if (item.maintenance_status === "OVERDUE" && ["acknowledged", "snoozed"].includes(existing.status)) {
            existing.status = "pending";
            existing.acknowledged_at = null;
            existing.snoozed_until = null;
          }
          updated += 1;
          continue;
        }
        if (document.notifications.length >= MAX_ITEMS) {
          return { success: false, error: { code: "INBOX_CAPACITY_REACHED", message: "活动维护提醒达到 500 条上限；可先按截止日期归档已完成提醒，待处理提醒不会被自动移除。" }, created, updated, duplicate };
        }
        document.notifications.push({
          notification_id: id,
          cycle_key: cycleKey,
          schedule_id: schedule.schedule_id,
          device_id: schedule.device_id,
          ...(typeof schedule.device_name === "string" ? { device_name: schedule.device_name } : {}),
          maintenance_type: schedule.maintenance_type,
          maintenance_status: item.maintenance_status,
          next_due_at: item.next_due_at ?? null,
          status: "pending",
          snoozed_until: null,
          completed_at: null,
          created_at: nowIso,
          updated_at: nowIso,
          acknowledged_at: null,
        });
        created += 1;
      }
      if (created > 0 || updated > 0 || reopenedSnoozes > 0) {
        document.notifications.sort((left, right) => left.created_at.localeCompare(right.created_at));
        await writeDocument(this.filePath, document);
      }
      return { success: true, created, updated, skipped_as_duplicate: duplicate, snoozed_reopened: reopenedSnoozes, checked_at: observed_at };
    }).catch((error) => ({ success: false, error: { code: "INBOX_WRITE_FAILED", message: error instanceof Error ? error.message : String(error) } })));
  }

  async list({ include_acknowledged = false, include_snoozed = false, include_completed = false, include_archived = false, limit = 20, offset = 0, cursor } = {}) {
    if (typeof include_acknowledged !== "boolean" || typeof include_snoozed !== "boolean"
      || typeof include_completed !== "boolean" || typeof include_archived !== "boolean"
      || !Number.isInteger(limit) || limit < 1 || limit > 50
      || !Number.isInteger(offset) || offset < 0 || offset > MAX_ITEMS
      || (cursor !== undefined && (typeof cursor !== "string" || !/^maintenance-[a-f0-9]{24}$/.test(cursor)))
      || (cursor !== undefined && offset !== 0)) {
      return { success: false, error: { code: "INVALID_LIST_OPTIONS", message: "include_acknowledged、include_snoozed、include_completed 和 include_archived 必须为布尔值，limit 必须为 1 到 50，offset 必须为 0 到 500 的整数；cursor 必须是有效提醒 ID，且不能与非零 offset 同时使用。" }, notifications: [], total_count: 0, next_offset: null, next_cursor: null };
    }
    return this.#serialize(() => this.#withLock(async () => {
      let document;
      try {
        document = await readDocument(this.filePath);
      } catch (error) {
        return { success: false, error: { code: "INBOX_READ_FAILED", message: error instanceof Error ? error.message : String(error) }, notifications: [] };
      }
      const nowIso = new Date(this.clock()).toISOString();
      let reopened = false;
      for (const item of document.notifications) {
        if (item.status === "snoozed" && Date.parse(item.snoozed_until) <= Date.parse(nowIso)) {
          item.status = "pending";
          item.snoozed_until = null;
          item.updated_at = nowIso;
          reopened = true;
        }
      }
      if (reopened) {
        try {
          await writeDocument(this.filePath, document);
        } catch (error) {
          return { success: false, error: { code: "INBOX_WRITE_FAILED", message: error instanceof Error ? error.message : String(error) }, notifications: [] };
        }
      }
      const ordered = [...document.notifications, ...document.archived_notifications]
        .sort((left, right) => left.created_at.localeCompare(right.created_at)
          || left.notification_id.localeCompare(right.notification_id))
        .reverse();
      const matching = ordered
        .filter((item) => item.status === "pending"
          || (include_acknowledged && item.status === "acknowledged")
          || (include_snoozed && item.status === "snoozed")
          || (include_completed && item.status === "completed" && item.archived_at === undefined)
          || (include_archived && item.archived_at !== undefined));
      let pageItems;
      let hasMore;
      if (cursor !== undefined) {
        const cursorIndex = ordered.findIndex((item) => item.notification_id === cursor);
        if (cursorIndex < 0) {
          return { success: false, error: { code: "INVALID_LIST_CURSOR", message: "分页游标对应的提醒已不存在；请从第一页重新查询。" }, notifications: [], total_count: matching.length, next_offset: null, next_cursor: null };
        }
        const afterCursor = ordered.slice(cursorIndex + 1).filter((item) => matching.includes(item));
        pageItems = afterCursor.slice(0, limit);
        hasMore = afterCursor.length > pageItems.length;
      } else {
        pageItems = matching.slice(offset, offset + limit);
        hasMore = offset + pageItems.length < matching.length;
      }
      const notifications = pageItems
        .map((item) => ({
          ...item,
          archived: item.archived_at !== undefined,
          message: item.status === "completed"
            ? `${item.device_name ?? item.device_id} 的本周期维护已记录于 ${item.completed_at}；如需当前维护状态，请查询维护计划。`
            : `${item.device_name ?? item.device_id} 的维护计划目前为 ${item.maintenance_status}；维护计划查询结果才是当前状态。此提醒仅为本地记录，不代表已执行维护。`,
        }));
      return {
        success: true,
        status: notifications.length ? "REMINDERS_FOUND" : "NO_PENDING_REMINDERS",
        notifications,
        total_count: matching.length,
        next_offset: cursor === undefined && hasMore ? offset + notifications.length : null,
        next_cursor: hasMore && notifications.length > 0 ? notifications.at(-1).notification_id : null,
      };
    }).catch((error) => ({ success: false, error: { code: "INBOX_IO_FAILED", message: error instanceof Error ? error.message : String(error) }, notifications: [], total_count: 0, next_offset: null, next_cursor: null })));
  }

  archiveCompletedBefore({ completed_before, user_confirmed = false } = {}) {
    if (user_confirmed !== true) {
      return Promise.resolve({ success: false, error: { code: "USER_ARCHIVE_CONFIRMATION_REQUIRED", message: "归档会将符合条件的已完成提醒移出活动收件箱；必须先向用户说明截止日期并取得明确确认。" } });
    }
    try {
      isoTime(completed_before, "completed_before");
    } catch (error) {
      return Promise.resolve({ success: false, error: { code: "INVALID_ARCHIVE_CUTOFF", message: error.message } });
    }
    return this.#serialize(() => this.#withLock(async () => {
      let document;
      try {
        document = await readDocument(this.filePath);
      } catch (error) {
        return { success: false, error: { code: "INBOX_READ_FAILED", message: error instanceof Error ? error.message : String(error) } };
      }
      const cutoffMs = Date.parse(completed_before);
      const archivedAt = new Date(this.clock()).toISOString();
      const kept = [];
      const newlyArchived = [];
      for (const item of document.notifications) {
        if (item.status === "completed" && Date.parse(item.completed_at) <= cutoffMs) {
          newlyArchived.push({ ...item, archived_at: archivedAt });
        } else {
          kept.push(item);
        }
      }
      if (newlyArchived.length > 0) {
        document.notifications = kept;
        document.archived_notifications.push(...newlyArchived);
        await writeDocument(this.filePath, document);
      }
      return {
        success: true,
        status: newlyArchived.length > 0 ? "ARCHIVED" : "NO_MATCHING_COMPLETED_REMINDERS",
        completed_before,
        archived_count: newlyArchived.length,
        active_count: document.notifications.length,
        archive_retained: true,
        notifications_deleted: false,
      };
    }).catch((error) => ({ success: false, error: { code: "INBOX_IO_FAILED", message: error instanceof Error ? error.message : String(error) } })));
  }

  completeForSchedule({ schedule_id, completed_at } = {}) {
    if (typeof schedule_id !== "string" || !schedule_id.trim()) {
      return Promise.resolve({ success: false, error: { code: "INVALID_SCHEDULE_ID", message: "schedule_id 必须是非空字符串。" } });
    }
    try {
      isoTime(completed_at, "completed_at");
    } catch (error) {
      return Promise.resolve({ success: false, error: { code: "INVALID_COMPLETION_TIME", message: error.message } });
    }
    return this.#serialize(() => this.#withLock(async () => {
      let document;
      try {
        document = await readDocument(this.filePath);
      } catch (error) {
        return { success: false, error: { code: "INBOX_READ_FAILED", message: error instanceof Error ? error.message : String(error) } };
      }
      const completionMs = Date.parse(completed_at);
      const nowIso = new Date(this.clock()).toISOString();
      let resolved = 0;
      for (const item of document.notifications) {
        if (item.schedule_id !== schedule_id || item.status === "completed"
          || Date.parse(item.created_at) > completionMs) continue;
        item.status = "completed";
        item.completed_at = completed_at;
        item.snoozed_until = null;
        item.updated_at = nowIso;
        resolved += 1;
      }
      if (resolved > 0) {
        try {
          await writeDocument(this.filePath, document);
        } catch (error) {
          return { success: false, error: { code: "INBOX_WRITE_FAILED", message: error instanceof Error ? error.message : String(error) } };
        }
      }
      return {
        success: true,
        status: resolved ? "COMPLETED" : "NO_MATCHING_REMINDERS",
        schedule_id,
        completed_at,
        resolved_count: resolved,
      };
    }).catch((error) => ({ success: false, error: { code: "INBOX_IO_FAILED", message: error instanceof Error ? error.message : String(error) } })));
  }

  snooze({ notification_id, snooze_for_minutes, user_requested = false } = {}) {
    if (typeof notification_id !== "string" || !/^maintenance-[a-f0-9]{24}$/.test(notification_id)) {
      return Promise.resolve({ success: false, error: { code: "INVALID_NOTIFICATION_ID", message: "维护提醒 notification_id 格式无效。" } });
    }
    if (user_requested !== true) {
      return Promise.resolve({ success: false, error: { code: "USER_SNOOZE_REQUEST_REQUIRED", message: "只有用户明确要求稍后提醒时才能暂缓提醒。" } });
    }
    if (!Number.isInteger(snooze_for_minutes) || snooze_for_minutes < MIN_SNOOZE_MINUTES || snooze_for_minutes > MAX_SNOOZE_MINUTES) {
      return Promise.resolve({ success: false, error: { code: "INVALID_SNOOZE_DURATION", message: `snooze_for_minutes 必须为 ${MIN_SNOOZE_MINUTES} 到 ${MAX_SNOOZE_MINUTES} 之间的整数。` } });
    }
    return this.#serialize(() => this.#withLock(async () => {
      let document;
      try {
        document = await readDocument(this.filePath);
      } catch (error) {
        return { success: false, error: { code: "INBOX_READ_FAILED", message: error instanceof Error ? error.message : String(error) } };
      }
      const item = document.notifications.find((entry) => entry.notification_id === notification_id);
      if (!item) return { success: false, error: { code: "REMINDER_NOT_FOUND", message: "未找到这条维护提醒。" } };
      if (item.status === "completed") return { success: false, error: { code: "REMINDER_ALREADY_COMPLETED", message: "这条提醒对应的维护已记录完成。" } };
      if (item.status === "acknowledged") {
        return { success: false, error: { code: "REMINDER_ALREADY_ACKNOWLEDGED", message: "已读提醒不能再暂缓；如维护仍未完成，请查询当前维护计划。" } };
      }
      const now = this.clock();
      const nowIso = new Date(now).toISOString();
      const snoozedUntil = new Date(now + snooze_for_minutes * 60_000).toISOString();
      item.status = "snoozed";
      item.snoozed_until = snoozedUntil;
      item.completed_at = null;
      item.acknowledged_at = null;
      item.updated_at = nowIso;
      try {
        await writeDocument(this.filePath, document);
      } catch (error) {
        return { success: false, error: { code: "INBOX_WRITE_FAILED", message: error instanceof Error ? error.message : String(error) } };
      }
      return {
        success: true,
        status: "SNOOZED",
        notification_id,
        snoozed_until: snoozedUntil,
        maintenance_completed: false,
        notification_delivered: false,
      };
    }).catch((error) => ({ success: false, error: { code: "INBOX_IO_FAILED", message: error instanceof Error ? error.message : String(error) } })));
  }

  acknowledge({ notification_id, user_acknowledged = false } = {}) {
    if (typeof notification_id !== "string" || !/^maintenance-[a-f0-9]{24}$/.test(notification_id)) {
      return Promise.resolve({ success: false, error: { code: "INVALID_NOTIFICATION_ID", message: "维护提醒 notification_id 格式无效。" } });
    }
    if (user_acknowledged !== true) {
      return Promise.resolve({ success: false, error: { code: "USER_ACKNOWLEDGEMENT_REQUIRED", message: "只有用户明确表示已知晓提醒后，才能标记为已读；这不代表维护已完成。" } });
    }
    return this.#serialize(() => this.#withLock(async () => {
      let document;
      try {
        document = await readDocument(this.filePath);
      } catch (error) {
        return { success: false, error: { code: "INBOX_READ_FAILED", message: error instanceof Error ? error.message : String(error) } };
      }
      const item = document.notifications.find((entry) => entry.notification_id === notification_id);
      if (!item) return { success: false, error: { code: "REMINDER_NOT_FOUND", message: "未找到这条维护提醒。" } };
      if (item.status === "completed") return { success: false, error: { code: "REMINDER_ALREADY_COMPLETED", message: "这条提醒对应的维护已记录完成。" } };
      if (item.status === "acknowledged") return { success: true, status: "ALREADY_ACKNOWLEDGED", notification_id };
      const nowIso = new Date(this.clock()).toISOString();
      item.status = "acknowledged";
      item.acknowledged_at = nowIso;
      item.snoozed_until = null;
      item.updated_at = nowIso;
      try {
        await writeDocument(this.filePath, document);
      } catch (error) {
        return { success: false, error: { code: "INBOX_WRITE_FAILED", message: error instanceof Error ? error.message : String(error) } };
      }
      return { success: true, status: "ACKNOWLEDGED", notification_id, maintenance_completed: false };
    }).catch((error) => ({ success: false, error: { code: "INBOX_IO_FAILED", message: error instanceof Error ? error.message : String(error) } })));
  }
}

export const MAINTENANCE_REMINDER_INBOX_SCHEMA = SCHEMA_VERSION;
export const MAINTENANCE_REMINDER_SNOOZE_LIMITS = Object.freeze({
  minimumMinutes: MIN_SNOOZE_MINUTES,
  maximumMinutes: MAX_SNOOZE_MINUTES,
});
