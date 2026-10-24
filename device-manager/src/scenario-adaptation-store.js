import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const SCENARIO_ADAPTATION_SCHEMA_VERSION = "1.0";
export const SCENARIO_FEEDBACK_TYPES = Object.freeze([
  "helpful",
  "not_effective",
  "prefer_device",
  "exclude_device",
  "reset_device_preference",
]);

const MAX_FEEDBACK_RECORDS = 100;
const MAX_EXECUTION_RECORDS = 100;

function clone(value) {
  return structuredClone(value);
}

function timestamp(clock) {
  return new Date(clock()).toISOString();
}

function normalizeArea(value) {
  if (typeof value !== "string") return null;
  const area = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return /^[a-z0-9_]{1,64}$/.test(area) ? area : null;
}

function emptyAreaProfile(areaId) {
  return {
    area_id: areaId,
    preferred_device_ids: [],
    excluded_device_ids: [],
    feedback_counts: Object.fromEntries(SCENARIO_FEEDBACK_TYPES.map((type) => [type, 0])),
    feedback_records: [],
    execution_metrics: {
      execution_count: 0,
      attempted_actions: 0,
      verified_actions: 0,
      failed_actions: 0,
      partial_runs: 0,
      last_outcome: null,
    },
    execution_records: [],
    updated_at: null,
  };
}

function validateDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schema_version !== SCENARIO_ADAPTATION_SCHEMA_VERSION
    || !value.areas || typeof value.areas !== "object" || Array.isArray(value.areas)) {
    throw new Error("场景适配档案格式或版本无效；为避免覆盖数据，已停止加载");
  }
  for (const [areaId, profile] of Object.entries(value.areas)) {
    if (normalizeArea(areaId) !== areaId
      || !profile || typeof profile !== "object"
      || !Array.isArray(profile.preferred_device_ids)
      || !Array.isArray(profile.excluded_device_ids)
      || !profile.feedback_counts || typeof profile.feedback_counts !== "object"
      || !Array.isArray(profile.feedback_records)
      || !profile.execution_metrics || typeof profile.execution_metrics !== "object"
      || !Array.isArray(profile.execution_records)) {
      throw new Error("场景适配档案包含无效条目；为避免覆盖数据，已停止加载");
    }
  }
  return value;
}

export function resolveScenarioAdaptationPath(env = process.env) {
  if (typeof env.DEVICE_MANAGER_SCENARIO_PROFILE_PATH === "string"
    && env.DEVICE_MANAGER_SCENARIO_PROFILE_PATH.trim()) {
    return resolve(env.DEVICE_MANAGER_SCENARIO_PROFILE_PATH.trim());
  }
  const stateDir = typeof env.OPENCLAW_STATE_DIR === "string" && env.OPENCLAW_STATE_DIR.trim()
    ? resolve(env.OPENCLAW_STATE_DIR.trim())
    : join(homedir(), ".openclaw");
  return join(stateDir, "device-manager", "scenario-adaptation.json");
}

/**
 * Stores only explicit, structured scenario feedback and action verification
 * counts. It does not retain prompts, raw conversation, or inferred habits.
 */
export class ScenarioAdaptationStore {
  constructor({ filePath = resolveScenarioAdaptationPath(), clock = () => Date.now() } = {}) {
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new Error("场景适配档案需要有效的 filePath");
    }
    this.filePath = resolve(filePath);
    this.clock = clock;
    this.areas = new Map();
    this.#load();
  }

  #load() {
    if (!existsSync(this.filePath)) return;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      throw new Error("场景适配档案无法解析；为避免覆盖原文件，已停止加载");
    }
    const document = validateDocument(parsed);
    for (const [areaId, profile] of Object.entries(document.areas)) {
      const defaults = emptyAreaProfile(areaId);
      this.areas.set(areaId, { ...defaults, ...clone(profile) });
    }
  }

  #save() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const contents = `${JSON.stringify({
      schema_version: SCENARIO_ADAPTATION_SCHEMA_VERSION,
      updated_at: timestamp(this.clock),
      areas: Object.fromEntries(this.areas),
    }, null, 2)}\n`;
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const backupPath = `${temporaryPath}.backup`;
    writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    try {
      renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try {
        if (error?.code !== "EPERM" && error?.code !== "EEXIST") throw error;
        let hadOriginal = true;
        try {
          copyFileSync(this.filePath, backupPath);
        } catch (copyError) {
          if (copyError?.code !== "ENOENT") throw copyError;
          hadOriginal = false;
        }
        try {
          copyFileSync(temporaryPath, this.filePath);
          unlinkSync(temporaryPath);
          if (hadOriginal) unlinkSync(backupPath);
        } catch (writeError) {
          try {
            if (hadOriginal) copyFileSync(backupPath, this.filePath);
            else if (existsSync(this.filePath)) unlinkSync(this.filePath);
          } catch (restoreError) {
            writeError.restore_error = restoreError instanceof Error ? restoreError.message : String(restoreError);
          }
          throw writeError;
        }
      } catch (writeError) {
        try { if (existsSync(temporaryPath)) unlinkSync(temporaryPath); } catch {}
        throw writeError;
      }
    }
  }

  getArea(areaId) {
    const normalizedArea = normalizeArea(areaId);
    if (!normalizedArea) {
      return { success: false, error: { code: "INVALID_AREA", message: "area_id 必须是有效的房间标识。" } };
    }
    return { success: true, profile: clone(this.areas.get(normalizedArea) ?? emptyAreaProfile(normalizedArea)) };
  }

  recordFeedback({ area_id, feedback_type, device_id } = {}) {
    const normalizedArea = normalizeArea(area_id);
    if (!normalizedArea) {
      return { success: false, error: { code: "INVALID_AREA", message: "area_id 必须是有效的房间标识。" } };
    }
    if (!SCENARIO_FEEDBACK_TYPES.includes(feedback_type)) {
      return { success: false, error: { code: "INVALID_FEEDBACK_TYPE", message: "不支持的场景反馈类型。" } };
    }
    const deviceFeedback = ["prefer_device", "exclude_device", "reset_device_preference"].includes(feedback_type);
    if (deviceFeedback && (typeof device_id !== "string" || !device_id.trim() || device_id.length > 255 || /[\u0000-\u001f]/.test(device_id))) {
      return { success: false, error: { code: "DEVICE_ID_REQUIRED", message: "设备偏好反馈必须提供有效 device_id。" } };
    }
    if (!deviceFeedback && device_id !== undefined) {
      return { success: false, error: { code: "DEVICE_ID_NOT_APPLICABLE", message: "此类反馈不应绑定设备。" } };
    }

    const previous = this.areas.get(normalizedArea) ?? emptyAreaProfile(normalizedArea);
    const next = clone(previous);
    next.feedback_counts[feedback_type] = (next.feedback_counts[feedback_type] ?? 0) + 1;
    if (feedback_type === "prefer_device") {
      next.excluded_device_ids = next.excluded_device_ids.filter((id) => id !== device_id);
      if (!next.preferred_device_ids.includes(device_id)) next.preferred_device_ids.push(device_id);
    } else if (feedback_type === "exclude_device") {
      next.preferred_device_ids = next.preferred_device_ids.filter((id) => id !== device_id);
      if (!next.excluded_device_ids.includes(device_id)) next.excluded_device_ids.push(device_id);
    } else if (feedback_type === "reset_device_preference") {
      next.preferred_device_ids = next.preferred_device_ids.filter((id) => id !== device_id);
      next.excluded_device_ids = next.excluded_device_ids.filter((id) => id !== device_id);
    }
    next.feedback_records.push({
      feedback_type,
      ...(deviceFeedback ? { device_id } : {}),
      recorded_at: timestamp(this.clock),
    });
    next.feedback_records = next.feedback_records.slice(-MAX_FEEDBACK_RECORDS);
    next.updated_at = timestamp(this.clock);
    this.areas.set(normalizedArea, next);
    try {
      this.#save();
    } catch {
      this.areas.set(normalizedArea, previous);
      return { success: false, error: { code: "SCENARIO_PROFILE_PERSIST_FAILED", message: "场景偏好无法安全写入；原档案保持不变。" } };
    }
    return { success: true, profile: clone(next) };
  }

  recordExecution({ area_id, attempted_actions = 0, verified_actions = 0, failed_actions = 0, interrupted = false } = {}) {
    const normalizedArea = normalizeArea(area_id);
    const counts = [attempted_actions, verified_actions, failed_actions];
    if (!normalizedArea || counts.some((count) => !Number.isSafeInteger(count) || count < 0)
      || verified_actions + failed_actions > attempted_actions || typeof interrupted !== "boolean") {
      return { success: false, error: { code: "INVALID_EXECUTION_METRICS", message: "场景执行统计字段无效。" } };
    }
    const previous = this.areas.get(normalizedArea) ?? emptyAreaProfile(normalizedArea);
    const next = clone(previous);
    const outcome = interrupted ? "interrupted"
      : failed_actions === 0 && attempted_actions === verified_actions
        ? "all_attempted_actions_verified"
        : verified_actions > 0 ? "partially_verified" : "not_verified";
    next.execution_metrics.execution_count += 1;
    next.execution_metrics.attempted_actions += attempted_actions;
    next.execution_metrics.verified_actions += verified_actions;
    next.execution_metrics.failed_actions += failed_actions;
    if (outcome !== "all_attempted_actions_verified") next.execution_metrics.partial_runs += 1;
    next.execution_metrics.last_outcome = outcome;
    next.execution_records.push({
      attempted_actions,
      verified_actions,
      failed_actions,
      interrupted,
      outcome,
      recorded_at: timestamp(this.clock),
    });
    next.execution_records = next.execution_records.slice(-MAX_EXECUTION_RECORDS);
    next.updated_at = timestamp(this.clock);
    this.areas.set(normalizedArea, next);
    try {
      this.#save();
    } catch {
      this.areas.set(normalizedArea, previous);
      return { success: false, error: { code: "SCENARIO_PROFILE_PERSIST_FAILED", message: "场景执行评估无法安全写入；原档案保持不变。" } };
    }
    return { success: true, profile: clone(next) };
  }
}
