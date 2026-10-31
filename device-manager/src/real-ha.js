import { SCENES, verifyExpectedState } from "./scenes.js";
import { isActionSatisfied } from "./action-verification.js";
import { toCanonicalDevice } from "./canonical.js";
import { DeviceEventLedger } from "./events.js";
import { getDeviceActionConfirmationPolicy } from "./action-confirmation-policy.js";
import { enrichEntitiesWithRegistries } from "./home-assistant-registry.js";
import { HomeAssistantStateMonitor } from "./home-assistant-state-monitor.js";
import { discoverHomeAssistantCapabilities, getExplicitlyUnsupportedAction } from "./ha-capabilities.js";

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

function normalizeEntity(entity, confirmationRequiredEntityIds = new Set()) {
  const deviceId = entity.entity_id;
  const domain = deviceId.split(".", 1)[0];
  const available = !["unavailable", "unknown"].includes(entity.state);
  let state = entity.state;

  // Home Assistant 的 climate 状态通常是 cool/heat/auto；设备管家统一成 on/off，
  // 同时在 attributes.hvac_mode 中保留原始状态。
  const attributes = normalizeAttributes(domain, entity.attributes);
  const capabilities = discoverHomeAssistantCapabilities(entity);
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
    capabilities,
    ...(entity.ha_device_id ? { ha_device_id: entity.ha_device_id } : {}),
    ...(entity.ha_entity_unique_id ? { ha_entity_unique_id: entity.ha_entity_unique_id } : {}),
    ...(entity.ha_area_id ? { ha_area_id: entity.ha_area_id } : {}),
    ...(entity.area_name ? { area_name: entity.area_name } : {}),
    ...(entity.source_device_name ? { source_device_name: entity.source_device_name } : {}),
    ...(entity.manufacturer ? { manufacturer: entity.manufacturer } : {}),
    ...(entity.model ? { model: entity.model } : {}),
    ...(confirmationRequiredEntityIds.has(deviceId) ? { requires_confirmation: true } : {}),
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

function serviceFor(device, action, parameters, confirmed, lockAuthorizationVerifier, lockAuthorizationProof, lockAuthorizationContext) {
  const data = { entity_id: device.device_id };

  const unsupportedCapability = getExplicitlyUnsupportedAction(device.capabilities, action);
  if (unsupportedCapability) {
    return failure("UNSUPPORTED_ACTION", `${device.name} 不支持操作：${action}`, {
      device_id: device.device_id,
      action,
      capability_evidence: unsupportedCapability.evidence,
    });
  }

  const confirmationPolicy = getDeviceActionConfirmationPolicy(device, action);
  if (confirmationPolicy.required && confirmed !== true) {
    return failure("CONFIRMATION_REQUIRED", confirmationPolicy.message, {
      device_id: device.device_id,
      action,
      reason_code: confirmationPolicy.reason_code,
    });
  }
  if (action === "unlock") {
    const authorization = lockAuthorizationVerifier?.verifyLockAuthorization?.({
      proof: lockAuthorizationProof,
      expected: {
        ...lockAuthorizationContext,
        device_id: device.device_id,
        action,
      },
    });
    if (authorization?.success !== true) {
      return failure(
        authorization?.error?.code ?? "TRUSTED_AUTHENTICATION_REQUIRED",
        authorization?.error?.message ?? "开锁需要可信认证界面的短时授权；普通聊天确认不能代替认证。",
        { device_id: device.device_id, action, reason_code: "TRUSTED_AUTHENTICATION_REQUIRED" },
      );
    }
  }
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
  constructor({ baseUrl, token, entityAllowlist, confirmationRequiredEntityIds, fetchImpl = globalThis.fetch, timeoutMs = 8_000, registryClient = null, eventRetentionLimit = 200, eventLedger, lockAuthorizationVerifier = null } = {}) {
    if (!baseUrl) throw new Error("使用真实 Home Assistant 时必须设置 HA_URL");
    if (!token) throw new Error("使用真实 Home Assistant 时必须设置 HA_TOKEN");
    if (typeof fetchImpl !== "function") throw new Error("当前 Node.js 环境不支持 fetch");

    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.token = token;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.registryClient = registryClient;
    this.entityAllowlist = entityAllowlist?.length ? new Set(entityAllowlist) : null;
    this.confirmationRequiredEntityIds = new Set(confirmationRequiredEntityIds ?? []);
    this.lockAuthorizationVerifier = lockAuthorizationVerifier;
    this.auditLog = [];
    if (eventLedger !== undefined
      && (typeof eventLedger.append !== "function" || typeof eventLedger.list !== "function")) {
      throw new Error("eventLedger 必须提供 append() 和 list() 方法");
    }
    this.eventLedger = eventLedger ?? new DeviceEventLedger({
      sourceType: "home_assistant",
      sourceId: this.baseUrl,
      retentionLimit: eventRetentionLimit,
    });
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

  createStateMonitor(options = {}) {
    return new HomeAssistantStateMonitor({
      baseUrl: this.baseUrl,
      token: this.token,
      ...options,
    });
  }

  async listDevices({ domain, canonical = false } = {}) {
    const response = await this.#request("/api/states");
    if (!response.success) return response;

    let sourceEntities = response.data;
    let registryEnrichment = { status: "disabled" };
    let disabledEntityCount = 0;
    if (this.registryClient) {
      let registryResult;
      try {
        registryResult = await this.registryClient.listRegistries();
      } catch {
        registryResult = failure("HA_REGISTRY_QUERY_FAILED", "Home Assistant 注册表查询失败");
      }
      if (registryResult?.success && registryResult.registries) {
        const enriched = enrichEntitiesWithRegistries(sourceEntities, registryResult.registries);
        sourceEntities = enriched.devices;
        disabledEntityCount = enriched.disabled_entity_count;
        registryEnrichment = { status: "available" };
      } else {
        registryEnrichment = {
          status: "unavailable",
          code: registryResult?.error?.code ?? "HA_REGISTRY_QUERY_FAILED",
          message: registryResult?.error?.message ?? "HA 注册表暂不可用；结果仅包含 REST 实体信息",
        };
      }
    }

    const devices = sourceEntities
      .filter((entity) => {
        const entityDomain = entity.entity_id?.split(".", 1)[0];
        return SUPPORTED_DOMAINS.has(entityDomain)
          && (!domain || entityDomain === domain)
          && this.#isAllowed(entity.entity_id);
      })
      .map((entity) => normalizeEntity(entity, this.confirmationRequiredEntityIds));

    return {
      success: true,
      count: devices.length,
      registry_enrichment: registryEnrichment,
      ...(registryEnrichment.status === "available" ? { disabled_entity_count: disabledEntityCount } : {}),
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
    const device = normalizeEntity(response.data, this.confirmationRequiredEntityIds);
    return {
      success: true,
      device: canonical ? toCanonicalDevice(device, { platform: "home_assistant" }) : device,
    };
  }

  async controlDevice({ device_id, action, parameters = {}, confirmed = false, lock_authorization_proof, lock_authorization_context, trace_id = null, task_id = null, idempotency_key = null } = {}) {
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

    const mapping = serviceFor(
      before,
      action,
      parameters,
      confirmed,
      this.lockAuthorizationVerifier,
      lock_authorization_proof,
      lock_authorization_context,
    );
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

  async runScene({ scene_id, planned_temperature_c, planned_brightness_pct, task_id = null, trace_id = null } = {}) {
    const scene = SCENES[scene_id];
    if (!scene) {
      return failure("SCENE_NOT_FOUND", `未找到场景：${scene_id}`, {
        scene_id,
        available_scenes: Object.keys(SCENES),
      });
    }

    const steps = clone(scene.steps);
    const temperatureStep = steps.find((step) => step.action === "set_temperature");
    const brightnessStep = steps.find((step) => step.action === "set_brightness");
    if (planned_temperature_c !== undefined) {
      if (!temperatureStep || !Number.isFinite(planned_temperature_c)) {
        return failure("INVALID_PARAMETER", "个性化温度只能用于包含温度步骤的场景，且必须为有效数值", { scene_id });
      }
      temperatureStep.parameters = { ...temperatureStep.parameters, temperature: planned_temperature_c };
    }
    if (planned_brightness_pct !== undefined) {
      if (!brightnessStep || !Number.isInteger(planned_brightness_pct) || planned_brightness_pct < 1 || planned_brightness_pct > 100) {
        return failure("INVALID_PARAMETER", "个性化亮度只能用于包含亮度步骤的场景，且必须为 1 到 100 的整数", { scene_id });
      }
      brightnessStep.parameters = { ...brightnessStep.parameters, brightness: planned_brightness_pct };
    }

    const targetIds = [...new Set(steps.map((step) => step.device_id))];
    const preflightStates = new Map();
    for (const device_id of targetIds) {
      const state = await this.getState({ device_id });
      if (!state.success || !state.device.available) {
        return failure("SCENE_PREFLIGHT_FAILED", `场景无法执行，设备不可用：${device_id}`, {
          scene_id,
          device_id,
          cause: state.success ? "DEVICE_UNAVAILABLE" : state.error.code,
        });
      }
      preflightStates.set(device_id, state.device);
    }

    if (planned_temperature_c !== undefined) {
      const climateDevice = preflightStates.get(temperatureStep.device_id);
      const min = climateDevice?.attributes?.min_temperature;
      const max = climateDevice?.attributes?.max_temperature;
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        return failure("SCENE_PREFLIGHT_FAILED", "无法确认空调温控范围；个性化场景未执行", {
          scene_id,
          device_id: temperatureStep.device_id,
          cause: "DEVICE_RANGE_UNKNOWN",
        });
      }
      if (planned_temperature_c < min || planned_temperature_c > max) {
        return failure("SCENE_PREFLIGHT_FAILED", "个性化温度超出空调当前允许范围；场景未执行", {
          scene_id,
          device_id: temperatureStep.device_id,
          cause: "PREFERENCE_OUTSIDE_DEVICE_RANGE",
          minimum_temperature_c: min,
          maximum_temperature_c: max,
        });
      }
    }

    if (planned_brightness_pct !== undefined) {
      const lightDevice = preflightStates.get(brightnessStep.device_id);
      const capability = lightDevice?.capabilities?.actions?.set_brightness;
      const hasObservedBrightness = Number.isFinite(lightDevice?.attributes?.brightness);
      if (capability?.supported === false
        || (capability?.supported !== true && !hasObservedBrightness)) {
        return failure("SCENE_PREFLIGHT_FAILED", "无法确认灯具支持亮度调节；个性化场景未执行", {
          scene_id,
          device_id: brightnessStep.device_id,
          cause: capability?.supported === false ? "DEVICE_ACTION_UNSUPPORTED" : "DEVICE_CAPABILITY_UNKNOWN",
        });
      }
    }

    for (const step of steps) {
      const device = preflightStates.get(step.device_id);
      const actionMapping = serviceFor(device, step.action, step.parameters ?? {}, false, this.lockAuthorizationVerifier);
      if (actionMapping.success === false) {
        return failure("SCENE_PREFLIGHT_FAILED", "场景中有设备动作不受支持或参数无效；整个场景未执行", {
          scene_id,
          device_id: step.device_id,
          action: step.action,
          cause: actionMapping.error.code,
          ...(actionMapping.error.capability_evidence
            ? { capability_evidence: actionMapping.error.capability_evidence }
            : {}),
        });
      }
    }

    const executions = [];
    for (const step of steps) {
      const result = await this.controlDevice({ ...step, task_id, trace_id });
      executions.push({ device_id: step.device_id, action: step.action, result });
      if (!result.success) {
        return {
          success: false,
          scene_id,
          scene_name: scene.name,
          ...(planned_temperature_c !== undefined ? { planned_temperature_c } : {}),
          ...(task_id ? { task_id } : {}),
          ...(trace_id ? { trace_id } : {}),
          executions,
          verification: [],
          error: result.error,
        };
      }
    }

    const expectedStates = clone(scene.expected);
    if (planned_temperature_c !== undefined) {
      expectedStates[temperatureStep.device_id].attributes.temperature = planned_temperature_c;
    }
    if (planned_brightness_pct !== undefined) {
      expectedStates[brightnessStep.device_id].attributes.brightness = planned_brightness_pct;
    }
    const verification = [];
    for (const [device_id, expected] of Object.entries(expectedStates)) {
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
      ...(planned_temperature_c !== undefined ? { planned_temperature_c } : {}),
      ...(planned_brightness_pct !== undefined ? { planned_brightness_pct } : {}),
      ...(task_id ? { task_id } : {}),
      ...(trace_id ? { trace_id } : {}),
      executions,
      verification,
      verification_required: false,
    };
  }

  async diagnoseDevice({ device_id, trace_id = null, emit_alert_events = true } = {}) {
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

    if (emit_alert_events) {
      for (const diagnosis of diagnoses.filter((item) => item.status !== "healthy")) {
        this.recordDiagnosticAlert({ ...diagnosis, trace_id });
      }
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

  recordDiagnosticAlert({ device_id, status, code, summary, severity = "warning", trace_id = null } = {}) {
    return this.eventLedger.append({
      event_type: "diagnostic_alert",
      device_id,
      severity: ["warning", "critical"].includes(severity) ? severity : "warning",
      trace_id,
      payload: { code, summary },
    });
  }

  recordDiagnosticSharedInfrastructure({ affected_device_count = 0, summary } = {}) {
    return this.eventLedger.append({
      event_type: "diagnostic_shared_infrastructure_suspected",
      severity: "warning",
      payload: {
        affected_device_count: Number.isSafeInteger(affected_device_count) ? Math.max(0, affected_device_count) : 0,
        summary: typeof summary === "string" ? summary : "多台家庭设备同时持续离线，可能存在共同基础设施问题；尚未自动判定根因。",
      },
    });
  }

  recordDiagnosticSharedInfrastructureResolved({ affected_device_count = 0, summary } = {}) {
    return this.eventLedger.append({
      event_type: "diagnostic_shared_infrastructure_cleared",
      severity: "info",
      payload: {
        affected_device_count: Number.isSafeInteger(affected_device_count) ? Math.max(0, affected_device_count) : 0,
        summary: typeof summary === "string" ? summary : "同时离线设备数量已低于共同基础设施提示阈值。",
      },
    });
  }

  recordDiagnosticTransient({ device_id, code, duration_ms } = {}) {
    const safeCode = typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : "DEVICE_OFFLINE";
    return this.eventLedger.append({
      event_type: "diagnostic_transient",
      device_id,
      severity: "info",
      payload: {
        code: safeCode,
        duration_ms: Number.isFinite(duration_ms) ? Math.max(0, Math.round(duration_ms)) : 0,
        summary: "设备在离线宽限期内恢复可用，未生成故障告警。",
      },
    });
  }

  recordDiagnosticRecovery({ device_id, previous_code } = {}) {
    return this.eventLedger.append({
      event_type: "diagnostic_recovered",
      device_id,
      severity: "info",
      payload: {
        previous_code: typeof previous_code === "string" ? previous_code : "UNKNOWN",
        summary: "设备当前健康状态已恢复，活动诊断告警已清除。",
      },
    });
  }

  recordDiagnosticTrackingEnded({ device_id, previous_code } = {}) {
    return this.eventLedger.append({
      event_type: "diagnostic_tracking_ended",
      device_id,
      severity: "info",
      payload: {
        previous_code: typeof previous_code === "string" ? previous_code : "UNKNOWN",
        reason: "entity_missing_from_ha_inventory",
        summary: "实体未出现在成功的 Home Assistant 清单扫描中，已停止跟踪该活动告警；设备是否修复未知。",
      },
    });
  }
}
