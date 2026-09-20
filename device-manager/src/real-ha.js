import { SCENES, verifyExpectedState } from "./scenes.js";
import { isActionSatisfied } from "./action-verification.js";
import { toCanonicalDevice } from "./canonical.js";
import { DeviceEventLedger } from "./events.js";

const SUPPORTED_DOMAINS = new Set([
  "light",
  "switch",
  "climate",
  "cover",
  "lock",
  "sensor",
  "binary_sensor",
]);

function clone(value) {
  return structuredClone(value);
}

function failure(code, message, details = {}) {
  return {
    success: false,
    error: { code, message, ...details },
  };
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("HA_URL 只允许 http:// 或 https:// 地址");
  }
  // Authentication must travel only through the Bearer header; never retain
  // URL user-info because the base URL is also used as an event source ID.
  url.username = "";
  url.password = "";
  return url.toString().replace(/\/$/, "");
}

function normalizeAttributes(domain, source = {}) {
  const attributes = { ...source };

  if (domain === "light" && Number.isFinite(source.brightness)) {
    attributes.brightness = Math.round((source.brightness / 255) * 100);
  }
  if (domain === "climate") {
    attributes.min_temperature = source.min_temperature ?? source.min_temp;
    attributes.max_temperature = source.max_temperature ?? source.max_temp;
  }
  if (domain === "cover") {
    attributes.position = source.position ?? source.current_position;
  }

  return attributes;
}

function normalizeEntity(entity) {
  const deviceId = entity.entity_id;
  const domain = deviceId.split(".", 1)[0];
  const available = !["unavailable", "unknown"].includes(entity.state);
  let state = entity.state;

  // Home Assistant 的 climate 状态通常是 cool/heat/auto；设备管家统一成 on/off，
  // 同时在 attributes.hvac_mode 中保留原始状态。
  const attributes = normalizeAttributes(domain, entity.attributes);
  if (domain === "climate") {
    attributes.hvac_mode = entity.state;
    state = entity.state === "off" ? "off" : available ? "on" : entity.state;
  }

  return {
    device_id: deviceId,
    name: entity.attributes?.friendly_name ?? deviceId,
    domain,
    state,
    available,
    attributes,
    last_changed: entity.last_changed,
    last_updated: entity.last_updated,
  };
}

function validatePercentage(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    return failure("INVALID_PARAMETER", `${name} 必须是 0 到 100 的整数`);
  }
  return null;
}

function serviceFor(device, action, parameters, confirmed) {
  const data = { entity_id: device.device_id };

  if (device.domain === "light") {
    if (action === "turn_on" || action === "turn_off") return { service: action, data };
    if (action === "set_brightness") {
      const invalid = validatePercentage(parameters.brightness, "brightness");
      if (invalid) return invalid;
      return { service: "turn_on", data: { ...data, brightness_pct: parameters.brightness } };
    }
  }

  if (device.domain === "switch") {
    if (action === "turn_on" || action === "turn_off") return { service: action, data };
  }

  if (device.domain === "climate") {
    if (action === "turn_on" || action === "turn_off") return { service: action, data };
    if (action === "set_temperature") {
      const temperature = parameters.temperature;
      const min = device.attributes.min_temperature;
      const max = device.attributes.max_temperature;
      if (!Number.isFinite(temperature)
        || (Number.isFinite(min) && temperature < min)
        || (Number.isFinite(max) && temperature > max)) {
        return failure("INVALID_PARAMETER", `temperature 必须在 ${min ?? "设备下限"} 到 ${max ?? "设备上限"}℃ 之间`);
      }
      return { service: "set_temperature", data: { ...data, temperature } };
    }
  }

  if (device.domain === "cover") {
    if (action === "open") return { service: "open_cover", data };
    if (action === "close") return { service: "close_cover", data };
    if (action === "set_position") {
      const invalid = validatePercentage(parameters.position, "position");
      if (invalid) return invalid;
      return { service: "set_cover_position", data: { ...data, position: parameters.position } };
    }
  }

  if (device.domain === "lock") {
    if (action === "lock") return { service: "lock", data };
    if (action === "unlock") {
      if (!confirmed) {
        return failure(
          "CONFIRMATION_REQUIRED",
          "开锁属于高风险操作，必须得到用户明确确认",
          { device_id: device.device_id, action },
        );
      }
      return { service: "unlock", data };
    }
  }

  return failure("UNSUPPORTED_ACTION", `${device.domain} 不支持操作：${action}`);
}

/**
 * Home Assistant REST API adapter.
 *
 * It deliberately exposes the same JSON result shapes as MockHomeAssistant so
 * the OpenClaw tools can switch backend without changing prompts or contracts.
 */
export class RealHomeAssistant {
  constructor({ baseUrl, token, entityAllowlist, fetchImpl = globalThis.fetch, timeoutMs = 8_000 } = {}) {
    if (!baseUrl) throw new Error("使用真实 Home Assistant 时必须设置 HA_URL");
    if (!token) throw new Error("使用真实 Home Assistant 时必须设置 HA_TOKEN");
    if (typeof fetchImpl !== "function") throw new Error("当前 Node.js 环境不支持 fetch");

    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.token = token;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.entityAllowlist = entityAllowlist?.length ? new Set(entityAllowlist) : null;
    this.auditLog = [];
    this.eventLedger = new DeviceEventLedger({ sourceType: "home_assistant", sourceId: this.baseUrl });
  }

  async #request(path, { method = "GET", body } = {}) {
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
      return failure(
        timedOut ? "HA_TIMEOUT" : "HA_CONNECTION_FAILED",
        timedOut ? "连接 Home Assistant 超时" : "无法连接 Home Assistant",
      );
    }

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!response.ok) {
      const code = response.status === 401
        ? "HA_AUTHENTICATION_FAILED"
        : response.status === 404
          ? "DEVICE_NOT_FOUND"
          : "HA_API_ERROR";
      return failure(code, `Home Assistant API 请求失败（HTTP ${response.status}）`, {
        status: response.status,
      });
    }

    return { success: true, data };
  }

  #isAllowed(entityId) {
    return !this.entityAllowlist || this.entityAllowlist.has(entityId);
  }

  async listDevices({ domain, canonical = false } = {}) {
    const response = await this.#request("/api/states");
    if (!response.success) return response;

    const devices = response.data
      .filter((entity) => {
        const entityDomain = entity.entity_id?.split(".", 1)[0];
        return SUPPORTED_DOMAINS.has(entityDomain)
          && (!domain || entityDomain === domain)
          && this.#isAllowed(entity.entity_id);
      })
      .map(normalizeEntity);

    return {
      success: true,
      count: devices.length,
      devices: canonical
        ? devices.map((device) => toCanonicalDevice(device, { platform: "home_assistant" }))
        : devices,
    };
  }

  async getState({ device_id, canonical = false } = {}) {
    if (!device_id) return failure("INVALID_ARGUMENT", "device_id 是必填参数");
    if (!this.#isAllowed(device_id)) {
      return failure("DEVICE_NOT_ALLOWED", `设备不在允许列表中：${device_id}`, { device_id });
    }

    const response = await this.#request(`/api/states/${encodeURIComponent(device_id)}`);
    if (!response.success) {
      if (response.error.code === "DEVICE_NOT_FOUND") {
        return failure("DEVICE_NOT_FOUND", `未找到设备：${device_id}`, { device_id });
      }
      return response;
    }
    const device = normalizeEntity(response.data);
    return {
      success: true,
      device: canonical ? toCanonicalDevice(device, { platform: "home_assistant" }) : device,
    };
  }

  async controlDevice({ device_id, action, parameters = {}, confirmed = false, trace_id = null, task_id = null, idempotency_key = null } = {}) {
    if (!device_id || !action) {
      return failure("INVALID_ARGUMENT", "device_id 和 action 是必填参数");
    }

    const beforeResult = await this.getState({ device_id });
    if (!beforeResult.success) {
      this.eventLedger.append({
        event_type: "action_failed",
        device_id,
        severity: beforeResult.error.code === "HA_TIMEOUT" ? "warning" : "critical",
        trace_id,
        payload: { action, code: beforeResult.error.code, message: beforeResult.error.message },
      });
      return beforeResult;
    }
    const before = beforeResult.device;
    if (!before.available) {
      this.eventLedger.append({
        event_type: "action_failed",
        device_id,
        severity: "warning",
        trace_id,
        payload: { action, code: "DEVICE_UNAVAILABLE" },
      });
      return failure("DEVICE_UNAVAILABLE", `设备当前不可用：${before.name}`, { device_id });
    }

    const mapping = serviceFor(before, action, parameters, confirmed);
    if (mapping.success === false) {
      this.eventLedger.append({
        event_type: "action_failed",
        device_id,
        severity: mapping.error.code === "CONFIRMATION_REQUIRED" ? "critical" : "warning",
        trace_id,
        payload: { action, code: mapping.error.code, message: mapping.error.message },
      });
      return mapping;
    }

    const serviceResult = await this.#request(`/api/services/${before.domain}/${mapping.service}`, {
      method: "POST",
      body: mapping.data,
    });
    if (!serviceResult.success) {
      this.eventLedger.append({
        event_type: "action_failed",
        device_id,
        severity: serviceResult.error.code === "HA_TIMEOUT" ? "warning" : "critical",
        trace_id,
        payload: { action, code: serviceResult.error.code, message: serviceResult.error.message },
      });
      return serviceResult;
    }

    const afterResult = await this.getState({ device_id });
    if (!afterResult.success) {
      this.eventLedger.append({
        event_type: "action_failed",
        device_id,
        severity: afterResult.error.code === "HA_TIMEOUT" ? "warning" : "critical",
        trace_id,
        payload: { action, code: afterResult.error.code, message: afterResult.error.message },
      });
      return afterResult;
    }
    const after = afterResult.device;
    const verified = isActionSatisfied(after, action, parameters);
    this.auditLog.push({
      sequence: this.auditLog.length + 1,
      device_id,
      action,
      parameters: clone(parameters),
      confirmed,
      task_id,
      trace_id,
      idempotency_key,
      verified,
      before,
      after,
    });

    this.eventLedger.append({
      event_type: verified ? "action_executed" : "action_failed",
      device_id,
      severity: verified ? "info" : "warning",
      trace_id,
      payload: {
        action,
        task_id,
        idempotency_key,
        verified,
        old_state: before.state,
        new_state: after.state,
      },
    });

    if (!verified) {
      return failure(
        "POST_ACTION_VERIFICATION_FAILED",
        "Home Assistant 已接受服务请求，但设备状态回读未达到目标",
        { device_id, action, verified: false, device: after },
      );
    }

    return {
      success: true,
      device_id,
      action,
      old_state: before.state,
      new_state: after.state,
      device: after,
      canonical_device: toCanonicalDevice(after, { platform: "home_assistant" }),
      verified,
      verification_required: true,
    };
  }

  async runScene({ scene_id } = {}) {
    const scene = SCENES[scene_id];
    if (!scene) {
      return failure("SCENE_NOT_FOUND", `未找到场景：${scene_id}`, {
        scene_id,
        available_scenes: Object.keys(SCENES),
      });
    }

    const targetIds = [...new Set(scene.steps.map((step) => step.device_id))];
    for (const device_id of targetIds) {
      const state = await this.getState({ device_id });
      if (!state.success || !state.device.available) {
        return failure("SCENE_PREFLIGHT_FAILED", `场景无法执行，设备不可用：${device_id}`, {
          scene_id,
          device_id,
          cause: state.success ? "DEVICE_UNAVAILABLE" : state.error.code,
        });
      }
    }

    const executions = [];
    for (const step of scene.steps) {
      const result = await this.controlDevice(step);
      executions.push({ device_id: step.device_id, action: step.action, result });
      if (!result.success) {
        return {
          success: false,
          scene_id,
          scene_name: scene.name,
          executions,
          verification: [],
          error: result.error,
        };
      }
    }

    const verification = [];
    for (const [device_id, expected] of Object.entries(scene.expected)) {
      const result = await this.getState({ device_id });
      verification.push({
        device_id,
        expected,
        verified: result.success && verifyExpectedState(result.device, expected),
        result,
      });
    }

    return {
      success: verification.every((entry) => entry.verified),
      scene_id,
      scene_name: scene.name,
      executions,
      verification,
      verification_required: false,
    };
  }

  async diagnoseDevice({ device_id, trace_id = null } = {}) {
    let devices;
    if (device_id) {
      const state = await this.getState({ device_id });
      if (!state.success) return state;
      devices = [state.device];
    } else {
      const listed = await this.listDevices();
      if (!listed.success) return listed;
      devices = listed.devices;
    }

    const diagnoses = devices.map((device) => {
      if (!device.available) {
        return {
          device_id: device.device_id,
          name: device.name,
          domain: device.domain,
          state: device.state,
          available: false,
          status: "offline",
          code: "DEVICE_OFFLINE",
          summary: "Home Assistant 将该实体标记为 unavailable 或 unknown。",
          evidence: [{ field: "available", expected: true, actual: false }],
          recommendations: ["检查设备供电和网络连接", "在 Home Assistant 中查看实体及集成状态"],
        };
      }
      return {
        device_id: device.device_id,
        name: device.name,
        domain: device.domain,
        state: device.state,
        available: true,
        status: "healthy",
        code: "OK",
        summary: "Home Assistant 实体在线并可读取。",
        evidence: [{ field: "available", expected: true, actual: true }],
        recommendations: [],
      };
    });

    for (const diagnosis of diagnoses.filter((item) => item.status !== "healthy")) {
      this.eventLedger.append({
        event_type: "diagnostic_alert",
        device_id: diagnosis.device_id,
        severity: diagnosis.status === "offline" ? "critical" : "warning",
        trace_id,
        payload: { code: diagnosis.code, summary: diagnosis.summary },
      });
    }

    return {
      success: true,
      count: diagnoses.length,
      diagnoses,
      summary: {
        healthy: diagnoses.filter((item) => item.status === "healthy").length,
        abnormal: diagnoses.filter((item) => item.status === "abnormal").length,
        offline: diagnoses.filter((item) => item.status === "offline").length,
      },
    };
  }

  getAuditLog() {
    return clone(this.auditLog);
  }

  getEvents(filters = {}) {
    return this.eventLedger.list(filters);
  }
}
