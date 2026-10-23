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
    description: "读取一条已确认的家庭温度、灯光亮度或作息偏好；未确认推测不会作为可用偏好返回。如果相关值存在 conflict_review，返回 status、候选值和作用范围；必须把冲突值告知用户并询问选择，不得沿用旧值或自行推断。",
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
    description: "列出当前本地家庭偏好；默认只列出已确认记忆。用户询问推测或冲突候选时才允许 include_pending=true，并应展示不同候选供用户判断。",
    inputSchema: Type.Object({
      memory_type: Type.Optional(memoryTypeSchema),
      subject_id: Type.Optional(Type.String()),
      include_pending: Type.Optional(Type.Boolean({ default: false })),
    }, { additionalProperties: false }),
  },
  {
    name: "remember_household_preference",
    description: "仅当用户明确要求长期记住某个舒适温度、灯光亮度、睡觉时间或起床时间时保存；普通一次性指令不能保存。",
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
    name: "get_household_observation_consent",
    description: "查看作息行为观察授权状态；默认关闭。只返回是否开启和更新时间，不读取或展示原始事件。",
    inputSchema: Type.Object({}, { additionalProperties: false }),
  },
  {
    name: "set_household_observation_consent",
    description: "只有用户当前明确说‘开始观察/学习我的作息’或‘停止观察/忘掉从行为推断的习惯’时调用。启用或撤回都必须把 user_explicit_confirmation 设为 true。撤回会删除观察推断的候选及已确认推断记忆，不会删除用户明确要求保存的偏好。",
    inputSchema: Type.Object({
      enabled: Type.Boolean(),
      user_explicit_confirmation: Type.Boolean(),
    }, { additionalProperties: false }),
  },
  {
    name: "get_household_device_action_observation_consent",
    description: "读取设备手动操作偏好学习授权状态。此授权独立于作息观察，默认关闭；不展示 HA 用户身份或原始事件。",
    inputSchema: Type.Object({}, { additionalProperties: false }),
  },
  {
    name: "set_household_device_action_observation_consent",
    description: "只有用户当前明确要求开始/停止从手动设备操作中学习偏好时调用。开启或撤回都必须设置 user_explicit_confirmation=true；撤回会删除设备操作推断的候选和已确认偏好，不影响其他记忆。",
    inputSchema: Type.Object({
      enabled: Type.Boolean(),
      user_explicit_confirmation: Type.Boolean(),
    }, { additionalProperties: false }),
  },
  {
    name: "get_household_routine_reminder_consent",
    description: "查看已确认作息提醒的单独授权状态；默认关闭，不读取或展示作息时间。",
    inputSchema: Type.Object({}, { additionalProperties: false }),
  },
  {
    name: "set_household_routine_reminder_consent",
    description: "只有用户当前明确要求开启/停止作息提醒时调用。该授权与作息观察授权分开；保存授权本身不会启动周期检查，也不会发送外部推送。用户另行要求启动后，还需本机功能开关和时区配置；提醒仅写入 OpenClaw 本地收件箱供查看。",
    inputSchema: Type.Object({
      enabled: Type.Boolean(),
      user_explicit_confirmation: Type.Boolean(),
    }, { additionalProperties: false }),
  },
  {
    name: "confirm_household_memory_candidate",
    description: "只有用户看见具体候选后明确选择，才把它升为已确认偏好。若候选 status 为 conflict_review，必须先展示冲突候选和值，不能替用户选择；用户选定后会一并清理同范围的其他冲突候选。",
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

export function createHouseholdMemoryTools(store = new PreferenceMemoryStore(), {
  onDeviceActionObservationConsentChanged = () => {},
} = {}) {
  const routineWorkflow = createRoutineMemoryWorkflow({ store });
  return {
    get_household_preference: (args = {}) => store.getPreference(args),
    list_household_memories: (args = {}) => store.listMemories({
      includePending: args.include_pending === true,
      memory_type: args.memory_type,
      subject_id: args.subject_id,
    }),
    remember_household_preference: (args = {}) => store.saveExplicitPreference(args),
    get_household_observation_consent: () => store.getObservationConsent(),
    set_household_observation_consent: (args = {}) => store.setObservationConsent(args),
    get_household_device_action_observation_consent: () => store.getDeviceActionObservationConsent(),
    get_household_routine_reminder_consent: () => store.getRoutineReminderConsent(),
    set_household_routine_reminder_consent: (args = {}) => store.setRoutineReminderConsent(args),
    async set_household_device_action_observation_consent(args = {}) {
      const result = await store.setDeviceActionObservationConsent(args);
      if (result.success === true) {
        try { onDeviceActionObservationConsentChanged(result.enabled); } catch {
          return { ...result, monitor_update_warning: "本次授权已保存；监测器订阅状态将在下次启动时重新读取。" };
        }
      }
      return result;
    },
    // Kept as a library method for a future authenticated event adapter. It is
    // intentionally absent from HOUSEHOLD_MEMORY_TOOL_DEFINITIONS so the LLM
    // cannot invent event IDs, timestamps, or behavior evidence.
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
