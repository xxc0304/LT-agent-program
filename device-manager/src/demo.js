import { createDeviceToolRuntime } from "./tools.js";

const runtime = createDeviceToolRuntime();

function show(title, result) {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(result, null, 2));
}

show("1. 获取设备列表", runtime.invoke("list_devices"));
show(
  "2. 打开客厅灯",
  runtime.invoke("control_device", {
    device_id: "light.living_room",
    action: "turn_on",
  }),
);
show(
  "3. 验证客厅灯状态",
  runtime.invoke("get_state", { device_id: "light.living_room" }),
);
show(
  "4. 执行回家场景并逐项验证",
  runtime.invoke("run_scene", { scene_id: "home" }),
);
show(
  "5. 未确认的开锁请求被拦截",
  runtime.invoke("control_device", {
    device_id: "lock.front_door",
    action: "unlock",
  }),
);
