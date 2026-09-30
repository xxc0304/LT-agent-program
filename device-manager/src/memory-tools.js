import { Type } from "typebox";

import { MEMORY_KEYS, PreferenceMemoryStore } from "../../agent-memory/src/memory-store.js";
import { createRoutineMemoryWorkflow } from "../../agent-memory/src/routine-workflow.js";

const MEMORY_TYPES = Object.values(MEMORY_KEYS).map((key) => Type.Literal(key));
const memoryTypeSchema = Type.Union(MEMORY_TYPES);
const routineMemoryTypeSchema = Type.Union([
  Type.Literal(MEMORY_KEYS.sleep_time),
  Type.Literal(MEMORY_KEYS.wake_time),
]);
const preferenceValueSchema = Type.Union([Type.Number(), Type.String()]);

export const HOUSEHOLD_MEMORY_TOOL_DEFINITIONS = [
  {
    name: "get_household_preference",
    description: "读取一条已由家庭成员明确确认的温度/作息偏好；未确认推测不会作为可用偏好返回。",
    inputSchema: Type.Object({
      memory_type: memoryTypeSchema,
      room_id: Type.Optional(Type.String()),
      day_type: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("weekday"), Type.Literal("weekend")])),
      subject_id: Type.Optional(Type.String()),
      time_zone: Type.Optional(Type.String({ description: "作息偏好的 IANA 时区，例如 Asia/Shanghai。" })),
    }, { additionalProperties: false }),
  },
  {
    name: "list_household_memories",
    description: "列出当前本地家庭偏好；默认只列出已确认记忆，用户询问待确认推测时才允许 include_pending=true。",
    inputSchema: Type.Object({
      memory_type: Type.Optional(memoryTypeSchema),
      subject_id: Type.Optional(Type.String()),
      include_pending: Type.Optional(Type.Boolean({ default: false })),
    }, { additionalProperties: false }),
  },
  {
    name: "remember_household_preference",
    description: "仅当用户明确要求长期记住某个舒适温度/睡觉时间/起床时间时保存；普通一次性指令不能保存。",
    inputSchema: Type.Object({
      memory_type: memoryTypeSchema,
      value: preferenceValueSchema,
      room_id: Type.Optional(Type.String()),
      day_type: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("weekday"), Type.Literal("weekend")])),
      subject_id: Type.Optional(Type.String()),
      time_zone: Type.Optional(Type.String({ description: "保存睡觉/起床时间时必填的家庭 IANA 时区。" })),
      expires_at: Type.Optional(Type.String({ format: "date-time" })),
      user_explicit_request: Type.Boolean({ description: "只有用户明确提出‘记住/以后默认/长期采用’时才可为 true。" }),
    }, { additionalProperties: false }),
  },
  {
    name: "propose_household_memory_candidate",
    description: "记录一条已获用户授权、由上游事件适配器提供的结构化睡觉/起床时间观察。只传事件 ID、发生时间、时区、时间值和置信度；不要从普通聊天、图片或单次设备状态推测。代码会按家庭时区计算日期并按 15 分钟归并；至少三个不同日期后才形成待确认候选，候选不能用于控制。",
    inputSchema: Type.Object({
      routine_type: routineMemoryTypeSchema,
      observed_time: Type.String({ pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$", description: "结构化事件给出的本地 24 小时制时间 HH:mm。" }),
      occurred_at: Type.String({ format: "date-time", description: "观察事件发生时间，必须带 Z 或明确时区偏移；本地日期由代码计算。" }),
      subject_id: Type.Optional(Type.String()),
      time_zone: Type.String({ description: "睡觉/起床时间候选必填的 IANA 时区，例如 Asia/Shanghai。" }),
      event_id: Type.String(),
      confidence: Type.Number({ minimum: 0, maximum: 1 }),
      consent_to_observe: Type.Boolean({ description: "必须来自用户对习惯观察的明确同意。" }),
    }, { additionalProperties: false }),
  },
  {
    name: "confirm_household_memory_candidate",
    description: "只有用户在看到具体候选内容后明确确认，才把该候选升为已确认偏好。",
    inputSchema: Type.Object({
      memory_id: Type.String(),
      user_confirmed: Type.Boolean({ description: "用户刚刚明确确认该候选时才可为 true。" }),
    }, { additionalProperties: false }),
  },
  {
    name: "preview_household_routine",
    description: "读取已经确认的睡觉/起床偏好，生成只读提醒建议；不会创建定时器或执行设备动作。",
    inputSchema: Type.Object({
      routine_type: routineMemoryTypeSchema,
      time_zone: Type.String({ description: "家庭 IANA 时区，例如 Asia/Shanghai。" }),
      day_type: Type.Optional(Type.Union([Type.Literal("weekday"), Type.Literal("weekend")])),
      subject_id: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
  },
  {
    name: "forget_household_memory",
    description: "按 memory_id 永久删除一条本地家庭偏好或待确认候选；用户要求忘记/删除时使用。",
    inputSchema: Type.Object({ memory_id: Type.String() }, { additionalProperties: false }),
  },
];

export function createHouseholdMemoryTools(store = new PreferenceMemoryStore()) {
  const routineWorkflow = createRoutineMemoryWorkflow({ store });
  return {
    get_household_preference: (args = {}) => store.getPreference(args),
    list_household_memories: (args = {}) => store.listMemories({
      includePending: args.include_pending === true,
      memory_type: args.memory_type,
      subject_id: args.subject_id,
    }),
    remember_household_preference: (args = {}) => store.saveExplicitPreference(args),
    propose_household_memory_candidate: (args = {}) => routineWorkflow.observe({
      event_type: "routine_observation",
      routine_type: args.routine_type,
      observed_time: args.observed_time,
      occurred_at: args.occurred_at,
      event_id: args.event_id,
      time_zone: args.time_zone,
      subject_id: args.subject_id,
      confidence: args.confidence,
      consent_to_observe: args.consent_to_observe,
    }),
    confirm_household_memory_candidate: (args = {}) => store.confirmCandidate(args.memory_id, args),
    preview_household_routine: (args = {}) => routineWorkflow.previewRoutine({
      routine_type: args.routine_type,
      time_zone: args.time_zone,
      day_type: args.day_type,
      subject_id: args.subject_id,
    }),
    forget_household_memory: (args = {}) => store.deleteMemory(args.memory_id),
  };
}
