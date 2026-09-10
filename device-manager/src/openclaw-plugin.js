import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

import { createDeviceToolRuntime, DEVICE_TOOL_DEFINITIONS } from "./tools.js";

const runtime = createDeviceToolRuntime();

export default defineToolPlugin({
  id: "device-manager",
  name: "家庭设备管家",
  description: "为家庭微脑提供 Mock Home Assistant 设备发现、状态查询和安全控制工具。",
  tools: (tool) =>
    DEVICE_TOOL_DEFINITIONS.map((definition) =>
      tool({
        name: definition.name,
        label: definition.name,
        description: definition.description,
        parameters: definition.inputSchema,
        async execute(params, _config, context) {
          context.signal?.throwIfAborted();
          return runtime.invoke(definition.name, params);
        },
      }),
    ),
});
