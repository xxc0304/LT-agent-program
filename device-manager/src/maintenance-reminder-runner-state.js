import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const SCHEMA_VERSION = "device-manager.maintenance-reminder-runner/0.1";

function emptyState() {
  return { schema_version: SCHEMA_VERSION, auto_resume: false, updated_at: null };
}

function validateState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schema_version !== SCHEMA_VERSION
    || typeof value.auto_resume !== "boolean"
    || !(value.updated_at === null || (typeof value.updated_at === "string" && Number.isFinite(Date.parse(value.updated_at))))) {
    throw new Error("维护提醒恢复状态结构无效或版本不受支持；为避免覆盖数据，已停止读写");
  }
  return structuredClone(value);
}

async function readState(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("维护提醒恢复状态不是有效 JSON；为避免覆盖数据，已停止读写");
  }
  return validateState(parsed);
}

async function writeState(filePath, state) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
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
      await fs.copyFile(filePath, backupPath, fs.constants.COPYFILE_EXCL);
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

export function resolveMaintenanceReminderRunnerStatePath(env = process.env) {
  if (typeof env.DEVICE_MANAGER_MAINTENANCE_REMINDER_RUNNER_STATE_PATH === "string"
    && env.DEVICE_MANAGER_MAINTENANCE_REMINDER_RUNNER_STATE_PATH.trim()) {
    return path.resolve(env.DEVICE_MANAGER_MAINTENANCE_REMINDER_RUNNER_STATE_PATH.trim());
  }
  const stateDir = typeof env.OPENCLAW_STATE_DIR === "string" && env.OPENCLAW_STATE_DIR.trim()
    ? path.resolve(env.OPENCLAW_STATE_DIR.trim())
    : path.join(os.homedir(), ".openclaw");
  return path.join(stateDir, "device-manager", "maintenance-reminder-runner.json");
}

/** Persists only whether a user explicitly requested reminder checks to resume after a Gateway restart. */
export class MaintenanceReminderRunnerStateStore {
  constructor({ filePath = resolveMaintenanceReminderRunnerStatePath(), clock = () => Date.now() } = {}) {
    if (typeof filePath !== "string" || !filePath.trim()) throw new Error("维护提醒恢复状态需要有效 filePath");
    if (typeof clock !== "function") throw new Error("维护提醒恢复状态 clock 必须是函数");
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
      if (error?.code === "EEXIST") return { success: false, error: { code: "RUNNER_STATE_LOCKED", message: "维护提醒恢复状态正被另一个写入者使用；请稍后重试。" } };
      throw error;
    }
    try {
      await handle.writeFile(JSON.stringify({ token, pid: process.pid }), "utf8");
      return await action();
    } finally {
      await handle.close().catch(() => {});
      try {
        const lock = JSON.parse(await fs.readFile(this.lockPath, "utf8"));
        if (lock.token === token) await fs.rm(this.lockPath, { force: true });
      } catch {
        // Leave malformed or replaced lock files in place; later writes fail closed.
      }
    }
  }

  get() {
    return this.#serialize(async () => {
      try {
        const state = await readState(this.filePath);
        return { success: true, auto_resume: state.auto_resume, updated_at: state.updated_at };
      } catch (error) {
        return { success: false, error: { code: "RUNNER_STATE_READ_FAILED", message: error instanceof Error ? error.message : String(error) } };
      }
    });
  }

  setAutoResume(enabled) {
    if (typeof enabled !== "boolean") {
      return Promise.resolve({ success: false, error: { code: "INVALID_RUNNER_STATE", message: "auto_resume 必须为布尔值。" } });
    }
    return this.#serialize(() => this.#withLock(async () => {
      let previous;
      try {
        previous = await readState(this.filePath);
      } catch (error) {
        return { success: false, error: { code: "RUNNER_STATE_READ_FAILED", message: error instanceof Error ? error.message : String(error) } };
      }
      const state = {
        schema_version: SCHEMA_VERSION,
        auto_resume: enabled,
        updated_at: new Date(this.clock()).toISOString(),
      };
      try {
        await writeState(this.filePath, state);
        return { success: true, auto_resume: enabled, previous_auto_resume: previous.auto_resume, updated_at: state.updated_at };
      } catch (error) {
        return { success: false, error: { code: "RUNNER_STATE_WRITE_FAILED", message: error instanceof Error ? error.message : String(error) } };
      }
    }).catch((error) => ({ success: false, error: { code: "RUNNER_STATE_IO_FAILED", message: error instanceof Error ? error.message : String(error) } })));
  }
}

export const MAINTENANCE_REMINDER_RUNNER_STATE_SCHEMA = SCHEMA_VERSION;
