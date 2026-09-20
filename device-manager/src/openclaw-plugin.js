import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

import { createDeviceToolRuntime, DEVICE_TOOL_DEFINITIONS } from "./tools.js";

const runtime = createDeviceToolRuntime();

export default defineToolPlugin({
  id: "device-manager",
  name: "家庭设备管家",
  description: "为家庭微脑提供 Home Assistant 设备发现、状态查询、安全控制和场景编排工具，支持 Mock 与真实 REST API 后端。",
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
