/**
 * Check the state that should be visible after a device action. Keeping this
 * separate from the HA adapter prevents a successful HTTP response from being
 * mistaken for a successful physical state change.
 */
export function isActionSatisfied(device, action, parameters = {}) {
  if (!device) return false;
  switch (device.domain) {
    case "light":
      if (action === "turn_on") return device.state === "on";
      if (action === "turn_off") return device.state === "off";
      if (action === "set_brightness") {
        return device.attributes?.brightness === parameters.brightness
          && device.state === (parameters.brightness === 0 ? "off" : "on");
      }
      return false;
    case "switch":
      if (action === "turn_on") return device.state === "on";
      if (action === "turn_off") return device.state === "off";
      return false;
    case "climate":
      if (action === "turn_on") return device.state === "on";
      if (action === "turn_off") return device.state === "off";
      if (action === "set_temperature") return device.attributes?.temperature === parameters.temperature;
      return false;
    case "cover":
      if (action === "open") return device.state === "open";
      if (action === "close") return device.state === "closed";
      if (action === "set_position") return device.attributes?.position === parameters.position;
      return false;
    case "lock":
      if (action === "lock") return device.state === "locked";
      if (action === "unlock") return device.state === "unlocked";
      return false;
    default:
      return false;
  }
}
