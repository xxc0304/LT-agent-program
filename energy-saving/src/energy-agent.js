import { validateIndependentOccupancyConfirmation } from "./occupancy-confirmation.js";

const CONTRACT_VERSION = "0.1";
const AGENT_ID = "energy-saving";
const TARGET_AGENT = "device-manager";

const DEFAULT_CONFIG = Object.freeze({
  awayAfterMs: 10 * 60 * 1000,
  learningAwayAfterMs: 10 * 60 * 1000,
  cooldownMs: 30 * 60 * 1000,
  minLearningConfidence: 0.8,
  occupancyConfirmationMaxAgeMs: 60_000,
  trustedOccupancySourceAgents: [],
  maxEventAgeMs: 5 * 60 * 1000,
  maxFutureSkewMs: 60 * 1000,
  deadlineMs: 30_000,
  priority: "P3",
  dataLevel: "L0",
  executionMode: "local",
});

const ENERGY_DOMAINS = new Set(["light", "switch", "climate"]);
const PROTECTED_DOMAINS = new Set(["lock", "sensor", "binary_sensor"]);
const CLIMATE_ACTIVE_STATES = new Set(["on", "heat", "cool", "heat_cool", "auto", "dry", "fan_only"]);
const PRIVACY_LEVELS = new Set(["family", "sensitive", "restricted"]);
const DATA_LEVELS = new Set(["L0", "L1", "L2", "L3"]);
const EXECUTION_MODES = new Set(["local", "edge", "cloud"]);
const LEARNING_ABSENCE_BEHAVIORS = new Set([
  "leaving_desk",
  "away_from_desk",
  "no_occupancy",
]);
const HOME_MODES = new Set(["home", "away", "sleep"]);

function clone(value) {
  return structuredClone(value);
}

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function asNonNegativeNumber(value, fallback = 0) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizeArea(value) {
  if (typeof value !== "string") return null;
  const aliases = {
    "客厅": "living_room",
    "卧室": "bedroom",
    "书桌": "desk",
    "学习区": "study_area",
  };
  return aliases[value] ?? value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function deviceArea(device) {
  const explicit = device.area ?? device.attributes?.area;
  if (explicit) return normalizeArea(explicit);

  const id = String(device.device_id ?? "").toLowerCase();
  if (id.includes("living_room")) return "living_room";
  if (id.includes("bedroom")) return "bedroom";
  if (id.includes("kitchen")) return "kitchen";
  return null;
}

function isDeviceOn(device) {
  if (!device || !device.available) return false;
  const state = String(device.state ?? "").toLowerCase();
  if (device.domain === "light" || device.domain === "switch") return state === "on";
  if (device.domain === "climate") {
    // Climate entities use operating modes rather than only on/off. Unknown
    // states are intentionally excluded so a malformed snapshot cannot cause
    // an automatic shutdown.
    return CLIMATE_ACTIVE_STATES.has(state);
  }
  return false;
}

function validateConfig(config) {
  const positiveFields = ["awayAfterMs", "learningAwayAfterMs", "maxEventAgeMs", "occupancyConfirmationMaxAgeMs", "deadlineMs"];
  for (const field of positiveFields) {
    if (!Number.isFinite(config[field]) || config[field] <= 0) {
      throw new Error(`${field} 必须是大于 0 的有限数字`);
    }
  }
  const nonNegativeFields = ["cooldownMs", "maxFutureSkewMs"];
  for (const field of nonNegativeFields) {
    if (!Number.isFinite(config[field]) || config[field] < 0) {
      throw new Error(`${field} 必须是非负有限数字`);
    }
  }
  if (!Number.isFinite(config.minLearningConfidence)
    || config.minLearningConfidence < 0 || config.minLearningConfidence > 1) {
    throw new Error("minLearningConfidence 必须是 0 到 1 之间的数字");
  }
  if (!Array.isArray(config.trustedOccupancySourceAgents)
    || config.trustedOccupancySourceAgents.some((agentId) => typeof agentId !== "string" || !agentId.trim() || agentId === "learning-companion")) {
    throw new Error("trustedOccupancySourceAgents 必须是来源名称数组，且不能包含 learning-companion");
  }
  if (!Number.isInteger(config.deadlineMs)) throw new Error("deadlineMs 必须是正整数毫秒数");
  if (!/^P[0-4]$/.test(config.priority)) {
    throw new Error("priority 必须是 P0 到 P4 之一");
  }
  if (!DATA_LEVELS.has(config.dataLevel)) throw new Error("dataLevel 必须是 L0 到 L3 之一");
  if (!EXECUTION_MODES.has(config.executionMode)) throw new Error("executionMode 必须是 local、edge 或 cloud");
}

function taskIdPart(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function validateEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return "事件必须是 JSON 对象";
  for (const field of ["schema_version", "event_id", "source_agent", "event_type", "occurred_at", "privacy_level", "payload"]) {
    if (event[field] === undefined) return `缺少事件字段：${field}`;
  }
  if (event.schema_version !== CONTRACT_VERSION) return `不支持的 schema_version：${event.schema_version}`;
  if (typeof event.event_id !== "string" || !event.event_id) return "event_id 必须是非空字符串";
  if (typeof event.source_agent !== "string" || !event.source_agent) return "source_agent 必须是非空字符串";
  if (typeof event.event_type !== "string" || !event.event_type) return "event_type 必须是非空字符串";
  if (!PRIVACY_LEVELS.has(event.privacy_level)) return "privacy_level 必须是 family、sensitive 或 restricted";
  if (typeof event.occurred_at !== "string" || !Number.isFinite(Date.parse(event.occurred_at))) {
    return "occurred_at 必须是有效的 ISO 时间字符串";
  }
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    return "payload 必须是 JSON 对象";
  }
  if (event.confidence !== undefined && (!Number.isFinite(event.confidence) || event.confidence < 0 || event.confidence > 1)) {
    return "confidence 必须是 0 到 1 之间的数字";
  }
  if (event.payload.confidence !== undefined
    && (!Number.isFinite(event.payload.confidence) || event.payload.confidence < 0 || event.payload.confidence > 1)) {
    return "payload.confidence 必须是 0 到 1 之间的数字";
  }
  for (const [name, value] of [["needs_review", event.needs_review], ["payload.needs_review", event.payload.needs_review]]) {
    if (value !== undefined && typeof value !== "boolean") return `${name} 必须是布尔值`;
  }
  return null;
}

function eventResult({ event, traceId, status, tasks = [], decisions = [], error = null, deduplicated = false }) {
  return {
    schema_version: CONTRACT_VERSION,
    agent_id: AGENT_ID,
    event_id: event?.event_id ?? null,
    event_type: event?.event_type ?? null,
    trace_id: traceId,
    status,
    tasks: tasks.map(clone),
    decisions: decisions.map(clone),
    deduplicated,
    ...(error ? { error: clone(error) } : {}),
  };
}

/**
 * Rule-based energy-saving Agent.
 *
 * The agent plans device_action Tasks; it deliberately does not control
 * Home Assistant directly. Device actions must go through device-manager,
 * which owns execution, verification, safety checks and audit events.
 */
export class EnergySavingAgent {
  constructor({ config = {}, deviceClient = null, clock = () => Date.now() } = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    validateConfig(this.config);
    this.config.trustedOccupancySourceAgents = Object.freeze([...this.config.trustedOccupancySourceAgents]);
    this.deviceClient = deviceClient;
    this.clock = clock;
    this.seenEventIds = new Set();
    this.lastIssuedAt = new Map();
    this.manualHoldUntil = new Map();
    this.latestOccupancyByArea = new Map();
    this.homeMode = "home";
  }

  get id() {
    return AGENT_ID;
  }

  get manifest() {
    return {
      agent_id: AGENT_ID,
      display_name: "节能 Agent",
      version: "0.1",
      capabilities: ["energy_analysis", "device_action_planning"],
      consumes: ["occupancy_changed", "home_mode_changed", "learning_behavior", "user_device_override"],
      produces: ["device_action"],
      execution_mode: "local",
      privacy_level: "family",
      direct_device_control: false,
    };
  }

  /**
   * Plan from an event and an optional snapshot. This pure-ish method is
   * useful for tests and for a scheduler that already owns device state.
   */
  plan(event, { devices = [] } = {}) {
    const validationError = validateEvent(event);
    const traceId = event?.trace_id ?? `trace-${event?.event_id ?? Date.now()}`;
    if (validationError) {
      return eventResult({
        event,
        traceId,
        status: "REJECTED",
        error: { code: "INVALID_EVENT", message: validationError },
      });
    }

    const eventAgeMs = this.clock() - Date.parse(event.occurred_at);
    if (eventAgeMs > this.config.maxEventAgeMs) {
      return eventResult({
        event,
        traceId,
        status: "REJECTED",
        error: {
          code: "STALE_EVENT",
          message: "事件已过期；为避免延迟事件误关设备，节能 Agent 不生成任务",
          age_ms: eventAgeMs,
          max_age_ms: this.config.maxEventAgeMs,
        },
      });
    }
    if (eventAgeMs < -this.config.maxFutureSkewMs) {
      return eventResult({
        event,
        traceId,
        status: "REJECTED",
        error: {
          code: "EVENT_FROM_FUTURE",
          message: "事件时间超出允许的时钟偏差；节能 Agent 不生成任务",
          future_by_ms: -eventAgeMs,
          max_future_skew_ms: this.config.maxFutureSkewMs,
        },
      });
    }

    if (this.seenEventIds.has(event.event_id)) {
      return eventResult({ event, traceId, status: "DEDUPLICATED", deduplicated: true });
    }

    const precheck = this.#precheckEvent(event);
    if (precheck) {
      this.seenEventIds.add(event.event_id);
      return eventResult({ ...precheck, event, traceId });
    }

    const candidates = this.#candidatesForEvent(event, devices);
    const decisions = candidates.length === 0
      ? [{
        kind: "device_selection",
        status: "skipped",
        reason: "NO_ELIGIBLE_ON_DEVICE",
        area: normalizeArea(event.payload?.area),
      }]
      : [];
    const tasks = [];
    for (const device of candidates) {
      const decision = this.#planForDevice(event, device, traceId);
      decisions.push(decision.decision);
      if (decision.task) tasks.push(decision.task);
    }

    this.seenEventIds.add(event.event_id);
    for (const task of tasks) this.lastIssuedAt.set(task.target_ref.device_id, this.clock());

    return eventResult({
      event,
      traceId,
      status: tasks.length > 0 ? "PLANNED" : "NO_ACTION",
      tasks,
      decisions,
    });
  }

  /**
   * Resolve current device state through a small adapter and then plan.
   * Supported adapters expose listDevices() or list_devices().
   */
  async handleEvent(event, { devices } = {}) {
    const validationError = validateEvent(event);
    if (validationError || this.seenEventIds.has(event?.event_id)) {
      return this.plan(event, { devices });
    }

    const eventDevices = event?.payload?.devices;
    const resolvedDevices = Array.isArray(devices)
      ? devices
      : Array.isArray(eventDevices)
        ? eventDevices
        : await this.#listDevices();

    if (!resolvedDevices) {
      return eventResult({
        event,
        traceId: event?.trace_id ?? `trace-${event?.event_id ?? Date.now()}`,
        status: "FAILED",
        error: {
          code: "DEVICE_STATE_UNAVAILABLE",
          message: "无法获取当前设备状态，节能 Agent 不生成控制任务",
        },
      });
    }
    return this.plan(event, { devices: resolvedDevices });
  }

  registerManualOverride({ device_id: deviceId, hold_ms = this.config.cooldownMs } = {}) {
    if (typeof deviceId !== "string" || !deviceId) {
      return { success: false, error: { code: "INVALID_DEVICE_ID", message: "device_id 必须是非空字符串" } };
    }
    const holdUntil = this.clock() + asNonNegativeNumber(hold_ms, this.config.cooldownMs);
    this.manualHoldUntil.set(deviceId, holdUntil);
    return { success: true, device_id: deviceId, hold_until: new Date(holdUntil).toISOString() };
  }

  clearMemory() {
    this.seenEventIds.clear();
    this.lastIssuedAt.clear();
    this.manualHoldUntil.clear();
    this.latestOccupancyByArea.clear();
    this.homeMode = "home";
  }

  #precheckEvent(event) {
    const payload = event.payload ?? {};
    if (event.event_type === "user_device_override") {
      const result = this.registerManualOverride(payload);
      this.seenEventIds.add(event.event_id);
      return {
        traceId: event.trace_id ?? `trace-${event.event_id}`,
        status: result.success ? "NO_ACTION" : "REJECTED",
        decisions: [{
          kind: "manual_override",
          status: result.success ? "accepted" : "rejected",
          device_id: payload.device_id,
          reason: result.success ? "USER_OVERRIDE_HOLD" : result.error.code,
        }],
        error: result.success ? null : result.error,
      };
    }

    if (event.event_type === "home_mode_changed") {
      if (!HOME_MODES.has(payload.mode)) {
        return {
          traceId: event.trace_id ?? `trace-${event.event_id}`,
          status: "REJECTED",
          decisions: [],
          error: { code: "INVALID_HOME_MODE", message: "mode 必须是 home、away 或 sleep" },
        };
      }
      this.homeMode = payload.mode;
      if (payload.mode !== "away") {
        return {
          traceId: event.trace_id ?? `trace-${event.event_id}`,
          status: "NO_ACTION",
          decisions: [{
            kind: "home_mode",
            status: "ignored",
            mode: payload.mode,
            reason: "ENERGY_SHUTDOWN_ONLY_FOR_AWAY_MODE",
          }],
        };
      }
      return null;
    }

    if (!["occupancy_changed", "learning_behavior"].includes(event.event_type)) {
      return {
        traceId: event.trace_id ?? `trace-${event.event_id}`,
        status: "NO_ACTION",
        decisions: [{ kind: "event", status: "ignored", reason: "UNSUPPORTED_EVENT_TYPE" }],
      };
    }

    if (event.event_type === "learning_behavior"
      && (payload.annotation_scope === "classroom_scene" || payload.target_child_specified === false)) {
      return {
        traceId: event.trace_id ?? `trace-${event.event_id}`,
        status: "NO_ACTION",
        decisions: [{
          kind: "learning",
          status: "ignored",
          reason: "CLASSROOM_SCENE_NOT_TARGETED_FOR_ENERGY",
        }],
      };
    }

    if (!normalizeArea(payload.area)) {
      return {
        traceId: event.trace_id ?? `trace-${event.event_id}`,
        status: "REJECTED",
        decisions: [],
        error: {
          code: "MISSING_AREA",
          message: "区域占用和学习行为事件必须提供 area；缺少区域时不按全屋关机处理",
        },
      };
    }

    if (event.event_type === "occupancy_changed" && typeof payload.occupied === "boolean") {
      this.#rememberOccupancy(event, normalizeArea(payload.area));
    }

    if (event.event_type === "occupancy_changed") {
      if (typeof payload.occupied !== "boolean") {
        return {
          traceId: event.trace_id ?? `trace-${event.event_id}`,
          status: "REJECTED",
          decisions: [],
          error: { code: "INVALID_OCCUPANCY", message: "occupancy_changed.payload.occupied 必须是布尔值" },
        };
      }
      if (payload.occupied) {
        return {
          traceId: event.trace_id ?? `trace-${event.event_id}`,
          status: "NO_ACTION",
          decisions: [{ kind: "occupancy", status: "occupied", reason: "OCCUPIED_NO_SHUTDOWN" }],
        };
      }
      const duration = payload.observed_for_ms ?? payload.duration_ms;
      if (asNonNegativeNumber(duration) < this.config.awayAfterMs) {
        return {
          traceId: event.trace_id ?? `trace-${event.event_id}`,
          status: "NO_ACTION",
          decisions: [{
            kind: "occupancy",
            status: "waiting",
            reason: "AWAY_DURATION_BELOW_THRESHOLD",
            observed_for_ms: asNonNegativeNumber(duration),
            required_ms: this.config.awayAfterMs,
          }],
        };
      }
    }

    if (event.event_type === "learning_behavior") {
      const confidence = event.confidence ?? payload.confidence ?? 0;
      const duration = payload.duration_ms ?? payload.observed_for_ms;
      const awaySignal = LEARNING_ABSENCE_BEHAVIORS.has(payload.behavior)
        || payload.presence === "away_from_desk";
      if (!awaySignal) {
        return {
          traceId: event.trace_id ?? `trace-${event.event_id}`,
          status: "NO_ACTION",
          decisions: [{ kind: "learning", status: "ignored", reason: "NO_AWAY_PRESENCE_SIGNAL" }],
        };
      }
      if (event.needs_review === true || payload.needs_review === true || confidence < this.config.minLearningConfidence) {
        return {
          traceId: event.trace_id ?? `trace-${event.event_id}`,
          status: "NO_ACTION",
          decisions: [{
            kind: "learning",
            status: "waiting_review",
            reason: "LOW_CONFIDENCE_OR_REVIEW_REQUIRED",
            confidence,
            minimum_confidence: this.config.minLearningConfidence,
          }],
        };
      }
      if (asNonNegativeNumber(duration) < this.config.learningAwayAfterMs) {
        return {
          traceId: event.trace_id ?? `trace-${event.event_id}`,
          status: "NO_ACTION",
          decisions: [{
            kind: "learning",
            status: "waiting",
            reason: "LEARNING_AWAY_DURATION_BELOW_THRESHOLD",
            observed_for_ms: asNonNegativeNumber(duration),
            required_ms: this.config.learningAwayAfterMs,
          }],
        };
      }
      const confirmation = validateIndependentOccupancyConfirmation({
        learningEvent: event,
        confirmation: this.latestOccupancyByArea.get(normalizeArea(payload.area)),
        now: this.clock(),
        maxAgeMs: this.config.occupancyConfirmationMaxAgeMs,
        maxFutureSkewMs: this.config.maxFutureSkewMs,
        trustedSourceAgents: this.config.trustedOccupancySourceAgents,
      });
      if (!confirmation.success) {
        return {
          traceId: event.trace_id ?? `trace-${event.event_id}`,
          status: "NO_ACTION",
          decisions: [{
            kind: "learning",
            status: "waiting_confirmation",
            reason: confirmation.error.code,
            message: confirmation.error.message,
          }],
        };
      }
    }

    return null;
  }

  #candidatesForEvent(event, devices) {
    const payload = event.payload ?? {};
    const area = normalizeArea(payload.area);
    const homeModeEvent = event.event_type === "home_mode_changed" && payload.mode === "away";
    return devices
      .filter((device) => device && ENERGY_DOMAINS.has(device.domain))
      .filter((device) => isDeviceOn(device))
      .filter((device) => homeModeEvent || !area || deviceArea(device) === area);
  }

  #rememberOccupancy(event, area) {
    if (!this.config.trustedOccupancySourceAgents.includes(event.source_agent)) return;
    const occurredAt = Date.parse(event.occurred_at);
    if (!Number.isFinite(occurredAt)) return;
    const previous = this.latestOccupancyByArea.get(area);
    if (previous && Date.parse(previous.occurred_at) >= occurredAt) return;
    this.latestOccupancyByArea.set(area, {
      event_id: event.event_id,
      source_agent: event.source_agent,
      occupied: event.payload.occupied,
      area,
      occurred_at: event.occurred_at,
    });
  }

  #planForDevice(event, device, traceId) {
    const deviceId = device.device_id;
    if (!deviceId) {
      return { decision: { status: "skipped", reason: "MISSING_DEVICE_ID" } };
    }
    if (PROTECTED_DOMAINS.has(device.domain) || !ENERGY_DOMAINS.has(device.domain)) {
      return { decision: { device_id: deviceId, status: "skipped", reason: "PROTECTED_DEVICE" } };
    }
    if (!device.available) {
      return { decision: { device_id: deviceId, status: "skipped", reason: "DEVICE_OFFLINE" } };
    }

    const now = this.clock();
    const holdUntil = this.manualHoldUntil.get(deviceId) ?? 0;
    if (holdUntil > now) {
      return {
        decision: {
          device_id: deviceId,
          status: "skipped",
          reason: "USER_OVERRIDE_HOLD",
          hold_until: new Date(holdUntil).toISOString(),
        },
      };
    }

    const lastIssued = this.lastIssuedAt.get(deviceId) ?? 0;
    if (now - lastIssued < this.config.cooldownMs) {
      return {
        decision: {
          device_id: deviceId,
          status: "skipped",
          reason: "COOLDOWN",
          remaining_ms: this.config.cooldownMs - (now - lastIssued),
        },
      };
    }

    const action = "turn_off";
    const idempotencyKey = `energy:${event.event_id}:${deviceId}:${action}`;
    const occupancyEvidence = event.event_type === "learning_behavior"
      ? this.latestOccupancyByArea.get(normalizeArea(event.payload?.area))
      : null;
    const task = {
      schema_version: CONTRACT_VERSION,
      task_id: `task-${taskIdPart(event.event_id)}-${taskIdPart(deviceId)}-${action}`,
      source: AGENT_ID,
      source_agent: AGENT_ID,
      target: TARGET_AGENT,
      target_agent: TARGET_AGENT,
      task_type: "device_action",
      target_ref: { device_id: deviceId },
      action,
      parameters: {},
      priority: this.config.priority,
      deadline_ms: this.config.deadlineMs,
      data_level: this.config.dataLevel,
      privacy_level: "family",
      resource_requirement: {
        execution_mode: this.config.executionMode,
        capabilities: ["home_assistant", "device_control"],
      },
      compute_requirement: {
        class: "switch",
        gpu_required: false,
      },
      idempotency_key: idempotencyKey,
      trace_id: traceId,
      metadata: {
        reason_code: event.event_type === "home_mode_changed" ? "HOME_AWAY" : "AREA_UNOCCUPIED",
        trigger_event_id: event.event_id,
        trigger_event_type: event.event_type,
        device_name: device.name,
        ...(occupancyEvidence ? { corroborating_occupancy_event_id: occupancyEvidence.event_id } : {}),
      },
    };

    return {
      task,
      decision: {
        device_id: deviceId,
        status: "planned",
        action,
        reason: task.metadata.reason_code,
        idempotency_key: idempotencyKey,
      },
    };
  }

  async #listDevices() {
    if (!this.deviceClient) return null;
    const list = this.deviceClient.listDevices ?? this.deviceClient.list_devices;
    if (typeof list !== "function") return null;
    const response = await list.call(this.deviceClient, {});
    if (Array.isArray(response)) return response;
    if (response?.success === false) return null;
    return response?.devices ?? null;
  }
}

export const ENERGY_AGENT_DEFAULT_CONFIG = DEFAULT_CONFIG;
export const ENERGY_AGENT_CONSTANTS = Object.freeze({
  AGENT_ID,
  TARGET_AGENT,
  ENERGY_DOMAINS: [...ENERGY_DOMAINS],
  PROTECTED_DOMAINS: [...PROTECTED_DOMAINS],
});
