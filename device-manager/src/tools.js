import { Type } from "typebox";

import { createHomeAssistantBackend } from "./backend.js";

export const DEVICE_TOOL_DEFINITIONS = [
  {
    name: "list_devices",
    description: "列出家庭中的设备，可按设备类型过滤；需要跨 Agent 交接时可请求 canonical=true 返回统一设备视图。",
    inputSchema: Type.Object(
      {
        domain: Type.Optional(
          Type.Union(
            [
              Type.Literal("light"),
              Type.Literal("switch"),
              Type.Literal("climate"),
              Type.Literal("cover"),
              Type.Literal("lock"),
              Type.Literal("sensor"),
              Type.Literal("binary_sensor"),
            ],
            { description: "可选的设备类型过滤条件。" },
          ),
        ),
        canonical: Type.Optional(Type.Boolean({ description: "是否返回统一设备模型视图。" })),
      },
      { additionalProperties: false },
    ),
  },
  {
    name: "get_state",
    description: "查询一个设备的当前状态和属性；需要跨 Agent 交接时可请求 canonical=true 返回统一设备视图。",
    inputSchema: Type.Object(
      {
        device_id: Type.String({ description: "Home Assistant 风格的设备实体 ID。" }),
        canonical: Type.Optional(Type.Boolean({ description: "是否返回统一设备模型视图。" })),
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
        task_id: Type.Optional(Type.String({ description: "可选的标准 Task ID，用于审计关联。" })),
        trace_id: Type.Optional(Type.String({ description: "可选的全链路追踪 ID。" })),
        idempotency_key: Type.Optional(Type.String({ description: "可选的幂等键，防止重复控制。" })),
      },
      { additionalProperties: false },
    ),
  },
  {
    name: "run_scene",
    description: "固定参数场景执行器。面向用户的场景请求必须先调用 plan_scene 展示计划，并在用户后续原样确认后调用 execute_scene_plan；不要用 run_scene 绕过确认或执行个性化温度。",
    inputSchema: Type.Object(
      {
        scene_id: Type.Union([
          Type.Literal("home", { description: "回家模式：开灯、开窗帘、开空调至 26℃。" }),
          Type.Literal("sleep", { description: "睡眠模式：关灯、关窗帘、开空调至 26℃。" }),
          Type.Literal("away", { description: "离家模式：关闭灯、插座、窗帘和卧室空调。" }),
        ]),
      },
      { additionalProperties: false },
    ),
  },
  {
    name: "diagnose_device",
    description: "诊断指定设备或全部设备的在线状态、状态属性一致性，并返回证据和处理建议。该工具只读，不会控制设备。",
    inputSchema: Type.Object(
      {
        device_id: Type.Optional(Type.String({ description: "可选的设备实体 ID；不填写时诊断全部设备。" })),
        trace_id: Type.Optional(Type.String({ description: "可选的全链路追踪 ID。" })),
      },
      { additionalProperties: false },
    ),
  },
  {
    name: "get_device_events",
    description: "查询设备管家产生的标准设备事件和动作审计事件。",
    inputSchema: Type.Object(
      {
        device_id: Type.Optional(Type.String({ description: "可选的设备实体 ID。" })),
        event_type: Type.Optional(Type.String({ description: "可选的事件类型，例如 action_executed 或 diagnostic_alert。" })),
        trace_id: Type.Optional(Type.String({ description: "可选的全链路追踪 ID。" })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "最多返回的事件数量，默认 50。" })),
      },
      { additionalProperties: false },
    ),
  },
];

export function createDeviceTools(homeAssistant = createHomeAssistantBackend()) {
  return {
    list_devices: (args = {}) => homeAssistant.listDevices(args),
    get_state: (args = {}) => homeAssistant.getState(args),
    control_device: (args = {}) => homeAssistant.controlDevice(args),
    run_scene: (args = {}) => homeAssistant.runScene(args),
    diagnose_device: (args = {}) => homeAssistant.diagnoseDevice(args),
    get_device_events: (args = {}) => ({
      success: true,
      events: homeAssistant.getEvents(args),
    }),
  };
}

export function createDeviceToolRuntime(homeAssistant = createHomeAssistantBackend()) {
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
