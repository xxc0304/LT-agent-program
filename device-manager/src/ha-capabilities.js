function action(supported, evidence, source) {
  return { supported, source, evidence };
}

function readFeatureFlags(attributes) {
  return Number.isInteger(attributes.supported_features) && attributes.supported_features >= 0
    ? attributes.supported_features
    : null;
}

function supportsFeature(flags, mask, evidenceName) {
  return action((flags & mask) !== 0, `supported_features=${flags}; ${evidenceName}=${(flags & mask) !== 0}`, "ha_supported_features");
}

/**
 * Derive action support from Home Assistant entity attributes. A null
 * `supported` value means HA did not provide enough evidence; callers should
 * preserve the legacy action path and let HA decide, rather than guessing it
 * is unsupported.
 */
export function discoverHomeAssistantCapabilities(entity) {
  const domain = entity.entity_id?.split(".", 1)[0] ?? "";
  const attributes = entity.attributes ?? {};
  const supportedFeatures = readFeatureFlags(attributes);
  const actions = {};
  let hasExplicitCapabilities = false;

  if (domain === "light") {
    actions.turn_on = action(true, "HA light domain supports turn_on", "ha_domain");
    actions.turn_off = action(true, "HA light domain supports turn_off", "ha_domain");
    if (Array.isArray(attributes.supported_color_modes)) {
      const modes = attributes.supported_color_modes;
      const supported = modes.some((mode) => mode !== "onoff");
      actions.set_brightness = action(supported, `supported_color_modes=${modes.join(",")}`, "ha_supported_color_modes");
      hasExplicitCapabilities = true;
    } else if (Number.isFinite(attributes.brightness)) {
      actions.set_brightness = action(true, "brightness attribute is present", "ha_state_attributes");
    } else {
      actions.set_brightness = action(null, "HA did not expose supported_color_modes or brightness", "unknown");
    }
  } else if (domain === "switch") {
    actions.turn_on = action(true, "HA switch domain supports turn_on", "ha_domain");
    actions.turn_off = action(true, "HA switch domain supports turn_off", "ha_domain");
  } else if (domain === "climate") {
    if (supportedFeatures !== null) {
      actions.turn_off = supportsFeature(supportedFeatures, 512, "TURN_OFF");
      actions.turn_on = supportsFeature(supportedFeatures, 1024, "TURN_ON");
      actions.set_temperature = supportsFeature(supportedFeatures, 1 | 2 | 128 | 256, "TARGET_TEMPERATURE");
      hasExplicitCapabilities = true;
    } else {
      actions.turn_on = action(null, "HA did not expose supported_features", "unknown");
      actions.turn_off = action(null, "HA did not expose supported_features", "unknown");
      const hasTemperatureBounds = Number.isFinite(attributes.min_temp ?? attributes.min_temperature)
        && Number.isFinite(attributes.max_temp ?? attributes.max_temperature);
      actions.set_temperature = action(
        hasTemperatureBounds ? true : null,
        hasTemperatureBounds ? "minimum and maximum temperature attributes are present" : "HA did not expose supported_features or temperature bounds",
        hasTemperatureBounds ? "ha_state_attributes" : "unknown",
      );
    }
  } else if (domain === "cover") {
    if (supportedFeatures !== null) {
      actions.open = supportsFeature(supportedFeatures, 1, "OPEN");
      actions.close = supportsFeature(supportedFeatures, 2, "CLOSE");
      actions.set_position = supportsFeature(supportedFeatures, 4, "SET_POSITION");
      hasExplicitCapabilities = true;
    } else {
      actions.open = action(null, "HA did not expose supported_features", "unknown");
      actions.close = action(null, "HA did not expose supported_features", "unknown");
      actions.set_position = action(null, "HA did not expose supported_features", "unknown");
    }
  } else if (domain === "lock") {
    actions.lock = action(true, "HA lock domain supports lock", "ha_domain");
    actions.unlock = action(true, "HA lock domain supports unlock", "ha_domain");
  }

  const hasPartialEvidence = Object.keys(actions).length > 0;
  return {
    source: "home_assistant_entity",
    status: hasExplicitCapabilities ? "observed" : hasPartialEvidence ? "inferred_or_unknown" : "no_actions",
    ...(supportedFeatures !== null ? { supported_features: supportedFeatures } : {}),
    ...(Array.isArray(attributes.supported_color_modes)
      ? { supported_color_modes: [...attributes.supported_color_modes] }
      : {}),
    ...(typeof attributes.device_class === "string" ? { device_class: attributes.device_class } : {}),
    ...(typeof attributes.entity_category === "string" ? { entity_category: attributes.entity_category } : {}),
    actions,
  };
}

export function getExplicitlyUnsupportedAction(capabilities, actionName) {
  const capability = capabilities?.actions?.[actionName];
  return capability?.supported === false ? capability : null;
}
