import { Type } from "typebox";

import { MockHomeAssistant } from "./mock-ha.js";

export const DEVICE_TOOL_DEFINITIONS = [
  {
    name: "list_devices",
    description: "列出家庭中的设备，可按设备类型过滤。",
    inputSchema: Type.Object(
      {
        domain: Type.Optional(
          Type.Union(
            [
              Type.Literal("light"),
              Type.Literal("climate"),
              Type.Literal("cover"),
              Type.Literal("lock"),
            ],
            { description: "可选的设备类型过滤条件。" },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  {
    name: "get_state",
    description: "查询一个设备的当前状态和属性。",
    inputSchema: Type.Object(
      {
        device_id: Type.String({ description: "Home Assistant 风格的设备实体 ID。" }),
      },
      { additionalProperties: false },
    ),
  },
  {
    name: "control_device",
    description: "控制设备。开锁等高风险操作需要 confirmed=true。",
    inputSchema: Type.Object(
      {
        device_id: Type.String(),
        action: Type.Union([
          Type.Literal("turn_on"),
          Type.Literal("turn_off"),
          Type.Literal("set_brightness"),
          Type.Literal("set_temperature"),
          Type.Literal("open"),
          Type.Literal("close"),
          Type.Literal("set_position"),
          Type.Literal("lock"),
          Type.Literal("unlock"),
        ]),
        parameters: Type.Optional(
          Type.Object(
            {},
            {
              description: "动作参数，例如 temperature、brightness 或 position。",
              additionalProperties: true,
            },
          ),
        ),
        confirmed: Type.Optional(
          Type.Boolean({
            default: false,
            description: "用户是否已经明确确认高风险操作。",
          }),
        ),
      },
      { additionalProperties: false },
    ),
  },
];

export function createDeviceTools(homeAssistant = new MockHomeAssistant()) {
  return {
    list_devices: (args = {}) => homeAssistant.listDevices(args),
    get_state: (args = {}) => homeAssistant.getState(args),
    control_device: (args = {}) => homeAssistant.controlDevice(args),
  };
}

export function createDeviceToolRuntime(homeAssistant = new MockHomeAssistant()) {
  const tools = createDeviceTools(homeAssistant);

  return {
    definitions: DEVICE_TOOL_DEFINITIONS,
    homeAssistant,
    invoke(toolName, args = {}) {
      const tool = tools[toolName];
      if (!tool) {
        return {
          success: false,
          error: {
            code: "TOOL_NOT_FOUND",
            message: `未知工具：${toolName}`,
          },
        };
      }
      return tool(args);
    },
  };
}
