const DEVICE_TYPES = Object.freeze({
  light: "light",
  switch: "smart_plug",
  climate: "climate",
  cover: "curtain",
  lock: "lock",
  sensor: "sensor",
  binary_sensor: "sensor",
});

function observedAt(device) {
  const candidate = device.last_updated ?? device.last_changed ?? device.updated_at;
  if (candidate && !Number.isNaN(Date.parse(candidate))) return new Date(candidate).toISOString();
  return new Date().toISOString();
}

function stateProperties(device) {
  const attributes = { ...(device.attributes ?? {}) };
  const properties = {};

  if (["light", "switch", "climate"].includes(device.domain)) {
    properties.power = device.state === "on";
  }
  if (device.domain === "lock") properties.locked = device.state === "locked";
  if (device.domain === "cover") properties.position = attributes.position ?? null;
  if (device.domain === "sensor") {
    const numeric = Number(device.state);
    properties.value = Number.isFinite(numeric) ? numeric : null;
  }
  if (device.domain === "binary_sensor") {
    properties[attributes.device_class ?? "state"] = device.state === "on";
  }

  for (const [key, value] of Object.entries(attributes)) {
    if (!["manufacturer", "model", "min_temperature", "max_temperature", "min_value", "max_value"].includes(key)) {
      properties[key] = value;
    }
  }

  return properties;
}

function actionCapabilities(device) {
  let actions;
  switch (device.domain) {
    case "light":
      actions = {
        turn_on: { parameters: {} },
        turn_off: { parameters: {} },
        set_brightness: { parameters: { brightness: { type: "integer", minimum: 0, maximum: 100, unit: "percent" } } },
      };
      break;
    case "switch":
      actions = {
        turn_on: { parameters: {} },
        turn_off: { parameters: {} },
      };
      break;
    case "climate":
      actions = {
        turn_on: { parameters: {} },
        turn_off: { parameters: {} },
        set_temperature: {
          parameters: {
            temperature: {
              type: "number",
              minimum: device.attributes?.min_temperature,
              maximum: device.attributes?.max_temperature,
              unit: "celsius",
            },
          },
        },
      };
      break;
    case "cover":
      actions = {
        open: { parameters: {} },
        close: { parameters: {} },
        set_position: { parameters: { position: { type: "integer", minimum: 0, maximum: 100, unit: "percent" } } },
      };
      break;
    case "lock":
      actions = {
        lock: { parameters: {} },
        unlock: { parameters: {}, confirmation_required: true },
      };
      break;
    default:
      actions = {};
  }

  const observed = device.capabilities?.actions;
  if (!observed) return actions;
  return Object.fromEntries(Object.entries(actions).flatMap(([action, specification]) => {
    const evidence = observed[action];
    if (evidence?.supported === false) return [];
    return [[action, {
      ...specification,
      supported: evidence?.supported ?? null,
      ...(evidence?.source ? { support_source: evidence.source } : {}),
      ...(evidence?.evidence ? { support_evidence: evidence.evidence } : {}),
    }]];
  }));
}

/**
 * Convert the internal HA-shaped device record into the project's canonical
 * device view. The legacy record remains available for backwards compatibility.
 */
export function toCanonicalDevice(device, { platform = "mock_home_assistant" } = {}) {
  const timestamp = observedAt(device);
  const externalId = device.source?.external_id ?? device.device_id;
  const canonical = {
    schema_version: "1.0",
    device_id: device.canonical_id ?? device.device_id,
    name: device.name,
    device_type: DEVICE_TYPES[device.domain] ?? device.domain,
    source: {
      platform: device.source?.platform ?? platform,
      external_id: externalId,
    },
    availability: {
      status: device.available ? "online" : "offline",
      last_seen_at: timestamp,
      reason: device.available ? null : "device_unavailable",
    },
    state_snapshot: {
      properties: stateProperties(device),
      observed_at: timestamp,
    },
    capabilities: {
      actions: actionCapabilities(device),
    },
    diagnostics: {
      overall: device.available ? "healthy" : "unhealthy",
      device: { reachable: Boolean(device.available) },
    },
    created_at: device.created_at ?? timestamp,
    updated_at: timestamp,
  };

  if (device.space) canonical.space = device.space;
  if (device.attributes?.manufacturer || device.attributes?.model) {
    canonical.manufacturer = device.attributes.manufacturer;
    canonical.model = device.attributes.model;
  }
  return canonical;
}
