import { createDeviceToolRuntime } from "./tools.js";

const runtime = createDeviceToolRuntime();

function show(title, value) {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(value, null, 2));
}

show("1. 发现智能插座", runtime.invoke("list_devices", { domain: "switch" }));
show(
  "2. 查询统一设备视图（控制前）",
  runtime.invoke("get_state", { device_id: "switch.living_room_plug", canonical: true }),
);
show(
  "3. 打开智能插座",
  runtime.invoke("control_device", {
    device_id: "switch.living_room_plug",
    action: "turn_on",
  }),
);
show(
  "4. 控制后回读统一设备视图",
  runtime.invoke("get_state", { device_id: "switch.living_room_plug", canonical: true }),
);
show("5. 执行离家模式并逐项验证", runtime.invoke("run_scene", { scene_id: "away" }));
