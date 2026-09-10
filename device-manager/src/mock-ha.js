import { readFileSync } from "node:fs";

const DEFAULT_DEVICES_PATH = new URL("../config/devices.json", import.meta.url);

const SCENES = Object.freeze({
  home: {
    name: "回家模式",
    description: "打开客厅灯、打开客厅窗帘，并开启卧室空调至 26℃。",
    steps: [
      { device_id: "light.living_room", action: "set_brightness", parameters: { brightness: 70 } },
      { device_id: "cover.living_room_curtain", action: "open" },
      { device_id: "climate.bedroom", action: "turn_on" },
      { device_id: "climate.bedroom", action: "set_temperature", parameters: { temperature: 26 } },
    ],
    expected: {
      "light.living_room": { state: "on", attributes: { brightness: 70 } },
      "cover.living_room_curtain": { state: "open", attributes: { position: 100 } },
      "climate.bedroom": { state: "on", attributes: { temperature: 26 } },
    },
  },
  sleep: {
    name: "睡眠模式",
    description: "关闭客厅灯、关闭客厅窗帘，并开启卧室空调至 26℃。",
    steps: [
      { device_id: "light.living_room", action: "turn_off" },
      { device_id: "cover.living_room_curtain", action: "close" },
      { device_id: "climate.bedroom", action: "turn_on" },
      { device_id: "climate.bedroom", action: "set_temperature", parameters: { temperature: 26 } },
    ],
    expected: {
      "light.living_room": { state: "off", attributes: { brightness: 0 } },
      "cover.living_room_curtain": { state: "closed", attributes: { position: 0 } },
      "climate.bedroom": { state: "on", attributes: { temperature: 26 } },
    },
  },
});

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

  diagnoseDevice({ device_id } = {}) {
    if (device_id) {
      const device = this.devices.get(device_id);
      if (!device) {
        return failure("DEVICE_NOT_FOUND", `未找到设备：${device_id}`, { device_id });
      }
      return {
        success: true,
        count: 1,
        diagnoses: [this.#diagnoseOne(device)],
      };
    }

    const diagnoses = [...this.devices.values()].map((device) => this.#diagnoseOne(device));
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
      const verified = result.success
        && device.state === expected.state
        && Object.entries(expected.attributes).every(([key, value]) => device.attributes[key] === value);
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
