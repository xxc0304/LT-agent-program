import { readFileSync } from "node:fs";

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
  }

  listDevices({ domain } = {}) {
    const devices = [...this.devices.values()]
      .filter((device) => !domain || device.domain === domain)
      .map(clone);

    return {
      success: true,
      count: devices.length,
      devices,
    };
  }

  getState({ device_id } = {}) {
    if (!device_id) {
      return failure("INVALID_ARGUMENT", "device_id 是必填参数");
    }

    const device = this.devices.get(device_id);
    if (!device) {
      return failure("DEVICE_NOT_FOUND", `未找到设备：${device_id}`, { device_id });
    }

    return {
      success: true,
      device: clone(device),
    };
  }

  controlDevice({ device_id, action, parameters = {}, confirmed = false } = {}) {
    if (!device_id || !action) {
      return failure("INVALID_ARGUMENT", "device_id 和 action 是必填参数");
    }

    const device = this.devices.get(device_id);
    if (!device) {
      return failure("DEVICE_NOT_FOUND", `未找到设备：${device_id}`, { device_id });
    }
    if (!device.available) {
      return failure("DEVICE_UNAVAILABLE", `设备当前不可用：${device.name}`, { device_id });
    }

    const before = clone(device);
    const actionResult = this.#applyAction(device, action, parameters, confirmed);
    if (!actionResult.success) {
      return actionResult;
    }

    const after = clone(device);
    const auditEntry = {
      sequence: this.auditLog.length + 1,
      device_id,
      action,
      parameters: clone(parameters),
      confirmed,
      before,
      after,
    };
    this.auditLog.push(auditEntry);

    return {
      success: true,
      device_id,
      action,
      old_state: before.state,
      new_state: after.state,
      device: after,
      verification_required: true,
    };
  }

  getAuditLog() {
    return clone(this.auditLog);
  }

  #applyAction(device, action, parameters, confirmed) {
    switch (device.domain) {
      case "light":
        return this.#controlLight(device, action, parameters);
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
