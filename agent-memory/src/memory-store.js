import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const MEMORY_SCHEMA_VERSION = "0.2";
export const MEMORY_KEYS = Object.freeze({
  comfort_temperature_c: "comfort_temperature_c",
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

export function defaultMemoryPath(env = process.env) {
  if (env.FAMILY_MEMORY_PATH) return path.resolve(env.FAMILY_MEMORY_PATH);
  const base = env.LOCALAPPDATA
    ?? env.XDG_DATA_HOME
    ?? path.join(os.homedir(), ".local", "share");
  return path.join(base, "LT-agent-program", "family-memory-v0.1.json");
}

function validatePreference({ memory_type, value, room_id, day_type, subject_id, time_zone }) {
  if (!Object.values(MEMORY_KEYS).includes(memory_type)) {
    return { code: "UNSUPPORTED_MEMORY_TYPE", message: "只支持温度偏好、睡觉时间和起床时间。" };
  }
  if (memory_type === MEMORY_KEYS.comfort_temperature_c) {
    if (!Number.isFinite(value) || value < 16 || value > 30) {
      return { code: "INVALID_TEMPERATURE", message: "舒适温度必须是 16–30℃ 之间的数字。" };
    }
  } else if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    return { code: "INVALID_LOCAL_TIME", message: "作息时间请使用 24 小时制 HH:mm。" };
  }

  if (memory_type !== MEMORY_KEYS.comfort_temperature_c && !time_zone) {
    return { code: "TIME_ZONE_REQUIRED", message: "睡觉/起床时间偏好必须关联家庭 IANA 时区。" };
  }
  if (time_zone !== undefined) {
    if (memory_type === MEMORY_KEYS.comfort_temperature_c) {
      return { code: "TIME_ZONE_NOT_APPLICABLE", message: "温度偏好不需要时区。" };
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

export function normalizeMemoryDocument(parsed) {
  if (!parsed || !Array.isArray(parsed.memories)) {
    throw new Error("家庭记忆文件结构无效；请保留文件并检查版本迁移。");
  }
  if (parsed.schema_version === MEMORY_SCHEMA_VERSION) return parsed;
  if (parsed.schema_version === "0.1") {
    return {
      schema_version: MEMORY_SCHEMA_VERSION,
      memories: parsed.memories.map((memory) => {
        if (["observing", "pending_confirmation"].includes(memory.status)
          && memory.source === "repeated_observation_unconfirmed") {
          return { ...memory, legacy_requires_reobservation: true };
        }
        return memory;
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
 * One process should own a given file; multi-process locking is not implemented.
 */
export class PreferenceMemoryStore {
  constructor({
    filePath = defaultMemoryPath(),
    clock = () => Date.now(),
    candidateTtlMs = DEFAULT_CANDIDATE_TTL_MS,
    minCandidateConfidence = 0.8,
    minCandidateObservations = 3,
  } = {}) {
    this.filePath = path.resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.clock = clock;
    this.candidateTtlMs = candidateTtlMs;
    this.minCandidateConfidence = minCandidateConfidence;
    this.minCandidateObservations = minCandidateObservations;
    this.mutationQueue = Promise.resolve();
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
        unit: input.memory_type === MEMORY_KEYS.comfort_temperature_c ? "°C" : null,
        subject_id,
        scope,
        status: "confirmed",
        source: "user_explicit",
        confidence: 1,
        consent: "explicit",
        evidence_event_ids: [],
        observation_count: 0,
        updated_at: timestamp(this.clock),
        expires_at: input.expires_at ?? null,
      };
      document.memories = document.memories.filter((memory) => !(memory.status === "pending_confirmation"
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

  async proposeInferredCandidate(input = {}) {
    if (input.consent_to_observe !== true) {
      return { success: false, error: { code: "MEMORY_CONSENT_REQUIRED", message: "推测作息前必须获得用户同意；未同意时不保存候选。" } };
    }
    const validation = validatePreference(input);
    if (validation) return { success: false, error: validation };
    const dateError = validateObservationDate(input.observation_date);
    if (dateError) return { success: false, error: dateError };
    if (typeof input.event_id !== "string" || !input.event_id) {
      return { success: false, error: { code: "EVENT_ID_REQUIRED", message: "候选记忆必须关联事件 ID，不能保存原始对话或媒体。" } };
    }
    if (!Number.isFinite(input.confidence) || input.confidence < this.minCandidateConfidence || input.confidence > MAX_CONFIDENCE) {
      return { success: false, error: { code: "LOW_CONFIDENCE", message: `推测置信度必须达到 ${this.minCandidateConfidence}，否则不保存候选。` } };
    }

    return this.#mutate((document) => {
      const scope = scopeFor(input);
      const subject_id = input.subject_id ?? "household";
      let candidate = document.memories.find((memory) => ["observing", "pending_confirmation"].includes(memory.status)
        && memory.legacy_requires_reobservation !== true
        && memory.memory_type === input.memory_type
        && memory.value === input.value
        && memory.subject_id === subject_id
        && (!memory.expires_at || Date.parse(memory.expires_at) > this.clock())
        && sameScope(memory.scope, scope));
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
          unit: input.memory_type === MEMORY_KEYS.comfort_temperature_c ? "°C" : null,
          subject_id,
          scope,
          status: "observing",
          source: "repeated_observation_unconfirmed",
          confidence: input.confidence,
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
      if (candidate.status === "pending_confirmation") {
        return { success: true, pending_confirmation: true, memory: candidate };
      }
      const priorCount = candidate.observation_count;
      candidate.observation_count += 1;
      candidate.evidence_event_ids = [...candidate.evidence_event_ids, input.event_id].slice(-MAX_EVIDENCE_EVENT_IDS);
      candidate.evidence_dates = [...(candidate.evidence_dates ?? []), input.observation_date];
      candidate.confidence = Math.min(MAX_CONFIDENCE,
        ((candidate.confidence * priorCount) + input.confidence) / candidate.observation_count);
      if (candidate.observation_count >= this.minCandidateObservations) candidate.status = "pending_confirmation";
      candidate.updated_at = timestamp(this.clock);
      candidate.expires_at = new Date(this.clock() + this.candidateTtlMs).toISOString();
      return { success: true, deduplicated: false, memory: candidate };
    });
  }

  async confirmCandidate(memory_id, { user_confirmed = false } = {}) {
    if (user_confirmed !== true) {
      return { success: false, error: { code: "USER_CONFIRMATION_REQUIRED", message: "候选记忆必须经用户明确确认后才能成为正式偏好。" } };
    }
    return this.#mutate((document) => {
      const candidate = document.memories.find((memory) => memory.memory_id === memory_id);
      if (candidate?.legacy_requires_reobservation === true) {
        return { success: false, error: { code: "CANDIDATE_REQUIRES_REOBSERVATION", message: "旧版候选缺少不同日期证据；请重新观察或删除该候选，不能直接确认。" } };
      }
      if (candidate && (!Array.isArray(candidate.evidence_dates)
        || candidate.evidence_dates.length < this.minCandidateObservations)) {
        return { success: false, error: { code: "INSUFFICIENT_DISTINCT_DAYS", message: "候选尚未达到不同日期的最少观察次数。" } };
      }
      if (candidate && (candidate.status !== "pending_confirmation"
        || (candidate.expires_at && Date.parse(candidate.expires_at) <= this.clock()))) {
        return { success: false, error: { code: "MEMORY_NOT_FOUND", message: "没有找到有效的待确认记忆候选。" } };
      }
      if (!candidate) return { success: false, error: { code: "MEMORY_NOT_FOUND", message: "没有找到待确认的记忆候选。" } };
      const existing = document.memories.find((memory) => memory.status === "confirmed"
        && memory.memory_type === candidate.memory_type
        && memory.subject_id === candidate.subject_id
        && sameScope(memory.scope, candidate.scope));
      const confirmed = {
        ...candidate,
        ...(existing ? { memory_id: existing.memory_id, created_at: existing.created_at } : {}),
        status: "confirmed",
        source: "repeated_observation_user_confirmed",
        consent: "user_confirmed",
        updated_at: timestamp(this.clock),
        expires_at: null,
      };
      document.memories = document.memories.filter((memory) => memory.memory_id !== candidate.memory_id
        && (!existing || memory.memory_id !== existing.memory_id));
      document.memories.push(confirmed);
      return { success: true, memory: confirmed };
    });
  }

  async getPreference({ memory_type, room_id, day_type = "all", time_zone, subject_id = "household" } = {}) {
    const document = await this.#read();
    const now = this.clock();
    const requestedScope = scopeFor({ room_id, day_type, time_zone });
    return clone(document.memories
      .filter((memory) => memory.status === "confirmed"
        && memory.memory_type === memory_type
        && memory.subject_id === subject_id
        && (!memory.expires_at || Date.parse(memory.expires_at) > now)
        && Object.entries(memory.scope).every(([key, value]) => requestedScope[key] === value))
      .sort((left, right) => Object.keys(right.scope).length - Object.keys(left.scope).length
        || Date.parse(right.updated_at) - Date.parse(left.updated_at))[0] ?? null);
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
          await fs.rename(temporaryPath, this.filePath);
        } catch (error) {
          if (!["EPERM", "EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
          await fs.rename(this.filePath, backupPath);
          try {
            await fs.rename(temporaryPath, this.filePath);
            await fs.rm(backupPath, { force: true });
          } catch (replaceError) {
            await fs.rename(backupPath, this.filePath).catch(() => {});
            throw replaceError;
          }
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
