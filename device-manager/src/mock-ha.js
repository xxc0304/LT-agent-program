import { readFileSync } from "node:fs";

import { isActionSatisfied } from "./action-verification.js";
import { toCanonicalDevice } from "./canonical.js";
import { DeviceEventLedger } from "./events.js";
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
  constructor({ devices } = {}) {
    const initialDevices = devices ?? JSON.parse(readFileSync(DEFAULT_DEVICES_PATH, "utf8"));
    this.devices = new Map(initialDevices.map((device) => [device.device_id, clone(device)]));
    this.auditLog = [];
    this.eventLedger = new DeviceEventLedger();
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

  diagnoseDevice({ device_id, trace_id = null } = {}) {
    if (device_id) {
      const device = this.devices.get(device_id);
      if (!device) {
        return failure("DEVICE_NOT_FOUND", `未找到设备：${device_id}`, { device_id });
      }
      const diagnosis = this.#diagnoseOne(device);
      if (diagnosis.status !== "healthy") {
        this.eventLedger.append({
          event_type: "diagnostic_alert",
          device_id,
          severity: diagnosis.status === "offline" ? "critical" : "warning",
          trace_id,
          payload: { code: diagnosis.code, summary: diagnosis.summary },
        });
      }
      return {
        success: true,
        count: 1,
        diagnoses: [diagnosis],
      };
    }

    const diagnoses = [...this.devices.values()].map((device) => this.#diagnoseOne(device));
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

    if (!device.available) {
      return {
        ...base,
        status: "offline",
        code: "DEVICE_OFFLINE",
        summary: "设备当前离线或不可用，无法执行控制。",
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

  runScene({ scene_id } = {}) {
    const scene = SCENES[scene_id];
    if (!scene) {
      return failure("SCENE_NOT_FOUND", `未找到场景：${scene_id}`, {
        scene_id,
        available_scenes: Object.keys(SCENES),
      });
    }

    // Check every target before changing anything: an offline device must not
    // leave the household with only part of a scene executed.
    const unavailable = scene.steps
      .map((step) => this.devices.get(step.device_id))
      .find((device) => !device || !device.available);
    if (unavailable) {
      return failure("SCENE_PREFLIGHT_FAILED", `场景无法执行，设备不可用：${unavailable?.name ?? "未知设备"}`, {
        scene_id,
        device_id: unavailable?.device_id,
      });
    }

    const executions = scene.steps.map((step) => ({
      device_id: step.device_id,
      action: step.action,
      result: this.controlDevice(step),
    }));
    const verification = Object.entries(scene.expected).map(([device_id, expected]) => {
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

  #applyAction(device, action, parameters, confirmed) {
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
        return this.#controlLock(device, action, confirmed);
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

  #controlLock(device, action, confirmed) {
    if (action === "lock") {
      device.state = "locked";
      return { success: true };
    }
    if (action === "unlock") {
      if (!confirmed) {
        return failure(
          "CONFIRMATION_REQUIRED",
          "开锁属于高风险操作，必须得到用户明确确认",
          { device_id: device.device_id, action },
        );
      }
      device.state = "unlocked";
      return { success: true };
    }
    return failure("UNSUPPORTED_ACTION", `门锁不支持操作：${action}`);
  }
}
