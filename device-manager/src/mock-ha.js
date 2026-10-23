import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { isActionSatisfied } from "./action-verification.js";
import { toCanonicalDevice } from "./canonical.js";
import { DeviceEventLedger } from "./events.js";
import { getDeviceActionConfirmationPolicy } from "./action-confirmation-policy.js";
import { SCENES, verifyExpectedState } from "./scenes.js";

const DEFAULT_DEVICES_PATH = new URL("../config/devices.json", import.meta.url);

function clone(value) {
  return structuredClone(value);
}

function failure(code, message, details = {}) {
  return {
    success: false,
    error: { code, message, ...details },
  };
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function numericState(device) {
  const value = Number(device.state);
  return Number.isFinite(value) ? value : null;
}

/**
 * A deterministic, in-memory stand-in for Home Assistant.
 *
 * The public methods intentionally return JSON-serializable objects instead of
 * throwing for expected device errors. This keeps the boundary predictable for
 * an LLM tool caller and mirrors the shape we can later map to real HA calls.
 */
export class MockHomeAssistant {
  #stateChangeListeners = new Set();
  #mockBehaviorListeners = new Set();

  constructor({ devices, eventRetentionLimit = 200 } = {}) {
    const initialDevices = devices ?? JSON.parse(readFileSync(DEFAULT_DEVICES_PATH, "utf8"));
    this.devices = new Map(initialDevices.map((device) => [device.device_id, clone(device)]));
    this.auditLog = [];
    this.eventLedger = new DeviceEventLedger({ retentionLimit: eventRetentionLimit });
  }

  createStateMonitor({ onStateChange = () => {} } = {}) {
    if (typeof onStateChange !== "function") throw new Error("onStateChange 必须是函数");
    const listeners = this.#stateChangeListeners;
    let running = false;
    let lastEventAt = null;
    let eventCount = 0;
    const listener = (event) => {
      if (!running) return;
      lastEventAt = event.occurred_at;
      eventCount += 1;
      try { onStateChange(clone(event)); } catch {}
    };
    const status = () => ({
      monitoring: running,
      connection_state: running ? "connected" : "stopped",
      backend_mode: "mock",
      reconnect_attempts: 0,
      last_error_code: null,
      last_event_at: lastEventAt,
      received_event_count: eventCount,
    });
    return {
      async start() {
        if (running) return { success: true, already_running: true, ...status() };
        running = true;
        listeners.add(listener);
        return { success: true, ...status() };
      },
      stop: () => {
        if (running) listeners.delete(listener);
        running = false;
        return { success: true, ...status() };
      },
      status,
    };
  }

  /** Test/demo-only, explicitly attributed learning-event monitor. */
  createMockBehaviorMonitor({ onEvent = () => {} } = {}) {
    if (typeof onEvent !== "function") throw new Error("onEvent 必须是函数");
    const listeners = this.#mockBehaviorListeners;
    let running = false;
    const listener = (event) => {
      if (!running) return;
      try { onEvent(clone(event)); } catch {}
    };
    return {
      async start() {
        if (running) return { success: true, already_running: true, backend_mode: "mock" };
        running = true;
        listeners.add(listener);
        return { success: true, backend_mode: "mock" };
      },
      stop: () => {
        if (running) listeners.delete(listener);
        running = false;
        return { success: true, backend_mode: "mock" };
      },
    };
  }

  /**
   * Test/demo-only simulated user/automation/agent action. The actor label is
   * synthetic fixture metadata, not Home Assistant provenance or authentication.
   */
  simulateBehaviorAction({
    device_id,
    action,
    temperature_c,
    brightness_pct,
    actor_source = "unknown",
    event_id = randomUUID(),
    occurred_at = new Date().toISOString(),
    time_zone = "Asia/Shanghai",
    room_id,
    subject_id = "household",
  } = {}) {
    if (!["user_manual", "automation", "agent", "unknown"].includes(actor_source)) {
      return failure("INVALID_ACTOR_SOURCE", "actor_source 必须是 user_manual、automation、agent 或 unknown");
    }
    if (typeof occurred_at !== "string"
      || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(occurred_at)
      || !Number.isFinite(Date.parse(occurred_at))) {
      return failure("INVALID_OCCURRED_AT", "模拟行为事件必须使用含时区偏移的有效 ISO 时间");
    }
    if (typeof event_id !== "string" || !event_id) {
      return failure("EVENT_ID_REQUIRED", "模拟行为事件必须包含 event_id");
    }
    const device = this.devices.get(device_id);
    if (!device) return failure("DEVICE_NOT_FOUND", `未找到设备：${device_id}`, { device_id });
    const valueField = device.domain === "climate" && action === "set_temperature"
      ? "temperature_c"
      : device.domain === "light" && action === "set_brightness"
        ? "brightness_pct"
        : null;
    if (!valueField) return failure("UNSUPPORTED_DEVICE_ACTION", "当前 Mock 学习事件只模拟空调调温和灯光亮度设置");
    const value = valueField === "temperature_c" ? temperature_c : brightness_pct;

    const actionResult = this.controlDevice({
      device_id,
      action,
      parameters: valueField === "temperature_c" ? { temperature: value } : { brightness: value },
    });
    if (!actionResult.success) return actionResult;

    const event = {
      event_type: "mock_device_action",
      origin: "mock",
      event_id,
      occurred_at,
      actor_source,
      device_id,
      domain: device.domain,
      action,
      [valueField]: value,
      time_zone,
      ...(room_id ? { room_id } : {}),
      subject_id,
    };
    for (const listener of this.#mockBehaviorListeners) listener(clone(event));
    return { success: true, event, action_result: actionResult };
  }

  /** Test/demo-only state injection; it is deliberately not an OpenClaw tool. */
  simulateStateChange({ device_id, state, available, attributes } = {}) {
    const device = this.devices.get(device_id);
    if (!device) return failure("DEVICE_NOT_FOUND", `未找到设备：${device_id}`, { device_id });
    if (state !== undefined && typeof state !== "string") {
      return failure("INVALID_ARGUMENT", "模拟 state 必须是字符串");
    }
    if (available !== undefined && typeof available !== "boolean") {
      return failure("INVALID_ARGUMENT", "模拟 available 必须是布尔值");
    }
    if (attributes !== undefined && (!attributes || typeof attributes !== "object" || Array.isArray(attributes))) {
      return failure("INVALID_ARGUMENT", "模拟 attributes 必须是对象");
    }

    const before = clone(device);
    if (state !== undefined) device.state = state;
    if (available !== undefined) device.available = available;
    if (attributes !== undefined) device.attributes = { ...device.attributes, ...clone(attributes) };
    const event = this.#stateChangeSummary(before, device);
    if (event) this.#emitStateChange(event);
    return { success: true, changed: Boolean(event), event_summary: event };
  }

  #stateChangeSummary(before, after) {
    const stateChanged = before.state !== after.state;
    const availabilityChanged = before.available !== after.available;
    const attributesChanged = JSON.stringify(before.attributes ?? {}) !== JSON.stringify(after.attributes ?? {});
    if (!stateChanged && !availabilityChanged && !attributesChanged) return null;
    return {
      device_id: after.device_id,
      domain: after.domain,
      change_type: "state_changed",
      state_changed: stateChanged,
      availability_changed: availabilityChanged,
      previous_available: before.available,
      available: after.available,
      capability_changes: [],
      occurred_at: new Date().toISOString(),
    };
  }

  #emitStateChange(event) {
    for (const listener of this.#stateChangeListeners) listener(clone(event));
  }

  listDevices({ domain, canonical = false } = {}) {
    const devices = [...this.devices.values()]
      .filter((device) => !domain || device.domain === domain)
      .map(clone);

    return {
      success: true,
      count: devices.length,
      devices: canonical ? devices.map((device) => toCanonicalDevice(device)) : devices,
    };
  }

  getState({ device_id, canonical = false } = {}) {
    if (!device_id) {
      return failure("INVALID_ARGUMENT", "device_id 是必填参数");
    }

    const device = this.devices.get(device_id);
    if (!device) {
      return failure("DEVICE_NOT_FOUND", `未找到设备：${device_id}`, { device_id });
    }

    return {
      success: true,
      device: canonical ? toCanonicalDevice(device) : clone(device),
    };
  }

  diagnoseDevice({ device_id, trace_id = null, emit_alert_events = true } = {}) {
    if (device_id) {
      const device = this.devices.get(device_id);
      if (!device) {
        return failure("DEVICE_NOT_FOUND", `未找到设备：${device_id}`, { device_id });
      }
      const diagnosis = this.#diagnoseOne(device);
      if (emit_alert_events && diagnosis.status !== "healthy") this.recordDiagnosticAlert({ ...diagnosis, trace_id });
      return {
        success: true,
        count: 1,
        diagnoses: [diagnosis],
      };
    }

    const diagnoses = [...this.devices.values()].map((device) => this.#diagnoseOne(device));
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
        healthy: diagnoses.filter((diagnosis) => diagnosis.status === "healthy").length,
        abnormal: diagnoses.filter((diagnosis) => diagnosis.status === "abnormal").length,
        offline: diagnoses.filter((diagnosis) => diagnosis.status === "offline").length,
      },
    };
  }

  #diagnoseOne(device) {
    const base = {
      device_id: device.device_id,
      name: device.name,
      domain: device.domain,
      state: device.state,
      available: device.available,
      status: "healthy",
      code: "OK",
      summary: "设备在线，当前状态和属性在模拟设备允许范围内。",
      evidence: [{ field: "available", expected: true, actual: device.available }],
      recommendations: [],
    };

    if (!device.available || ["unavailable", "unknown"].includes(device.state)) {
      return {
        ...base,
        status: "offline",
        code: "DEVICE_OFFLINE",
        summary: "设备当前离线或不可用，无法执行控制。",
        evidence: [
          { field: "available", expected: true, actual: device.available },
          ...(typeof device.state === "string" && ["unavailable", "unknown"].includes(device.state)
            ? [{ field: "state", expected: "available", actual: device.state }]
            : []),
        ],
        recommendations: ["检查设备供电和网络连接", "确认 Home Assistant 中该实体是否仍存在"],
      };
    }

    const issues = [];
    if (device.domain === "light") {
      const brightness = device.attributes?.brightness;
      if (!Number.isInteger(brightness) || brightness < 0 || brightness > 100) {
        issues.push(`亮度属性异常：${brightness}`);
      }
      if ((device.state === "off" && brightness !== 0) || (device.state === "on" && brightness === 0)) {
        issues.push(`灯具状态与亮度不一致：state=${device.state}, brightness=${brightness}`);
      }
    }
    if (device.domain === "switch" && !["on", "off"].includes(device.state)) {
      issues.push(`插座状态异常：${device.state}`);
    }
    if (device.domain === "climate") {
      const { temperature, min_temperature: min, max_temperature: max } = device.attributes ?? {};
      if (!isFiniteNumber(temperature) || temperature < min || temperature > max) {
        issues.push(`温度属性超出允许范围：${temperature}℃（允许 ${min}-${max}℃）`);
      }
    }
    if (device.domain === "cover") {
      const position = device.attributes?.position;
      if (!Number.isInteger(position) || position < 0 || position > 100) {
        issues.push(`开合度属性异常：${position}`);
      }
      if ((device.state === "closed" && position !== 0) || (device.state === "open" && position !== 100)) {
        issues.push(`窗帘状态与开合度不一致：state=${device.state}, position=${position}`);
      }
    }
    if (device.domain === "lock" && !["locked", "unlocked"].includes(device.state)) {
      issues.push(`门锁状态异常：${device.state}`);
    }
    if (device.domain === "sensor") {
      const value = numericState(device);
      const { min_value: min, max_value: max } = device.attributes ?? {};
      if (value === null || !isFiniteNumber(min) || !isFiniteNumber(max) || value < min || value > max) {
        issues.push(`传感器数值异常：${device.state}（允许 ${min}-${max}）`);
      }
    }
    if (device.domain === "binary_sensor" && !["on", "off"].includes(device.state)) {
      issues.push(`二值传感器状态异常：${device.state}`);
    }

    if (issues.length === 0) return base;
    return {
      ...base,
      status: "abnormal",
      code: "STATE_INCONSISTENT",
      summary: "设备在线，但状态或属性存在异常。",
      evidence: [...base.evidence, ...issues.map((message) => ({ field: "state_or_attributes", message }))],
      recommendations: ["读取设备实时状态并与 Home Assistant 实体配置对照", "必要时重新加载或重连该设备"],
    };
  }

  listScenes() {
    return {
      success: true,
      scenes: Object.entries(SCENES).map(([scene_id, scene]) => ({
        scene_id,
        name: scene.name,
        description: scene.description,
      })),
    };
  }

  runScene({ scene_id, planned_temperature_c, planned_brightness_pct, task_id = null, trace_id = null } = {}) {
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
      if (!temperatureStep || !isFiniteNumber(planned_temperature_c)) {
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

    // Check every target before changing anything: an offline device must not
    // leave the household with only part of a scene executed.
    const unavailable = steps
      .map((step) => this.devices.get(step.device_id))
      .find((device) => !device || !device.available);
    if (unavailable) {
      return failure("SCENE_PREFLIGHT_FAILED", `场景无法执行，设备不可用：${unavailable?.name ?? "未知设备"}`, {
        scene_id,
        device_id: unavailable?.device_id,
      });
    }

    if (planned_temperature_c !== undefined) {
      const climateDevice = this.devices.get(temperatureStep.device_id);
      const { min_temperature, max_temperature } = climateDevice.attributes ?? {};
      if (!isFiniteNumber(min_temperature) || !isFiniteNumber(max_temperature)) {
        return failure("SCENE_PREFLIGHT_FAILED", "无法确认空调温控范围；个性化场景未执行", {
          scene_id,
          device_id: temperatureStep.device_id,
          cause: "DEVICE_RANGE_UNKNOWN",
        });
      }
      if (planned_temperature_c < min_temperature || planned_temperature_c > max_temperature) {
        return failure("SCENE_PREFLIGHT_FAILED", "个性化温度超出空调当前允许范围；场景未执行", {
          scene_id,
          device_id: temperatureStep.device_id,
          cause: "PREFERENCE_OUTSIDE_DEVICE_RANGE",
          minimum_temperature_c: min_temperature,
          maximum_temperature_c: max_temperature,
        });
      }
    }

    if (planned_brightness_pct !== undefined) {
      const lightDevice = this.devices.get(brightnessStep.device_id);
      const capability = lightDevice.capabilities?.actions?.set_brightness;
      if (capability?.supported === false
        || (capability?.supported !== true && !isFiniteNumber(lightDevice.attributes?.brightness))) {
        return failure("SCENE_PREFLIGHT_FAILED", "无法确认灯具支持亮度调节；个性化场景未执行", {
          scene_id,
          device_id: brightnessStep.device_id,
          cause: capability?.supported === false ? "DEVICE_ACTION_UNSUPPORTED" : "DEVICE_CAPABILITY_UNKNOWN",
        });
      }
    }

    const executions = steps.map((step) => ({
      device_id: step.device_id,
      action: step.action,
      result: this.controlDevice({ ...step, task_id, trace_id }),
    }));
    const expectedStates = clone(scene.expected);
    if (planned_temperature_c !== undefined) {
      expectedStates[temperatureStep.device_id].attributes.temperature = planned_temperature_c;
    }
    if (planned_brightness_pct !== undefined) {
      expectedStates[brightnessStep.device_id].attributes.brightness = planned_brightness_pct;
    }
    const verification = Object.entries(expectedStates).map(([device_id, expected]) => {
      const result = this.getState({ device_id });
      const device = result.device;
      const verified = result.success && verifyExpectedState(device, expected);
      return { device_id, expected, verified, result };
    });

    return {
      success: executions.every((entry) => entry.result.success)
        && verification.every((entry) => entry.verified),
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

  controlDevice({ device_id, action, parameters = {}, confirmed = false, trace_id = null, task_id = null, idempotency_key = null } = {}) {
    if (!device_id || !action) {
      return failure("INVALID_ARGUMENT", "device_id 和 action 是必填参数");
    }

    const device = this.devices.get(device_id);
    if (!device) {
      this.eventLedger.append({
        event_type: "action_failed",
        device_id,
        severity: "warning",
        trace_id,
        payload: { action, code: "DEVICE_NOT_FOUND" },
      });
      return failure("DEVICE_NOT_FOUND", `未找到设备：${device_id}`, { device_id });
    }
    if (!device.available) {
      this.eventLedger.append({
        event_type: "action_failed",
        device_id,
        severity: "warning",
        trace_id,
        payload: { action, code: "DEVICE_UNAVAILABLE" },
      });
      return failure("DEVICE_UNAVAILABLE", `设备当前不可用：${device.name}`, { device_id });
    }

    const before = clone(device);
    const actionResult = this.#applyAction(device, action, parameters, confirmed);
    if (!actionResult.success) {
      this.eventLedger.append({
        event_type: "action_failed",
        device_id,
        severity: actionResult.error.code === "CONFIRMATION_REQUIRED" ? "critical" : "warning",
        trace_id,
        payload: { action, code: actionResult.error.code, message: actionResult.error.message },
      });
      return actionResult;
    }

    const after = clone(device);
    this.#emitStateChangeIfChanged(before, after);
    const verified = isActionSatisfied(after, action, parameters);
    const auditEntry = {
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
    };
    this.auditLog.push(auditEntry);

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
        "设备控制请求已执行，但状态回读未达到目标",
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
      canonical_device: toCanonicalDevice(after),
      verified,
      verification_required: true,
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

  #emitStateChangeIfChanged(before, after) {
    const event = this.#stateChangeSummary(before, after);
    if (event) this.#emitStateChange(event);
  }

  #applyAction(device, action, parameters, confirmed) {
    const confirmationPolicy = getDeviceActionConfirmationPolicy(device, action);
    if (confirmationPolicy.required && confirmed !== true) {
      return failure("CONFIRMATION_REQUIRED", confirmationPolicy.message, {
        device_id: device.device_id,
        action,
        reason_code: confirmationPolicy.reason_code,
      });
    }

    switch (device.domain) {
      case "light":
        return this.#controlLight(device, action, parameters);
      case "switch":
        return this.#controlSwitch(device, action);
      case "climate":
        return this.#controlClimate(device, action, parameters);
      case "cover":
        return this.#controlCover(device, action, parameters);
      case "lock":
        return this.#controlLock(device, action);
      default:
        return failure("UNSUPPORTED_DOMAIN", `暂不支持设备类型：${device.domain}`);
    }
  }

  #controlLight(device, action, parameters) {
    if (action === "turn_on") {
      device.state = "on";
      if (device.attributes.brightness === 0) device.attributes.brightness = 100;
      return { success: true };
    }
    if (action === "turn_off") {
      device.state = "off";
      device.attributes.brightness = 0;
      return { success: true };
    }
    if (action === "set_brightness") {
      const brightness = parameters.brightness;
      if (!Number.isInteger(brightness) || brightness < 0 || brightness > 100) {
        return failure("INVALID_PARAMETER", "brightness 必须是 0 到 100 的整数");
      }
      device.attributes.brightness = brightness;
      device.state = brightness === 0 ? "off" : "on";
      return { success: true };
    }
    return failure("UNSUPPORTED_ACTION", `灯具不支持操作：${action}`);
  }

  #controlSwitch(device, action) {
    if (action === "turn_on") {
      device.state = "on";
      device.attributes.power_w = device.attributes.power_w || 1;
      return { success: true };
    }
    if (action === "turn_off") {
      device.state = "off";
      device.attributes.power_w = 0;
      return { success: true };
    }
    return failure("UNSUPPORTED_ACTION", `插座不支持操作：${action}`);
  }

  #controlClimate(device, action, parameters) {
    if (action === "turn_on" || action === "turn_off") {
      device.state = action === "turn_on" ? "on" : "off";
      return { success: true };
    }
    if (action === "set_temperature") {
      const temperature = parameters.temperature;
      const min = device.attributes.min_temperature;
      const max = device.attributes.max_temperature;
      if (!isFiniteNumber(temperature) || temperature < min || temperature > max) {
        return failure("INVALID_PARAMETER", `temperature 必须在 ${min} 到 ${max}℃ 之间`);
      }
      device.attributes.temperature = temperature;
      return { success: true };
    }
    return failure("UNSUPPORTED_ACTION", `空调不支持操作：${action}`);
  }

  #controlCover(device, action, parameters) {
    if (action === "open") {
      device.state = "open";
      device.attributes.position = 100;
      return { success: true };
    }
    if (action === "close") {
      device.state = "closed";
      device.attributes.position = 0;
      return { success: true };
    }
    if (action === "set_position") {
      const position = parameters.position;
      if (!Number.isInteger(position) || position < 0 || position > 100) {
        return failure("INVALID_PARAMETER", "position 必须是 0 到 100 的整数");
      }
      device.attributes.position = position;
      device.state = position === 0 ? "closed" : "open";
      return { success: true };
    }
    return failure("UNSUPPORTED_ACTION", `窗帘不支持操作：${action}`);
  }

  #controlLock(device, action) {
    if (action === "lock") {
      device.state = "locked";
      return { success: true };
    }
    if (action === "unlock") {
      device.state = "unlocked";
      return { success: true };
    }
    return failure("UNSUPPORTED_ACTION", `门锁不支持操作：${action}`);
  }
}
