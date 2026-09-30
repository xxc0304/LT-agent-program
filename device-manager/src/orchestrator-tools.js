import { Type } from "typebox";

export const ORCHESTRATOR_TOOL_DEFINITIONS = [
  {
    name: "dispatch_agent_event",
    label: "dispatch_agent_event",
    description:
      "将已完成标准化的家庭事件交给本地多 Agent 调度器；事件由节能 Agent 评估，合格任务再由设备管家执行并回读。视觉离位必须由节能 Agent 进程此前实际收到受信任运行时配置的独立 HA 占用事件佐证，否则不控制设备。只接受事件，不接受图片或 API Key。",
    inputSchema: Type.Object(
      {
        event: Type.Record(Type.String(), Type.Any(), {
          description:
            "标准 Event JSON。至少包含 event_id、event_type、occurred_at 和 payload；学习行为离位前应先路由同区域、近期的可信 HA 无人事件；不要在学习事件中伪造传感器证明，也不要放入图片、API Key 或其他认证信息。",
        }),
        auto_run: Type.Optional(
          Type.Boolean({
            default: true,
            description: "是否立即执行已规划的设备任务；默认 true。",
          }),
        ),
      },
      { additionalProperties: false },
    ),
  },
];
