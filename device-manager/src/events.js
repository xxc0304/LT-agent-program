import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

function clone(value) {
  return structuredClone(value);
}

function now() {
  return new Date().toISOString();
}

function privacyLevelFor(dataLevel) {
  return {
    L0: "family",
    L1: "family",
    L2: "sensitive",
    L3: "restricted",
  }[dataLevel] ?? "family";
}

/** Bounded in-memory event ledger used by Mock HA and the local adapter. */
export class DeviceEventLedger {
  constructor({ sourceType = "simulator", sourceId = "device-manager-mock", retentionLimit = 200 } = {}) {
    if (!Number.isSafeInteger(retentionLimit) || retentionLimit < 1 || retentionLimit > 200) {
      throw new Error("事件保留数量必须是 1 到 200 之间的整数");
    }
    this.events = [];
    this.source = { type: sourceType, id: sourceId };
    this.retentionLimit = retentionLimit;
    this.sequence = 0;
  }

  append({ event_type, device_id, payload = {}, severity = "info", data_level = "L0", trace_id = null } = {}) {
    const occurredAt = now();
    const sequence = ++this.sequence;
    const event = {
      schema_version: "0.1",
      event_id: `evt_${String(sequence).padStart(6, "0")}`,
      source_agent: "device-manager",
      event_type,
      source: this.source,
      subject: { device_id },
      occurred_at: occurredAt,
      received_at: occurredAt,
      severity,
      data_level,
      privacy_level: privacyLevelFor(data_level),
      payload: clone(payload),
      dedup_key: `${device_id ?? "system"}:${event_type}:${sequence}`,
      trace_id,
    };
    this.events.push(event);
    if (this.events.length > this.retentionLimit) {
      this.events.splice(0, this.events.length - this.retentionLimit);
    }
    return clone(event);
  }

  list({ device_id, event_type, trace_id, limit = 50 } = {}) {
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
    return clone(this.events
      .filter((event) => !device_id || event.subject.device_id === device_id)
      .filter((event) => !event_type || event.event_type === event_type)
      .filter((event) => !trace_id || event.trace_id === trace_id)
      .slice(-safeLimit)
      .reverse());
  }

  get length() {
    return this.events.length;
  }
}

const PERSISTED_EVENT_SCHEMA_VERSION = 1;
const PERSISTED_EVENT_TYPES = new Set([
  "action_executed",
  "action_failed",
  "diagnostic_alert",
  "diagnostic_shared_infrastructure_suspected",
  "diagnostic_shared_infrastructure_cleared",
  "diagnostic_transient",
  "diagnostic_recovered",
  "diagnostic_tracking_ended",
]);
const PERSISTED_ACTIONS = new Set([
  "turn_on", "turn_off", "set_temperature", "set_brightness", "open", "close", "set_position", "lock", "unlock",
]);
const SAFE_ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const SAFE_CODE = /^[A-Z0-9_]{1,64}$/;
const SAFE_TRACE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_STATE = /^[A-Za-z0-9_.:-]{1,48}$/;

function sanitizedCode(value) {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : "UNKNOWN";
}

function sanitizedState(value) {
  if (typeof value === "string" && SAFE_STATE.test(value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function sanitizedTraceId(value) {
  return typeof value === "string" && SAFE_TRACE_ID.test(value) ? value : null;
}

function sanitizeEventInput({ event_type, device_id, payload = {}, severity = "info", data_level = "L0", trace_id = null } = {}) {
  if (!PERSISTED_EVENT_TYPES.has(event_type)) {
    throw new Error(`不允许持久化事件类型：${typeof event_type === "string" ? event_type : "unknown"}`);
  }
  const safePayload = {};
  const sourcePayload = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};

  if (event_type === "action_executed" || event_type === "action_failed") {
    if (PERSISTED_ACTIONS.has(sourcePayload.action)) safePayload.action = sourcePayload.action;
    if (typeof sourcePayload.code === "string") safePayload.code = sanitizedCode(sourcePayload.code);
    if (typeof sourcePayload.verified === "boolean") safePayload.verified = sourcePayload.verified;
    const oldState = sanitizedState(sourcePayload.old_state);
    const newState = sanitizedState(sourcePayload.new_state);
    if (oldState !== undefined) safePayload.old_state = oldState;
    if (newState !== undefined) safePayload.new_state = newState;
  } else if (event_type === "diagnostic_alert") {
    if (typeof sourcePayload.code === "string") safePayload.code = sanitizedCode(sourcePayload.code);
    if (["healthy", "abnormal", "offline", "unknown"].includes(sourcePayload.status)) {
      safePayload.status = sourcePayload.status;
    }
  } else if (event_type === "diagnostic_shared_infrastructure_suspected"
    || event_type === "diagnostic_shared_infrastructure_cleared") {
    if (Number.isSafeInteger(sourcePayload.affected_device_count)) {
      safePayload.affected_device_count = Math.max(0, Math.min(200, sourcePayload.affected_device_count));
    }
  } else if (event_type === "diagnostic_transient") {
    safePayload.code = sanitizedCode(sourcePayload.code);
    if (Number.isFinite(sourcePayload.duration_ms)) {
      safePayload.duration_ms = Math.max(0, Math.min(31_536_000_000, Math.round(sourcePayload.duration_ms)));
    }
  } else if (event_type === "diagnostic_recovered" || event_type === "diagnostic_tracking_ended") {
    safePayload.previous_code = sanitizedCode(sourcePayload.previous_code);
    if (event_type === "diagnostic_tracking_ended"
      && sourcePayload.reason === "entity_missing_from_ha_inventory") {
      safePayload.reason = sourcePayload.reason;
    }
  }

  return {
    event_type,
    ...(typeof device_id === "string" && SAFE_ENTITY_ID.test(device_id) ? { device_id } : {}),
    payload: safePayload,
    severity: ["info", "warning", "critical"].includes(severity) ? severity : "info",
    data_level: ["L0", "L1", "L2", "L3"].includes(data_level) ? data_level : "L0",
    trace_id: sanitizedTraceId(trace_id),
  };
}

function validatePersistedEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)
    || event.schema_version !== "0.1"
    || typeof event.event_id !== "string" || !/^evt_\d{6,}$/.test(event.event_id)
    || event.source_agent !== "device-manager"
    || !PERSISTED_EVENT_TYPES.has(event.event_type)
    || !event.source || event.source.type !== "home_assistant" || event.source.id !== "home_assistant"
    || Object.keys(event.source).some((key) => !new Set(["type", "id"]).has(key))
    || !event.subject || (event.subject.device_id !== undefined
      && (typeof event.subject.device_id !== "string" || !SAFE_ENTITY_ID.test(event.subject.device_id)))
    || Object.keys(event.subject).some((key) => key !== "device_id")
    || typeof event.occurred_at !== "string" || !Number.isFinite(Date.parse(event.occurred_at))
    || typeof event.received_at !== "string" || !Number.isFinite(Date.parse(event.received_at))
    || !["info", "warning", "critical"].includes(event.severity)
    || !["L0", "L1", "L2", "L3"].includes(event.data_level)
    || event.privacy_level !== privacyLevelFor(event.data_level)
    || typeof event.payload !== "object" || Array.isArray(event.payload)
    || !(event.trace_id === null || (typeof event.trace_id === "string" && SAFE_TRACE_ID.test(event.trace_id)))
    || typeof event.dedup_key !== "string" || event.dedup_key.length > 512
    || Object.keys(event).some((key) => !new Set([
      "schema_version", "event_id", "source_agent", "event_type", "source", "subject", "occurred_at",
      "received_at", "severity", "data_level", "privacy_level", "payload", "dedup_key", "trace_id",
    ]).has(key))) {
    throw new Error("持久事件账本包含无效记录；为避免审计数据丢失，已停止加载");
  }
  const sanitized = sanitizeEventInput({
    event_type: event.event_type,
    device_id: event.subject.device_id,
    payload: event.payload,
    severity: event.severity,
    data_level: event.data_level,
    trace_id: event.trace_id,
  });
  if (JSON.stringify(sanitized.payload) !== JSON.stringify(event.payload)) {
    throw new Error("持久事件账本含非白名单字段；为避免误读或覆盖，已停止加载");
  }
  return clone(event);
}

export function resolveDeviceEventLedgerPath(env = process.env) {
  if (typeof env.DEVICE_MANAGER_EVENT_LEDGER_PATH === "string"
    && env.DEVICE_MANAGER_EVENT_LEDGER_PATH.trim()) {
    return resolve(env.DEVICE_MANAGER_EVENT_LEDGER_PATH.trim());
  }
  const stateDir = typeof env.OPENCLAW_STATE_DIR === "string" && env.OPENCLAW_STATE_DIR.trim()
    ? resolve(env.OPENCLAW_STATE_DIR.trim())
    : join(homedir(), ".openclaw");
  return join(stateDir, "device-manager", "device-events.json");
}

/**
 * Optional durable audit ledger. It stores only a whitelisted, redacted event
 * projection; the in-memory ledger remains the default for Mock/test usage.
 */
export class PersistentDeviceEventLedger {
  constructor({ filePath = resolveDeviceEventLedgerPath(), retentionLimit = 200 } = {}) {
    if (typeof filePath !== "string" || !filePath.trim()) throw new Error("持久事件账本需要 filePath");
    if (!Number.isSafeInteger(retentionLimit) || retentionLimit < 1 || retentionLimit > 200) {
      throw new Error("事件保留数量必须是 1 到 200 之间的整数");
    }
    this.filePath = resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.retentionLimit = retentionLimit;
    this.ledger = new DeviceEventLedger({
      sourceType: "home_assistant",
      sourceId: "home_assistant",
      retentionLimit,
    });
    this.#refresh();
  }

  #refresh() {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.ledger.events = [];
        this.ledger.sequence = 0;
        return;
      }
      throw new Error("持久事件账本无法解析；为避免审计数据丢失，已停止加载");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || parsed.schema_version !== PERSISTED_EVENT_SCHEMA_VERSION
      || typeof parsed.updated_at !== "string" || !Number.isFinite(Date.parse(parsed.updated_at))
      || !Array.isArray(parsed.events) || parsed.events.length > this.retentionLimit
      || Object.keys(parsed).some((key) => !new Set(["schema_version", "updated_at", "events"]).has(key))) {
      throw new Error("持久事件账本版本或结构无效；为避免审计数据丢失，已停止加载");
    }
    const events = parsed.events.map(validatePersistedEvent);
    let previousSequence = 0;
    for (const event of events) {
      const sequence = Number(event.event_id.slice(4));
      if (sequence <= previousSequence) throw new Error("持久事件账本序号无效；为避免覆盖，已停止加载");
      previousSequence = sequence;
    }
    this.ledger.events = events;
    this.ledger.sequence = previousSequence;
  }

  #withLock(action) {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const token = randomUUID();
    let descriptor;
    try {
      descriptor = openSync(this.lockPath, "wx", 0o600);
      writeFileSync(descriptor, JSON.stringify({ token, pid: process.pid, created_at: new Date().toISOString() }), "utf8");
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (error?.code === "EEXIST") {
        const locked = new Error("持久事件账本正被另一个写入者使用；本次事件未写入");
        locked.code = "EVENT_LEDGER_LOCKED";
        throw locked;
      }
      throw error;
    }
    try {
      return action();
    } finally {
      closeSync(descriptor);
      try {
        const lock = JSON.parse(readFileSync(this.lockPath, "utf8"));
        if (lock.token === token) unlinkSync(this.lockPath);
      } catch {
        // Leave malformed/replaced locks in place so a later writer fails closed.
      }
    }
  }

  #save() {
    const document = {
      schema_version: PERSISTED_EVENT_SCHEMA_VERSION,
      updated_at: new Date().toISOString(),
      events: this.ledger.events,
    };
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try { unlinkSync(temporaryPath); } catch {}
      throw new Error(`持久事件账本无法安全原子写入；本次事件未提交：${error?.code ?? "WRITE_FAILED"}`);
    }
  }

  append(input = {}) {
    return this.#withLock(() => {
      this.#refresh();
      const previousEvents = this.ledger.events;
      const previousSequence = this.ledger.sequence;
      const event = this.ledger.append(sanitizeEventInput(input));
      if (this.ledger.events.length > this.retentionLimit) {
        this.ledger.events.splice(0, this.ledger.events.length - this.retentionLimit);
      }
      try {
        this.#save();
      } catch (error) {
        this.ledger.events = previousEvents;
        this.ledger.sequence = previousSequence;
        throw error;
      }
      return event;
    });
  }

  list(filters = {}) {
    this.#refresh();
    return this.ledger.list(filters);
  }

  get length() {
    this.#refresh();
    return this.ledger.length;
  }
}
