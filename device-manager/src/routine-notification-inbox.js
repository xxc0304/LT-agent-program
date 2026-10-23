import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";

const INBOX_SCHEMA_VERSION = "0.1";
const DEFAULT_RETENTION_LIMIT = 200;
const VALID_ROUTINE_TYPES = new Set(["sleep_time", "wake_time"]);

function failure(code, message, details = {}) {
  return { success: false, status: "REJECTED", error: { code, message, ...details } };
}

function validTimeZone(timeZone) {
  if (typeof timeZone !== "string" || !timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateDueEvent(event, idempotencyKey) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return "作息提醒事件必须是 JSON 对象。";
  if (event.event_type !== "routine_due" || typeof event.event_id !== "string" || !event.event_id) {
    return "只接受带 event_id 的 routine_due 事件。";
  }
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "作息提醒事件缺少有效 payload。";
  if (!VALID_ROUTINE_TYPES.has(payload.routine_type)) return "提醒类型只支持 sleep_time 或 wake_time。";
  if (payload.proposed_action !== "notify_user" || payload.requires_user_confirmation_before_device_action !== true) {
    return "事件必须仅建议通知用户，并保留设备动作确认边界。";
  }
  if (!validDate(payload.local_date)) return "提醒事件的 local_date 无效。";
  if (typeof payload.local_time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(payload.local_time)) {
    return "提醒事件的 local_time 必须是有效 HH:mm。";
  }
  if (!validTimeZone(payload.time_zone)) return "提醒事件的家庭时区无效。";
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()
    || idempotencyKey !== event.dedup_key) return "接收器需要与事件 dedup_key 一致的幂等键。";
  return null;
}

function validateInbox(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schema_version !== INBOX_SCHEMA_VERSION || !Array.isArray(value.notifications)) {
    throw new Error("作息提醒收件箱格式无效；为避免丢失数据，已停止修改。 ");
  }
  for (const item of value.notifications) {
    if (!item || typeof item !== "object"
      || typeof item.notification_id !== "string"
      || !VALID_ROUTINE_TYPES.has(item.routine_type)
      || !validDate(item.local_date)
      || typeof item.local_time !== "string"
      || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item.local_time)
      || !validTimeZone(item.time_zone)
      || !["pending", "acknowledged"].includes(item.status)
      || typeof item.created_at !== "string"
      || !Number.isFinite(Date.parse(item.created_at))
      || (item.status === "pending" && item.acknowledged_at !== null)
      || (item.status === "acknowledged"
        && (typeof item.acknowledged_at !== "string" || !Number.isFinite(Date.parse(item.acknowledged_at))))
      || (item.message !== undefined)) {
      throw new Error("作息提醒收件箱包含无效记录；为避免丢失数据，已停止修改。 ");
    }
  }
  return value.notifications;
}

async function readDocument(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(text);
    return { schema_version: INBOX_SCHEMA_VERSION, notifications: validateInbox(parsed) };
  } catch (error) {
    if (error?.code === "ENOENT") return { schema_version: INBOX_SCHEMA_VERSION, notifications: [] };
    throw error;
  }
}

async function writeDocument(filePath, document) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
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

export function resolveRoutineNotificationInboxPath(env = process.env) {
  if (typeof env.DEVICE_MANAGER_ROUTINE_INBOX_PATH === "string" && env.DEVICE_MANAGER_ROUTINE_INBOX_PATH.trim()) {
    return path.resolve(env.DEVICE_MANAGER_ROUTINE_INBOX_PATH.trim());
  }
  const base = env.LOCALAPPDATA ?? env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(base, "LT-agent-program", "routine-notifications.json");
}

/**
 * Local durable inbox used as a routine_due event sink.
 * It queues notices for OpenClaw to display; it never pushes messages or
 * executes device actions.
 */
export class RoutineNotificationInbox {
  constructor({ filePath = resolveRoutineNotificationInboxPath(), clock = () => Date.now(), retentionLimit = DEFAULT_RETENTION_LIMIT } = {}) {
    if (typeof filePath !== "string" || !filePath.trim()) throw new Error("作息提醒收件箱需要 filePath。");
    if (!Number.isInteger(retentionLimit) || retentionLimit < 1 || retentionLimit > DEFAULT_RETENTION_LIMIT) {
      throw new Error(`收件箱 retentionLimit 必须是 1 到 ${DEFAULT_RETENTION_LIMIT} 之间的整数。`);
    }
    this.filePath = path.resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.clock = clock;
    this.retentionLimit = retentionLimit;
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
      if (error?.code === "EEXIST") return failure("INBOX_LOCKED", "作息提醒收件箱正被另一个写入者使用；请稍后重试。");
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
        // A malformed/replaced lock is left in place; a later writer must fail closed.
      }
    }
  }

  enqueue(event, { idempotencyKey = event?.dedup_key } = {}) {
    const invalid = validateDueEvent(event, idempotencyKey);
    if (invalid) return Promise.resolve(failure("INVALID_ROUTINE_DUE_EVENT", invalid));

    return this.#serialize(() => this.#withLock(async () => {
      let document;
      try {
        document = await readDocument(this.filePath);
      } catch (error) {
        return failure("INBOX_READ_FAILED", error instanceof Error ? error.message : String(error));
      }
      const notificationId = `routine-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 24)}`;
      const existing = document.notifications.find((item) => item.notification_id === notificationId);
      if (existing) {
        return { success: true, status: "DUPLICATE", duplicate: true, notification_id: notificationId };
      }

      const pendingCount = document.notifications.filter((item) => item.status === "pending").length;
      if (pendingCount >= this.retentionLimit) {
        return failure("INBOX_CAPACITY_REACHED", "待处理提醒已达到收件箱容量；请先查看或确认已读提醒。", { pending_count: pendingCount });
      }
      const acknowledged = document.notifications.filter((item) => item.status === "acknowledged");
      const acknowledgedCapacity = Math.max(0, this.retentionLimit - pendingCount - 1);
      const retainedAcknowledged = acknowledgedCapacity > 0
        ? acknowledged.slice(-acknowledgedCapacity)
        : [];
      const notification = {
        notification_id: notificationId,
        routine_type: event.payload.routine_type,
        local_date: event.payload.local_date,
        local_time: event.payload.local_time,
        time_zone: event.payload.time_zone,
        status: "pending",
        created_at: new Date(this.clock()).toISOString(),
        acknowledged_at: null,
      };
      const notifications = [...retainedAcknowledged, ...document.notifications.filter((item) => item.status === "pending"), notification];
      try {
        await writeDocument(this.filePath, { schema_version: INBOX_SCHEMA_VERSION, notifications });
      } catch (error) {
        return failure("INBOX_WRITE_FAILED", error instanceof Error ? error.message : String(error));
      }
      return { success: true, status: "QUEUED", duplicate: false, notification_id: notificationId };
    }).catch((error) => failure("INBOX_IO_FAILED", error instanceof Error ? error.message : String(error))));
  }

  async list({ include_acknowledged = false, limit = 20 } = {}) {
    if (typeof include_acknowledged !== "boolean") return failure("INVALID_INCLUDE_ACKNOWLEDGED", "include_acknowledged 必须是布尔值。");
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) return failure("INVALID_LIMIT", "limit 必须是 1 到 50 之间的整数。");
    let document;
    try {
      document = await readDocument(this.filePath);
    } catch (error) {
      return failure("INBOX_READ_FAILED", error instanceof Error ? error.message : String(error));
    }
    const notifications = document.notifications
      .filter((item) => include_acknowledged || item.status === "pending")
      .slice(-limit)
      .reverse()
      .map((item) => ({
        ...item,
        message: item.routine_type === "sleep_time"
          ? `作息提醒：现在是你确认的睡觉时间（${item.local_time}）。`
          : `作息提醒：现在是你确认的起床时间（${item.local_time}）。`,
      }));
    return { success: true, status: notifications.length ? "REMINDERS_FOUND" : "NO_PENDING_REMINDERS", notifications };
  }

  acknowledge({ notification_id, user_acknowledged = false } = {}) {
    if (typeof notification_id !== "string" || !/^routine-[a-f0-9]{24}$/.test(notification_id)) {
      return Promise.resolve(failure("INVALID_NOTIFICATION_ID", "notification_id 格式无效。"));
    }
    if (user_acknowledged !== true) {
      return Promise.resolve(failure("USER_ACKNOWLEDGEMENT_REQUIRED", "只有用户明确表示已知晓提醒后，才能标记为已确认。"));
    }
    return this.#serialize(() => this.#withLock(async () => {
      let document;
      try {
        document = await readDocument(this.filePath);
      } catch (error) {
        return failure("INBOX_READ_FAILED", error instanceof Error ? error.message : String(error));
      }
      const item = document.notifications.find((entry) => entry.notification_id === notification_id);
      if (!item) return failure("REMINDER_NOT_FOUND", "没有找到这条待处理作息提醒。");
      if (item.status === "acknowledged") return { success: true, status: "ALREADY_ACKNOWLEDGED", notification_id };
      item.status = "acknowledged";
      item.acknowledged_at = new Date(this.clock()).toISOString();
      try {
        await writeDocument(this.filePath, document);
      } catch (error) {
        return failure("INBOX_WRITE_FAILED", error instanceof Error ? error.message : String(error));
      }
      return { success: true, status: "ACKNOWLEDGED", notification_id };
    }).catch((error) => failure("INBOX_IO_FAILED", error instanceof Error ? error.message : String(error))));
  }
}

export const ROUTINE_NOTIFICATION_INBOX_DEFAULTS = Object.freeze({
  retentionLimit: DEFAULT_RETENTION_LIMIT,
  pushesExternally: false,
  deviceActionsAllowed: false,
});
