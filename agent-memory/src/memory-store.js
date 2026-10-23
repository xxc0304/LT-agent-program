import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SQLiteMemoryRepository } from "./sqlite-memory-repository.js";

export const MEMORY_SCHEMA_VERSION = "0.6";
export const MEMORY_KEYS = Object.freeze({
  comfort_temperature_c: "comfort_temperature_c",
  comfort_brightness_pct: "comfort_brightness_pct",
  sleep_time: "sleep_time",
  wake_time: "wake_time",
});

const MAX_CONFIDENCE = 1;
const DEFAULT_CANDIDATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_EVIDENCE_EVENT_IDS = 30;

function clone(value) {
  return structuredClone(value);
}

function timestamp(clock) {
  return new Date(clock()).toISOString();
}

function memoryStoreLockedError() {
  const error = new Error("家庭记忆文件正被另一个写入者使用；请稍后重试。若写入进程异常退出，需先确认进程已结束，再人工检查残留锁。");
  error.code = "MEMORY_STORE_LOCKED";
  return error;
}

async function replaceWithCopyFallback(temporaryPath, targetPath, backupPath) {
  let hadOriginal = true;
  try {
    await fs.copyFile(targetPath, backupPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    hadOriginal = false;
  }

  try {
    await fs.copyFile(temporaryPath, targetPath);
    await fs.rm(temporaryPath, { force: true });
    if (hadOriginal) await fs.rm(backupPath, { force: true });
  } catch (error) {
    try {
      if (hadOriginal) await fs.copyFile(backupPath, targetPath);
      else await fs.rm(targetPath, { force: true });
    } catch (restoreError) {
      error.restore_error = restoreError instanceof Error ? restoreError.message : String(restoreError);
    }
    throw error;
  }
}

export function defaultMemoryPath(env = process.env) {
  if (env.FAMILY_MEMORY_PATH) return path.resolve(env.FAMILY_MEMORY_PATH);
  const base = env.LOCALAPPDATA
    ?? env.XDG_DATA_HOME
    ?? path.join(os.homedir(), ".local", "share");
  return path.join(base, "LT-agent-program", "family-memory-v0.1.json");
}

export function defaultMemoryDatabasePath(env = process.env) {
  if (env.FAMILY_MEMORY_DB_PATH) return path.resolve(env.FAMILY_MEMORY_DB_PATH);
  if (env.OPENCLAW_STATE_DIR) {
    return path.join(path.resolve(env.OPENCLAW_STATE_DIR), "device-manager", "family-memory.sqlite");
  }
  const base = env.LOCALAPPDATA
    ?? env.XDG_DATA_HOME
    ?? path.join(os.homedir(), ".local", "share");
  return path.join(base, "LT-agent-program", "device-manager", "family-memory.sqlite");
}

export async function importJsonMemoryToSQLite({ sourcePath, databasePath = defaultMemoryDatabasePath() } = {}) {
  if (typeof sourcePath !== "string" || !sourcePath.trim()) {
    throw new TypeError("sourcePath must be a non-empty JSON file path");
  }
  if (typeof databasePath !== "string" || !databasePath.trim()) {
    throw new TypeError("databasePath must be a non-empty SQLite file path");
  }
  const source = path.resolve(sourcePath);
  const target = path.resolve(databasePath);
  if (source === target) {
    const error = new Error("JSON 源文件与 SQLite 目标路径不能相同；未修改任何文件。");
    error.code = "MEMORY_IMPORT_PATH_CONFLICT";
    throw error;
  }

  let document;
  try {
    document = normalizeMemoryDocument(JSON.parse(await fs.readFile(source, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") throw error;
    const wrapped = new Error("源 JSON 不是可识别的家庭记忆数据；未创建或修改导入内容。", { cause: error });
    wrapped.code = "MEMORY_IMPORT_SOURCE_INVALID";
    throw wrapped;
  }

  const repository = new SQLiteMemoryRepository({ databasePath: target, schemaVersion: MEMORY_SCHEMA_VERSION });
  try {
    return repository.importDocumentIfEmpty(document);
  } finally {
    repository.close();
  }
}

function validatePreference({ memory_type, value, room_id, day_type, subject_id, time_zone }) {
  if (!Object.values(MEMORY_KEYS).includes(memory_type)) {
    return { code: "UNSUPPORTED_MEMORY_TYPE", message: "只支持温度、灯光亮度、睡觉时间和起床时间偏好。" };
  }
  if (memory_type === MEMORY_KEYS.comfort_temperature_c) {
    if (!Number.isFinite(value) || value < 16 || value > 30) {
      return { code: "INVALID_TEMPERATURE", message: "舒适温度必须是 16–30℃ 之间的数字。" };
    }
  } else if (memory_type === MEMORY_KEYS.comfort_brightness_pct) {
    if (!Number.isFinite(value) || value < 1 || value > 100) {
      return { code: "INVALID_BRIGHTNESS", message: "舒适亮度必须是 1–100% 之间的数字。" };
    }
  } else if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    return { code: "INVALID_LOCAL_TIME", message: "作息时间请使用 24 小时制 HH:mm。" };
  }

  const isNumericPreference = [MEMORY_KEYS.comfort_temperature_c, MEMORY_KEYS.comfort_brightness_pct].includes(memory_type);
  if (!isNumericPreference && !time_zone) {
    return { code: "TIME_ZONE_REQUIRED", message: "睡觉/起床时间偏好必须关联家庭 IANA 时区。" };
  }
  if (time_zone !== undefined) {
    if (isNumericPreference) {
      return { code: "TIME_ZONE_NOT_APPLICABLE", message: "温度或灯光亮度偏好不需要时区。" };
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: time_zone });
    } catch {
      return { code: "INVALID_TIME_ZONE", message: "time_zone 必须是有效的 IANA 时区名称。" };
    }
  }

  if (room_id !== undefined && (typeof room_id !== "string" || !/^[a-z0-9_-]{1,40}$/.test(room_id))) {
    return { code: "INVALID_ROOM_ID", message: "room_id 只能使用小写字母、数字、下划线和连字符。" };
  }
  if (day_type !== undefined && !["all", "weekday", "weekend"].includes(day_type)) {
    return { code: "INVALID_DAY_TYPE", message: "day_type 必须是 all、weekday 或 weekend。" };
  }
  if (subject_id !== undefined && (typeof subject_id !== "string" || !/^[a-z0-9_-]{1,40}$/.test(subject_id))) {
    return { code: "INVALID_SUBJECT_ID", message: "subject_id 请使用 household、adult_1 等非身份标识。" };
  }
  return null;
}

function scopeFor({ room_id, day_type, time_zone }) {
  return {
    ...(room_id ? { room_id } : {}),
    ...(day_type && day_type !== "all" ? { day_type } : {}),
    ...(time_zone ? { time_zone } : {}),
  };
}

function unitFor(memory_type) {
  if (memory_type === MEMORY_KEYS.comfort_temperature_c) return "°C";
  if (memory_type === MEMORY_KEYS.comfort_brightness_pct) return "%";
  return null;
}

function withConfidenceSemantics(memory) {
  if (memory.confidence_semantics) return memory;
  if (memory.source === "user_explicit") {
    return { ...memory, confidence_semantics: "explicit_user_assertion" };
  }
  if (["repeated_observation_unconfirmed", "repeated_observation_user_confirmed"].includes(memory.source)) {
    return { ...memory, confidence_semantics: "mean_input_observation_confidence" };
  }
  return memory;
}

function isOpenCandidate(memory) {
  return ["observing", "pending_confirmation", "conflict_review"].includes(memory.status);
}

function matchesCandidateGroup(memory, { memory_type, subject_id, observation_scope, scope }) {
  return isOpenCandidate(memory)
    && memory.legacy_requires_reobservation !== true
    && memory.memory_type === memory_type
    && (memory.observation_scope ?? "routine") === observation_scope
    && memory.subject_id === subject_id
    && sameScope(memory.scope, scope);
}

export function normalizeMemoryDocument(parsed) {
  if (!parsed || !Array.isArray(parsed.memories)) {
    throw new Error("家庭记忆文件结构无效；请保留文件并检查版本迁移。");
  }
  if (parsed.schema_version === MEMORY_SCHEMA_VERSION) {
    return {
      ...parsed,
      memories: parsed.memories.map(withConfidenceSemantics),
      settings: {
        behavior_observation_enabled: false,
        device_action_observation_enabled: false,
        routine_reminder_schedule_enabled: false,
        ...(parsed.settings ?? {}),
      },
    };
  }
  if (parsed.schema_version === "0.5") {
    return {
      ...parsed,
      schema_version: MEMORY_SCHEMA_VERSION,
      memories: parsed.memories.map(withConfidenceSemantics),
      settings: {
        behavior_observation_enabled: false,
        device_action_observation_enabled: false,
        routine_reminder_schedule_enabled: false,
        ...(parsed.settings ?? {}),
      },
    };
  }
  if (parsed.schema_version === "0.4") {
    return {
      ...parsed,
      schema_version: MEMORY_SCHEMA_VERSION,
      memories: parsed.memories.map(withConfidenceSemantics),
      settings: {
        behavior_observation_enabled: false,
        device_action_observation_enabled: false,
        routine_reminder_schedule_enabled: false,
        ...(parsed.settings ?? {}),
      },
    };
  }
  if (parsed.schema_version === "0.3") {
    return {
      ...parsed,
      schema_version: MEMORY_SCHEMA_VERSION,
      memories: parsed.memories.map(withConfidenceSemantics),
      settings: {
        behavior_observation_enabled: false,
        device_action_observation_enabled: false,
        routine_reminder_schedule_enabled: false,
        ...(parsed.settings ?? {}),
      },
    };
  }
  if (parsed.schema_version === "0.2") {
    return {
      schema_version: MEMORY_SCHEMA_VERSION,
      settings: { behavior_observation_enabled: false, device_action_observation_enabled: false, routine_reminder_schedule_enabled: false },
      memories: parsed.memories.map((memory) => {
        if (["observing", "pending_confirmation"].includes(memory.status)
          && memory.source === "repeated_observation_unconfirmed") {
          return withConfidenceSemantics({ ...memory, legacy_requires_reobservation: true });
        }
        return withConfidenceSemantics(memory);
      }),
    };
  }
  if (parsed.schema_version === "0.1") {
    return {
      schema_version: MEMORY_SCHEMA_VERSION,
      settings: { behavior_observation_enabled: false, device_action_observation_enabled: false, routine_reminder_schedule_enabled: false },
      memories: parsed.memories.map((memory) => {
        if (["observing", "pending_confirmation"].includes(memory.status)
          && memory.source === "repeated_observation_unconfirmed") {
          return withConfidenceSemantics({ ...memory, legacy_requires_reobservation: true });
        }
        return withConfidenceSemantics(memory);
      }),
    };
  }
  throw new Error("家庭记忆文件版本不受支持；请保留文件并检查版本迁移。");
}

function validateObservationDate(observation_date) {
  if (typeof observation_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(observation_date)) {
    return { code: "OBSERVATION_DATE_REQUIRED", message: "候选记忆需要来源事件在家庭时区下的本地日期（YYYY-MM-DD）。" };
  }
  const date = new Date(`${observation_date}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== observation_date) {
    return { code: "INVALID_OBSERVATION_DATE", message: "observation_date 不是有效的日历日期。" };
  }
  return null;
}

function sameScope(left = {}, right = {}) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateExpiresAt(expires_at, now) {
  if (expires_at === undefined || expires_at === null) return null;
  const time = Date.parse(expires_at);
  if (!Number.isFinite(time) || time <= now) {
    return { code: "INVALID_EXPIRY", message: "expires_at 必须是未来的 ISO 8601 时间。" };
  }
  return null;
}

/**
 * Local-only MVP memory store. It persists small, consented preference values;
 * it never stores raw chat text, images, video, credentials, or device snapshots.
 * Writes are serialized per instance and coordinated across processes with an
 * exclusive lock file on local filesystems. Reads fail closed while that lock
 * exists. Stale locks are not recovered automatically; network filesystems are
 * unsupported.
 */
export class PreferenceMemoryStore {
  constructor({
    filePath = defaultMemoryPath(),
    databasePath = defaultMemoryDatabasePath(),
    backend = process.env.FAMILY_MEMORY_BACKEND ?? "json",
    clock = () => Date.now(),
    rename = (source, target) => fs.rename(source, target),
    candidateTtlMs = DEFAULT_CANDIDATE_TTL_MS,
    minCandidateConfidence = 0.8,
    minCandidateObservations = 3,
  } = {}) {
    if (!new Set(["json", "sqlite"]).has(backend)) {
      throw new TypeError("backend must be 'json' or 'sqlite'");
    }
    this.backend = backend;
    this.filePath = backend === "json" ? path.resolve(filePath) : null;
    this.lockPath = backend === "json" ? `${this.filePath}.lock` : null;
    this.databasePath = backend === "sqlite" ? path.resolve(databasePath) : null;
    this.sqliteRepository = null;
    this.opened = false;
    this.clock = clock;
    this.rename = rename;
    this.candidateTtlMs = candidateTtlMs;
    this.minCandidateConfidence = minCandidateConfidence;
    this.minCandidateObservations = minCandidateObservations;
    this.mutationQueue = Promise.resolve();
  }

  close() {
    this.sqliteRepository?.close();
    this.sqliteRepository = null;
    this.opened = false;
  }

  configurePersistence({ backend = this.backend, databasePath } = {}) {
    if (this.opened || this.sqliteRepository) {
      const error = new Error("家庭记忆存储已经打开；后端只能在服务启动前配置。");
      error.code = "MEMORY_STORE_ALREADY_OPEN";
      throw error;
    }
    if (!new Set(["json", "sqlite"]).has(backend)) {
      throw new TypeError("backend must be 'json' or 'sqlite'");
    }
    if (backend === "sqlite") {
      const selectedPath = databasePath
        ?? (this.backend === "sqlite" ? this.databasePath : defaultMemoryDatabasePath());
      if (typeof selectedPath !== "string" || !selectedPath.trim()) {
        throw new TypeError("databasePath must be a non-empty SQLite file path");
      }
      this.databasePath = path.resolve(selectedPath);
      this.filePath = null;
      this.lockPath = null;
    } else {
      if (databasePath !== undefined) {
        throw new TypeError("databasePath is only valid when backend is 'sqlite'");
      }
      this.filePath = path.resolve(this.filePath ?? defaultMemoryPath());
      this.lockPath = `${this.filePath}.lock`;
      this.databasePath = null;
    }
    this.backend = backend;
    return { success: true, backend: this.backend, databasePath: this.databasePath };
  }

  open() {
    if (this.backend === "sqlite" && !this.sqliteRepository) {
      this.sqliteRepository = new SQLiteMemoryRepository({
        databasePath: this.databasePath,
        schemaVersion: MEMORY_SCHEMA_VERSION,
      });
    }
    this.opened = true;
    return { success: true, backend: this.backend };
  }

  async saveExplicitPreference(input = {}) {
    if (input.user_explicit_request !== true) {
      return { success: false, error: { code: "EXPLICIT_INTENT_REQUIRED", message: "只有用户明确要求记住/长期采用的偏好才能保存。" } };
    }
    const validation = validatePreference(input);
    if (validation) return { success: false, error: validation };
    const now = this.clock();
    const expiryError = validateExpiresAt(input.expires_at, now);
    if (expiryError) return { success: false, error: expiryError };

    return this.#mutate((document) => {
      const scope = scopeFor(input);
      const subject_id = input.subject_id ?? "household";
      const existing = document.memories.find((memory) => memory.status === "confirmed"
        && memory.memory_type === input.memory_type
        && memory.subject_id === subject_id
        && sameScope(memory.scope, scope));
      const record = {
        ...(existing ?? { memory_id: randomUUID(), created_at: timestamp(this.clock) }),
        memory_type: input.memory_type,
        value: input.value,
        unit: unitFor(input.memory_type),
        subject_id,
        scope,
        status: "confirmed",
        source: "user_explicit",
        confidence: 1,
        confidence_semantics: "explicit_user_assertion",
        consent: "explicit",
        evidence_event_ids: [],
        observation_count: 0,
        updated_at: timestamp(this.clock),
        expires_at: input.expires_at ?? null,
      };
      document.memories = document.memories.filter((memory) => !(isOpenCandidate(memory)
        && memory.memory_type === input.memory_type
        && memory.subject_id === subject_id
        && sameScope(memory.scope, scope)));
      if (existing) {
        document.memories = document.memories.map((memory) => memory.memory_id === existing.memory_id ? record : memory);
      } else {
        document.memories.push(record);
      }
      return { success: true, memory: record };
    });
  }

  async getObservationConsent() {
    const document = await this.#read();
    return {
      success: true,
      enabled: document.settings?.behavior_observation_enabled === true,
      updated_at: document.settings?.behavior_observation_updated_at ?? null,
      scope: "routine_behavior_only",
    };
  }

  async setObservationConsent({ enabled, user_explicit_confirmation = false } = {}) {
    if (typeof enabled !== "boolean") {
      return { success: false, error: { code: "INVALID_CONSENT_VALUE", message: "enabled 必须是布尔值。" } };
    }
    if (user_explicit_confirmation !== true) {
      return { success: false, error: { code: "EXPLICIT_CONSENT_REQUIRED", message: "启用或撤回行为观察都必须来自用户当前的明确指令。" } };
    }
    return this.#mutate((document) => {
      document.settings ??= {};
      document.settings.behavior_observation_enabled = enabled;
      document.settings.behavior_observation_updated_at = timestamp(this.clock);
      let deleted_inferred_memory_count = 0;
      if (!enabled) {
        const before = document.memories.length;
        document.memories = document.memories.filter((memory) => ![
          "repeated_observation_unconfirmed",
          "repeated_observation_user_confirmed",
        ].includes(memory.source) || memory.observation_scope === "device_action");
        deleted_inferred_memory_count = before - document.memories.length;
      }
      return {
        success: true,
        enabled,
        scope: "routine_behavior_only",
        deleted_inferred_memory_count,
        note: enabled
          ? "已开启作息行为观察授权；这不会自动控制设备。"
          : "已撤回作息观察授权，并删除由作息观察推断的记忆；设备行为观察授权和用户明确保存的偏好不受影响。",
      };
    });
  }

  async getDeviceActionObservationConsent() {
    const document = await this.#read();
    return {
      success: true,
      enabled: document.settings?.device_action_observation_enabled === true,
      updated_at: document.settings?.device_action_observation_updated_at ?? null,
      scope: "ha_direct_authenticated_user_device_actions_only",
    };
  }

  async setDeviceActionObservationConsent({ enabled, user_explicit_confirmation = false } = {}) {
    if (typeof enabled !== "boolean") {
      return { success: false, error: { code: "INVALID_CONSENT_VALUE", message: "enabled 必须是布尔值。" } };
    }
    if (user_explicit_confirmation !== true) {
      return { success: false, error: { code: "EXPLICIT_CONSENT_REQUIRED", message: "开启或撤回设备操作观察必须来自用户当前的明确指令。" } };
    }
    return this.#mutate((document) => {
      document.settings ??= {};
      document.settings.device_action_observation_enabled = enabled;
      document.settings.device_action_observation_updated_at = timestamp(this.clock);
      let deleted_inferred_memory_count = 0;
      if (!enabled) {
        const before = document.memories.length;
        document.memories = document.memories.filter((memory) => memory.observation_scope !== "device_action");
        deleted_inferred_memory_count = before - document.memories.length;
      }
      return {
        success: true,
        enabled,
        scope: "ha_direct_authenticated_user_device_actions_only",
        deleted_inferred_memory_count,
        note: enabled
          ? "已开启 HA 已登录用户直接设备操作观察授权；只产生候选，不会控制设备。"
          : "已撤回设备操作观察授权，并删除由设备操作观察推断出的记忆；其他作息记忆和用户明确保存的偏好不受影响。",
      };
    });
  }

  async getRoutineReminderConsent() {
    const document = await this.#read();
    return {
      success: true,
      enabled: document.settings?.routine_reminder_schedule_enabled === true,
      updated_at: document.settings?.routine_reminder_schedule_updated_at ?? null,
      scope: "confirmed_routine_reminders_only",
    };
  }

  async setRoutineReminderConsent({ enabled, user_explicit_confirmation = false } = {}) {
    if (typeof enabled !== "boolean") {
      return { success: false, error: { code: "INVALID_CONSENT_VALUE", message: "enabled 必须是布尔值。" } };
    }
    if (user_explicit_confirmation !== true) {
      return { success: false, error: { code: "EXPLICIT_CONSENT_REQUIRED", message: "开启或撤回作息提醒必须来自用户当前的明确指令。" } };
    }
    return this.#mutate((document) => {
      document.settings ??= {};
      document.settings.routine_reminder_schedule_enabled = enabled;
      document.settings.routine_reminder_schedule_updated_at = timestamp(this.clock);
      return {
        success: true,
        enabled,
        scope: "confirmed_routine_reminders_only",
        note: enabled
          ? "已保存作息提醒授权；只有运行器及通知通道也已配置时才会实际触发提醒。"
          : "已撤回作息提醒授权；运行器下次检查时会停止调度。已确认的作息偏好不会被删除。",
      };
    });
  }

  async proposeInferredCandidate(input = {}) {
    const observationScope = input.observation_scope ?? "routine";
    if (!["routine", "device_action"].includes(observationScope)) {
      return { success: false, error: { code: "INVALID_OBSERVATION_SCOPE", message: "observation_scope 只支持 routine 或 device_action。" } };
    }
    if (input.consent_to_observe !== true) {
      return { success: false, error: { code: "MEMORY_CONSENT_REQUIRED", message: "进行行为推测前必须获得对应范围的用户同意；未同意时不保存候选。" } };
    }
    const validation = validatePreference(input);
    if (validation) return { success: false, error: validation };
    const dateError = validateObservationDate(input.observation_date);
    if (dateError) return { success: false, error: dateError };
    if (typeof input.event_id !== "string" || !input.event_id) {
      return { success: false, error: { code: "EVENT_ID_REQUIRED", message: "候选记忆必须关联事件 ID，不能保存原始对话或媒体。" } };
    }
    if (!Number.isFinite(input.confidence) || input.confidence < this.minCandidateConfidence || input.confidence > MAX_CONFIDENCE) {
      return { success: false, error: { code: "LOW_CONFIDENCE", message: `单条观察置信度必须达到 ${this.minCandidateConfidence}，否则不保存候选。该数值不是偏好成立概率。` } };
    }

    return this.#mutate((document) => {
      const consentSetting = observationScope === "device_action"
        ? "device_action_observation_enabled"
        : "behavior_observation_enabled";
      if (document.settings?.[consentSetting] !== true) {
        return { success: false, error: { code: "MEMORY_CONSENT_REQUIRED", message: observationScope === "device_action"
          ? "当前没有已保存的设备操作观察授权；未记录候选。"
          : "当前没有已保存的作息观察授权；未记录候选。" } };
      }
      const scope = scopeFor(input);
      const subject_id = input.subject_id ?? "household";
      const group = { memory_type: input.memory_type, subject_id, observation_scope: observationScope, scope };
      const now = this.clock();
      const isActiveCandidate = (memory) => matchesCandidateGroup(memory, group)
        && (!memory.expires_at || Date.parse(memory.expires_at) > now);
      let candidate = document.memories.find((memory) => isActiveCandidate(memory) && memory.value === input.value);
      let conflictingCandidates = document.memories.filter((memory) => isActiveCandidate(memory) && memory.value !== input.value);
      const confirmedPreference = document.memories.find((memory) => memory.status === "confirmed"
        && memory.memory_type === input.memory_type
        && memory.subject_id === subject_id
        && sameScope(memory.scope, scope));
      const conflictsWithConfirmed = Boolean(confirmedPreference && confirmedPreference.value !== input.value);
      if (candidate?.evidence_event_ids.includes(input.event_id)) {
        return { success: true, deduplicated: true, memory: candidate };
      }
      if (candidate?.evidence_dates?.includes(input.observation_date)) {
        return { success: true, deduplicated: true, duplicate_reason: "OBSERVATION_DATE_ALREADY_COUNTED", memory: candidate };
      }
      if (!candidate) {
        candidate = {
          memory_id: randomUUID(),
          memory_type: input.memory_type,
          value: input.value,
          unit: unitFor(input.memory_type),
          subject_id,
          scope,
          status: conflictingCandidates.length || conflictsWithConfirmed ? "conflict_review" : "observing",
          source: "repeated_observation_unconfirmed",
          observation_scope: observationScope,
          confidence: input.confidence,
          confidence_semantics: "mean_input_observation_confidence",
          consent: "observation_opt_in",
          evidence_event_ids: [],
          evidence_dates: [],
          observation_count: 0,
          created_at: timestamp(this.clock),
          updated_at: timestamp(this.clock),
          expires_at: new Date(this.clock() + this.candidateTtlMs).toISOString(),
        };
        document.memories.push(candidate);
      }
      if (conflictingCandidates.length || conflictsWithConfirmed) {
        for (const conflictingCandidate of conflictingCandidates) {
          conflictingCandidate.status = "conflict_review";
          conflictingCandidate.updated_at = timestamp(this.clock);
        }
        candidate.status = "conflict_review";
      }
      if (candidate.status === "pending_confirmation") {
        return { success: true, pending_confirmation: true, conflict_detected: false, memory: candidate };
      }
      const priorCount = candidate.observation_count;
      candidate.observation_count += 1;
      candidate.evidence_event_ids = [...candidate.evidence_event_ids, input.event_id].slice(-MAX_EVIDENCE_EVENT_IDS);
      candidate.evidence_dates = [...(candidate.evidence_dates ?? []), input.observation_date];
      candidate.confidence = Math.min(MAX_CONFIDENCE,
        ((candidate.confidence * priorCount) + input.confidence) / candidate.observation_count);
      candidate.confidence_semantics = "mean_input_observation_confidence";
      if (candidate.status !== "conflict_review" && candidate.observation_count >= this.minCandidateObservations) {
        candidate.status = "pending_confirmation";
      }
      candidate.updated_at = timestamp(this.clock);
      candidate.expires_at = new Date(this.clock() + this.candidateTtlMs).toISOString();
      conflictingCandidates = document.memories.filter((memory) => isActiveCandidate(memory)
        && memory.memory_id !== candidate.memory_id
        && memory.value !== candidate.value);
      if (conflictsWithConfirmed) {
        conflictingCandidates.push(confirmedPreference);
      }
      return {
        success: true,
        deduplicated: false,
        conflict_detected: candidate.status === "conflict_review",
        ...(candidate.status === "conflict_review" ? {
          conflicting_candidates: conflictingCandidates.map((memory) => ({
            memory_id: memory.memory_id,
            value: memory.value,
            status: memory.status,
            observation_count: memory.observation_count ?? 0,
            evidence_dates: memory.evidence_dates ?? [],
          })),
        } : {}),
        memory: candidate,
      };
    });
  }

  async confirmCandidate(memory_id, { user_confirmed = false } = {}) {
    if (user_confirmed !== true) {
      return { success: false, error: { code: "USER_CONFIRMATION_REQUIRED", message: "候选记忆必须经用户明确确认后才能成为正式偏好。" } };
    }
    return this.#mutate((document) => {
      const candidate = document.memories.find((memory) => memory.memory_id === memory_id);
      if (candidate && candidate.status !== "conflict_review") {
        const candidateGroup = {
          memory_type: candidate.memory_type,
          subject_id: candidate.subject_id,
          observation_scope: candidate.observation_scope ?? "routine",
          scope: candidate.scope,
        };
        const conflictingCandidates = document.memories.filter((memory) => memory.memory_id !== candidate.memory_id
          && matchesCandidateGroup(memory, candidateGroup)
          && memory.value !== candidate.value);
        const confirmedPreference = document.memories.find((memory) => memory.status === "confirmed"
          && memory.memory_type === candidate.memory_type
          && memory.subject_id === candidate.subject_id
          && sameScope(memory.scope, candidate.scope));
        const conflictsWithConfirmed = Boolean(confirmedPreference && confirmedPreference.value !== candidate.value);
        if (conflictingCandidates.length || conflictsWithConfirmed) {
          candidate.status = "conflict_review";
          candidate.updated_at = timestamp(this.clock);
          for (const conflictingCandidate of conflictingCandidates) {
            conflictingCandidate.status = "conflict_review";
            conflictingCandidate.updated_at = timestamp(this.clock);
          }
          return {
            success: false,
            conflict_detected: true,
            error: { code: "CONFLICTING_CANDIDATES", message: "同一偏好范围存在不同观察值；候选已进入冲突待处理，请先展示全部候选并由用户选择。" },
            conflicting_candidates: [candidate, ...conflictingCandidates,
              ...(conflictsWithConfirmed ? [confirmedPreference] : [])].map((memory) => ({
              memory_id: memory.memory_id,
              value: memory.value,
              status: memory.status,
              observation_count: memory.observation_count ?? 0,
              evidence_dates: memory.evidence_dates ?? [],
            })),
          };
        }
      }
      if (candidate?.legacy_requires_reobservation === true) {
        return { success: false, error: { code: "CANDIDATE_REQUIRES_REOBSERVATION", message: "旧版候选缺少不同日期证据；请重新观察或删除该候选，不能直接确认。" } };
      }
      if (candidate && (!Array.isArray(candidate.evidence_dates)
        || candidate.evidence_dates.length < this.minCandidateObservations)) {
        return { success: false, error: { code: "INSUFFICIENT_DISTINCT_DAYS", message: "候选尚未达到不同日期的最少观察次数。" } };
      }
      if (candidate && (!["pending_confirmation", "conflict_review"].includes(candidate.status)
        || (candidate.expires_at && Date.parse(candidate.expires_at) <= this.clock()))) {
        return { success: false, error: { code: "MEMORY_NOT_FOUND", message: "没有找到有效的待确认记忆候选。" } };
      }
      if (!candidate) return { success: false, error: { code: "MEMORY_NOT_FOUND", message: "没有找到待确认的记忆候选。" } };
      const candidateGroup = {
        memory_type: candidate.memory_type,
        subject_id: candidate.subject_id,
        observation_scope: candidate.observation_scope ?? "routine",
        scope: candidate.scope,
      };
      const resolvedCandidates = document.memories.filter((memory) => memory.memory_id !== candidate.memory_id
        && matchesCandidateGroup(memory, candidateGroup));
      const existing = document.memories.find((memory) => memory.status === "confirmed"
        && memory.memory_type === candidate.memory_type
        && memory.subject_id === candidate.subject_id
        && sameScope(memory.scope, candidate.scope));
      const confirmed = {
        ...candidate,
        ...(existing ? { memory_id: existing.memory_id, created_at: existing.created_at } : {}),
        status: "confirmed",
        source: "repeated_observation_user_confirmed",
        observation_scope: candidate.observation_scope ?? "routine",
        consent: "user_confirmed",
        updated_at: timestamp(this.clock),
        expires_at: null,
      };
      document.memories = document.memories.filter((memory) => memory.memory_id !== candidate.memory_id
        && (!existing || memory.memory_id !== existing.memory_id)
        && !resolvedCandidates.some((resolved) => resolved.memory_id === memory.memory_id));
      document.memories.push(confirmed);
      return {
        success: true,
        memory: confirmed,
        ...(candidate.status === "conflict_review" ? {
          resolved_conflict_count: resolvedCandidates.length
            + (existing && existing.value !== candidate.value ? 1 : 0),
        } : {}),
      };
    });
  }

  async getPreference({ memory_type, room_id, day_type = "all", time_zone, subject_id = "household" } = {}) {
    const document = await this.#read();
    const now = this.clock();
    const requestedScope = scopeFor({ room_id, day_type, time_zone });
    const appliesToRequest = (memory) => memory.memory_type === memory_type
      && memory.subject_id === subject_id
      && (!memory.expires_at || Date.parse(memory.expires_at) > now)
      && Object.entries(memory.scope ?? {}).every(([key, value]) => requestedScope[key] === value);
    const scopeSpecificity = (memory) => Object.keys(memory.scope ?? {}).length;
    const confirmed = document.memories
      .filter((memory) => memory.status === "confirmed" && appliesToRequest(memory))
      .sort((left, right) => scopeSpecificity(right) - scopeSpecificity(left)
        || Date.parse(right.updated_at) - Date.parse(left.updated_at))[0] ?? null;

    // A more-specific conflict makes a broader confirmed value unsafe to use.
    // Preserve the existing specificity fallback when a narrower confirmed
    // preference already overrides a broader conflict.
    const applicableConflicts = document.memories
      .filter((memory) => memory.status === "conflict_review" && appliesToRequest(memory))
      .filter((memory) => scopeSpecificity(memory) >= (confirmed ? scopeSpecificity(confirmed) : 0));
    if (applicableConflicts.length) {
      const mostSpecificConflict = Math.max(...applicableConflicts.map(scopeSpecificity));
      const conflictRecords = applicableConflicts.filter((memory) => scopeSpecificity(memory) === mostSpecificConflict);
      const conflictScopes = [...new Map(conflictRecords.map((memory) => [
        JSON.stringify(memory.scope ?? {}), memory.scope ?? {},
      ])).values()];
      const candidates = [];
      for (const conflict of conflictRecords) {
        const priorConfirmed = document.memories.find((memory) => memory.status === "confirmed"
          && memory.memory_type === memory_type
          && memory.subject_id === subject_id
          && sameScope(memory.scope ?? {}, conflict.scope ?? {})
          && (!memory.expires_at || Date.parse(memory.expires_at) > now));
        if (priorConfirmed) candidates.push(priorConfirmed);
      }
      candidates.push(...conflictRecords);
      const uniqueCandidates = [...new Map(candidates.map((memory) => [
        `${JSON.stringify(memory.scope ?? {})}:${String(memory.value)}`,
        {
          memory_id: memory.memory_id,
          value: memory.value,
          status: memory.status,
          source: memory.source,
          observation_count: memory.observation_count ?? 0,
        },
      ])).values()];
      return clone({
        status: "conflict_review",
        memory_type,
        subject_id,
        conflict_scopes: conflictScopes,
        candidates: uniqueCandidates,
        requires_user_resolution: true,
      });
    }

    return clone(confirmed);
  }

  async listMemories({ includePending = false, memory_type, subject_id } = {}) {
    const document = await this.#read();
    const now = this.clock();
    return clone(document.memories.filter((memory) => (includePending || memory.status === "confirmed")
      && (!memory_type || memory.memory_type === memory_type)
      && (!subject_id || memory.subject_id === subject_id)
      && (!memory.expires_at || Date.parse(memory.expires_at) > now)));
  }

  async deleteMemory(memory_id) {
    return this.#mutate((document) => {
      const before = document.memories.length;
      document.memories = document.memories.filter((memory) => memory.memory_id !== memory_id);
      return document.memories.length === before
        ? { success: false, error: { code: "MEMORY_NOT_FOUND", message: "没有找到该记忆。" } }
        : { success: true, deleted: true, memory_id };
    });
  }

  async purgeExpired() {
    return this.#mutate((document) => {
      const now = this.clock();
      const before = document.memories.length;
      document.memories = document.memories.filter((memory) => !memory.expires_at || Date.parse(memory.expires_at) > now);
      return { success: true, deleted_count: before - document.memories.length };
    });
  }

  async #read() {
    await this.mutationQueue;
    if (this.backend === "sqlite") {
      this.open();
      return normalizeMemoryDocument(this.sqliteRepository.readDocument());
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.#assertNoOtherWriter();
      try {
        const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
        await this.#assertNoOtherWriter();
        return normalizeMemoryDocument(parsed);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await this.#assertNoOtherWriter();
        if (attempt === 1) return { schema_version: MEMORY_SCHEMA_VERSION, memories: [] };
      }
    }
    return { schema_version: MEMORY_SCHEMA_VERSION, memories: [] };
  }

  async #assertNoOtherWriter() {
    try {
      await fs.access(this.lockPath);
      throw memoryStoreLockedError();
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
  }

  #mutate(mutator) {
    const operation = this.mutationQueue.then(async () => {
      if (this.backend === "sqlite") {
        this.open();
        return this.sqliteRepository.mutate(mutator);
      }
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const lockToken = randomUUID();
      let lockHandle;
      try {
        lockHandle = await fs.open(this.lockPath, "wx", 0o600);
      } catch (error) {
        if (error.code === "EEXIST") {
          return {
            success: false,
            error: {
              code: "MEMORY_STORE_LOCKED",
              message: "家庭记忆文件正被另一个写入者使用，或存在上次异常退出留下的锁；请勿并行写入。确认相关进程已结束后，再按说明人工检查并移除残留锁。",
            },
          };
        }
        throw error;
      }

      try {
        await lockHandle.writeFile(JSON.stringify({ token: lockToken, pid: process.pid, created_at: timestamp(this.clock) }), "utf8");
        const document = await this.#readFileWithoutQueue();
        const result = mutator(document);
        const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
        const backupPath = `${this.filePath}.${process.pid}.backup`;
        await fs.writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        try {
          await this.rename(temporaryPath, this.filePath);
        } catch (error) {
          if (!["EPERM", "EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
          // Some Windows filesystems/sandboxes reject rename even when the
          // destination does not yet exist. Use a locked, recoverable copy
          // fallback instead of assuming an original file is present.
          await replaceWithCopyFallback(temporaryPath, this.filePath, backupPath);
        }
        return clone(result);
      } finally {
        await lockHandle.close();
        try {
          const lock = JSON.parse(await fs.readFile(this.lockPath, "utf8"));
          if (lock.token === lockToken) await fs.rm(this.lockPath, { force: true });
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    });
    this.mutationQueue = operation.catch(() => {});
    return operation;
  }

  async #readFileWithoutQueue() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      return normalizeMemoryDocument(parsed);
    } catch (error) {
      if (error.code === "ENOENT") return { schema_version: MEMORY_SCHEMA_VERSION, memories: [] };
      throw error;
    }
  }
}
