export const SCENES = Object.freeze({
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
  away: {
    name: "离家模式",
    description: "关闭客厅灯、关闭客厅插座、关闭窗帘并关闭卧室空调。",
    steps: [
      { device_id: "light.living_room", action: "turn_off" },
      { device_id: "switch.living_room_plug", action: "turn_off" },
      { device_id: "cover.living_room_curtain", action: "close" },
      { device_id: "climate.bedroom", action: "turn_off" },
    ],
    expected: {
      "light.living_room": { state: "off", attributes: { brightness: 0 } },
      "switch.living_room_plug": { state: "off", attributes: { power_w: 0 } },
      "cover.living_room_curtain": { state: "closed", attributes: { position: 0 } },
      "climate.bedroom": { state: "off", attributes: { temperature: 26 } },
    },
  },
});

export function verifyExpectedState(device, expected) {
  return Boolean(
    device
      && device.state === expected.state
      && Object.entries(expected.attributes).every(([key, value]) => device.attributes?.[key] === value),
  );
}
