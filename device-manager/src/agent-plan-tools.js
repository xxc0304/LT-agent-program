import { randomUUID } from "node:crypto";
import { Type } from "typebox";

import { EnergySavingAgent } from "../../energy-saving/src/energy-agent.js";
import { LearningCompanionAgent } from "../../multi-agent-orchestrator/src/learning-agent.js";
import { AgentPlanExecutor } from "../../multi-agent-orchestrator/src/plan-executor.js";
import { AgentPlanValidator, fingerprintAgentPlan } from "../../multi-agent-orchestrator/src/plan-validator.js";
import { AgentPlanWorkflow } from "../../multi-agent-orchestrator/src/plan-workflow.js";
import { getDeviceActionConfirmationPolicy } from "./action-confirmation-policy.js";

const PLAN_SCHEMA_VERSION = "0.1";
const EVIDENCE_MAX_AGE_MS = 5_000;
const APPROVAL_TTL_MS = 5 * 60_000;
const RECONCILIATION_CHECK_TTL_MS = 2 * 60_000;

const ACTIONS_BY_DOMAIN = Object.freeze({
  light: ["turn_on", "turn_off", "set_brightness"],
  switch: ["turn_on", "turn_off"],
  climate: ["turn_on", "turn_off", "set_temperature"],
  cover: ["open", "close", "set_position"],
  lock: ["lock", "unlock"],
});

const TRUSTED_ENERGY_EVENT_TYPES = new Set([
  "occupancy_changed",
  "home_mode_changed",
  "learning_behavior",
]);

const PLAN_AGENT_IDS = ["learning-companion", "energy-saving", "device-manager"];
const PLAN_CAPABILITIES = [
  "normalize_learning_event",
  "plan_event",
  "read_device_state",
  "execute_device_action",
];
const PLAN_ACTION_NAMES = [...new Set(Object.values(ACTIONS_BY_DOMAIN).flat())];

const AgentPlanActionSchema = Type.Object({
  name: Type.Union(PLAN_ACTION_NAMES.map((name) => Type.Literal(name)), {
    description: "规范动作名；必须与目标设备 domain 支持的动作匹配。",
  }),
  target_ref: Type.Object({
    device_id: Type.String({ minLength: 1, description: "必须来自运行时返回的已登记设备清单。" }),
  }, { additionalProperties: false }),
  parameters: Type.Optional(Type.Record(Type.String(), Type.Any(), {
    description: "动作参数对象；例如 set_temperature 使用 temperature，set_brightness 使用 brightness。",
  })),
}, { additionalProperties: false });

const AgentPlanStepSchema = Type.Object({
  step_id: Type.String({ minLength: 1 }),
  agent_id: Type.Union(PLAN_AGENT_IDS.map((agentId) => Type.Literal(agentId))),
  capability: Type.Union(PLAN_CAPABILITIES.map((capability) => Type.Literal(capability))),
  depends_on: Type.Optional(Type.Array(Type.String({ minLength: 1 })), {
    description: "前置步骤 ID；没有依赖时省略或传空数组。",
  }),
  input: Type.Optional(Type.Record(Type.String(), Type.Any(), {
    description: "该能力的输入对象：learning-companion 输入 observation；energy-saving 输入 event；read_device_state 输入 device_id。",
  })),
  action: Type.Optional(AgentPlanActionSchema),
}, { additionalProperties: false });

const AgentPlanSchema = Type.Object({
  schema_version: Type.Literal(PLAN_SCHEMA_VERSION),
  plan_id: Type.String({ minLength: 1 }),
  trace_id: Type.String({ minLength: 1 }),
  goal: Type.String({ minLength: 1 }),
  steps: Type.Array(AgentPlanStepSchema, {
    minItems: 1,
    maxItems: 12,
    description: "按实际依赖关系拆分的步骤；设备动作放在对应 step.action 中。",
  }),
}, { additionalProperties: false });

function clone(value) {
  return structuredClone(value);
}

function planSubmissionFingerprint(plan) {
  const semanticPlan = clone(plan);
  delete semanticPlan.plan_id;
  delete semanticPlan.trace_id;
  for (const step of semanticPlan.steps ?? []) {
    if (step && typeof step === "object") delete step.evidence_refs;
  }
  return fingerprintAgentPlan({
    ...semanticPlan,
    plan_id: "idempotency-plan",
    trace_id: "idempotency-trace",
  });
}

function failure(code, message, details = {}) {
  return {
    success: false,
    decision: "DENY",
    workflow_status: "DENIED",
    execution_performed: false,
    error: { code, message, ...details },
  };
}

function deviceActionFromTask(task) {
  const deviceId = task?.target_ref?.device_id;
  const action = task?.action;
  if (typeof deviceId !== "string" || !deviceId || typeof action !== "string" || !action) return null;
  return {
    name: action,
    target_ref: { device_id: deviceId },
    parameters: clone(task.parameters ?? {}),
  };
}

function canAutoRunEnergyTask(task, device, trustedEventSource) {
  return trustedEventSource === true
    && task?.source_agent === "energy-saving"
    && task?.action === "turn_off"
    && device?.domain === "light"
    && TRUSTED_ENERGY_EVENT_TYPES.has(task?.metadata?.trigger_event_type)
    && ["AREA_UNOCCUPIED", "HOME_AWAY"].includes(task?.metadata?.reason_code)
    && (task.metadata.trigger_event_type !== "learning_behavior"
      || typeof task.metadata.corroborating_occupancy_event_id === "string");
}

function actionAllowedForDomain(device, action) {
  return (ACTIONS_BY_DOMAIN[device?.domain] ?? []).includes(action);
}

function statusForDeviceResult(result) {
  if (result?.success === true) return "SUCCEEDED";
  return result?.error?.code === "POLICY_DENIED" ? "DENIED" : "FAILED";
}

const ACTION_LABELS = Object.freeze({
  turn_on: "打开",
  turn_off: "关闭",
  lock: "上锁",
  unlock: "解锁",
  open: "打开",
  close: "关闭",
  set_brightness: "调节亮度",
  set_position: "设置位置",
  set_temperature: "调节温度",
});

function describeAction(action) {
  const name = action?.name ?? action?.action;
  const parameters = action?.parameters ?? {};
  if (name === "set_temperature" && Number.isFinite(parameters.temperature)) {
    return `将温度调至 ${parameters.temperature}°C`;
  }
  if (name === "set_brightness" && Number.isFinite(parameters.brightness)) {
    return `将亮度调至 ${parameters.brightness}%`;
  }
  if (name === "set_position" && Number.isFinite(parameters.position)) {
    return `将位置调至 ${parameters.position}%`;
  }
  return ACTION_LABELS[name] ?? name ?? "未命名动作";
}

function describeConflictForUser(result, plan, inventory) {
  if (result?.workflow_status !== "CLARIFICATION_REQUIRED") return result;

  const stepsById = new Map((plan.steps ?? []).map((step) => [step.step_id, step]));
  const devicesById = new Map(inventory.devices.map((device) => [device.device_id, device]));
  const conflicts = (result.clarification?.conflicts ?? []).map((conflict) => {
    const device = devicesById.get(conflict.resource_id);
    const actions = (conflict.step_ids ?? []).map((stepId) => {
      const step = stepsById.get(stepId);
      const action = step?.action;
      return {
        step_id: stepId,
        agent_id: step?.agent_id ?? null,
        action: action?.name ?? action?.action ?? null,
        action_label: describeAction(action),
        parameters: clone(action?.parameters ?? {}),
      };
    });
    const labels = [...new Set(actions.map((action) => action.action_label))];
    return {
      resource_id: conflict.resource_id,
      device_name: device?.name ?? conflict.resource_id,
      conflict_group: conflict.conflict_group,
      actions,
      message: `“${device?.name ?? conflict.resource_id}”同时收到${labels.join("和")}两个没有先后顺序的动作。`,
    };
  });

  const summaries = conflicts.map((conflict) => conflict.message);
  return {
    ...result,
    clarification: {
      ...result.clarification,
      conflicts,
      user_question: `${summaries.join(" ")}你希望只保留哪项，还是明确它们的先后顺序？当前冲突计划不会执行；收到答复后需要重新规划和校验。`,
      approval_allowed: false,
      execution_performed: false,
    },
  };
}

function collectAncestorStepIds(stepId, planSteps, seen = new Set()) {
  const step = planSteps.get(stepId);
  for (const dependencyId of step?.depends_on ?? []) {
    if (seen.has(dependencyId)) continue;
    seen.add(dependencyId);
    collectAncestorStepIds(dependencyId, planSteps, seen);
  }
  return seen;
}

function collectEnergyTasks(step, planSteps, dependencyResults) {
  const ancestorIds = collectAncestorStepIds(step.step_id, planSteps);
  const tasks = [];
  for (const ancestorId of ancestorIds) {
    if (planSteps.get(ancestorId)?.agent_id !== "energy-saving") continue;
    const result = dependencyResults[ancestorId];
    if (Array.isArray(result?.tasks)) tasks.push(...result.tasks);
  }
  return tasks;
}

export const AGENT_PLAN_TOOL_DEFINITIONS = [
  {
    name: "submit_agent_plan",
    label: "submit_agent_plan",
    description:
      "把复杂、跨 Agent、场景或多设备请求转成 schema_version 0.1 候选计划交给 Node.js 安全校验与编排执行。计划必须严格使用 plan.steps[].{step_id,agent_id,capability,depends_on,input,action} 结构；设备写操作放在 step.action，形如 {name,target_ref:{device_id},parameters}。不要把动作放在 step 顶层，也不要自行填写 evidence_refs/evidence_id：插件会从已登记设备清单和当前运行时状态自动采集可信证据。仅使用已登记的 learning-companion.normalize_learning_event、energy-saving.plan_event、device-manager.read_device_state、device-manager.execute_device_action 能力；候选计划中的所有设备写操作都需要用户确认。对于目标和动作明确的单设备即时指令，使用 control_device 直控；门锁和被标记为高风险的设备仍需确认。计划中的事件来源默认不可信，不能把模型描述伪装成传感器证据。目标或动作不明确时先追问；低置信度、证据缺失或过期时不动作；同一设备有冲突动作时工具会返回 CLARIFICATION_REQUIRED，不会提供批准入口，必须先询问用户并重新规划。",
    inputSchema: Type.Object({
      plan: AgentPlanSchema,
    }, { additionalProperties: false }),
  },
  {
    name: "resolve_agent_action_confirmation",
    label: "resolve_agent_action_confirmation",
    description:
      "处理待确认的设备动作/多 Agent 计划。只有用户在看到具体设备、动作和计划后，于后续独立消息明确同意时才选 approve；明确拒绝选 reject；用户提问、犹豫、没回应或上下文不清选 defer。approval_id 是工具内部值，绝不要要求用户输入。确认后系统会刷新设备状态和证据并重新校验；不能绕过策略硬限制。此确认信号由 OpenClaw 根据对话解释，不是强身份认证。重启恢复出的旧项不能 approve；EXECUTION_UNCERTAIN 项即使 reject 也不会清除。先用 check_state 单独读取并向用户展示相关设备现状，必须等待用户后续明确要求关闭后才能选 reconciled；系统关闭前还会重新读取，状态变化、设备不可读或离线都会继续保持阻止并要求重新展示。关闭记录不执行或撤销设备动作，也不证明此前动作未发生。",
    inputSchema: Type.Object({
      approval_id: Type.String({ description: "从此前工具结果读取，不向用户索取。" }),
      decision: Type.Union([
        Type.Literal("approve"),
        Type.Literal("reject"),
        Type.Literal("defer"),
        Type.Literal("check_state"),
        Type.Literal("reconciled"),
      ], { description: "仅根据用户对当前已展示方案的后续明确答复选择。EXECUTION_UNCERTAIN 时先选 check_state；将返回只读设备状态且保持阻止。必须先把状态告诉用户并等待后续明确的关闭请求，再选 reconciled；系统关闭前会再次读取，状态变化、设备不可读或离线都会继续阻止。" }),
    }, { additionalProperties: false }),
  },
  {
    name: "list_pending_agent_action_confirmations",
    label: "list_pending_agent_action_confirmations",
    description:
      "列出待确认的设备动作/Agent 计划。重启前遗留项只会显示为需重新规划或执行结果不确定，绝不会恢复成可批准动作；不要自行批准。如果存在多个待确认项，先向用户说明差异并问清楚要处理哪一个。",
    inputSchema: Type.Object({}, { additionalProperties: false }),
  },
];

/**
 * Creates OpenClaw-facing tools around the existing local Agents and device
 * runtime. All submitted plans receive a fresh device inventory snapshot.
 * Candidate plans require confirmation for writes. Clear single-device
 * actions may bypass a second prompt unless the target is a lock or explicitly
 * marked high risk. Only trusted in-process energy events may auto-run a
 * qualified light-off task.
 */
export function createAgentPlanTools({
  deviceRuntime,
  deviceTaskRuntime,
  energyAgent,
  approvalStateStore = null,
  clock = () => Date.now(),
  createId = randomUUID,
  approvalTtlMs = APPROVAL_TTL_MS,
} = {}) {
  if (!deviceRuntime || typeof deviceRuntime.invoke !== "function") {
    throw new Error("Agent plan tools 需要可调用 invoke() 的设备运行时");
  }
  if (!deviceTaskRuntime || typeof deviceTaskRuntime.execute !== "function") {
    throw new Error("Agent plan tools 需要设备管家 Task runtime");
  }
  if (!energyAgent || typeof energyAgent.handleEvent !== "function") {
    throw new Error("Agent plan tools 需要已注册的 EnergySavingAgent 实例");
  }

  const learningAgent = new LearningCompanionAgent();
  const pendingWorkflows = new Map();
  const recoveredApprovals = new Map();
  const reconciliationSnapshots = new Map();
  const planSubmissionsById = new Map();
  const planSubmissionsByFingerprint = new Map();

  function recoveryView(record) {
    const uncertain = record.status === "EXECUTION_UNCERTAIN";
    return {
      approval_id: record.approval_id,
      workflow_status: record.status,
      plan_id: record.plan_id,
      plan_fingerprint: record.plan_fingerprint,
      created_at: new Date(record.created_at_ms).toISOString(),
      expires_at: new Date(record.expires_at_ms).toISOString(),
      steps: clone(record.steps),
      recovery_required: true,
      ...(uncertain ? { execution_uncertain: true } : { execution_performed: false }),
      message: uncertain
        ? "上次进程在设备执行窗口中断，结果可能已部分生效。系统不会自动重放；请先核对设备当前状态，再由用户发起新计划。"
        : "此确认项来自重启前的进程，系统不会恢复批准权限。请刷新设备状态并重新规划；旧确认项不能执行。",
    };
  }

  function recoveredResult(record) {
    const approval = recoveryView(record);
    return {
      workflow_status: record.status,
      decision: record.status === "EXECUTION_UNCERTAIN" ? "REVIEW_REQUIRED" : "NEED_CONFIRMATION",
      approval,
      execution_performed: record.status === "RECOVERY_REQUIRED" ? false : undefined,
      execution_uncertain: record.status === "EXECUTION_UNCERTAIN",
      message: approval.message,
    };
  }

  function loadPersistedIdempotencyState() {
    if (!approvalStateStore || typeof approvalStateStore.list !== "function") return;
    for (const record of approvalStateStore.list()) {
      if (record.status === "REJECTED" || record.status === "EXPIRED_NO_ACTION"
        || record.status === "DENIED_AFTER_RECHECK" || record.status === "PLAN_REVISION_REQUIRED") continue;
      if (!new Set(["RECOVERY_REQUIRED", "EXECUTION_UNCERTAIN", "COMPLETED", "EXECUTION_FAILED"]).has(record.status)) continue;

      const normalizedStatus = record.status === "EXECUTION_FAILED" ? "EXECUTION_UNCERTAIN" : record.status;
      const safeRecord = { ...record, status: normalizedStatus };
      const result = normalizedStatus === "COMPLETED"
        ? { workflow_status: "COMPLETED", execution_performed: true, idempotency: { deduplicated: true, message: "该计划已在此前完成；为避免重复设备动作，本次复用完成状态。" } }
        : recoveredResult(safeRecord);
      const submission = {
        planId: record.plan_id,
        planIds: new Set([record.plan_id]),
        fingerprint: record.plan_fingerprint,
        inFlight: false,
        promise: null,
        result,
        approvalId: record.approval_id,
        expiresAt: normalizedStatus === "EXECUTION_UNCERTAIN"
          ? Number.MAX_SAFE_INTEGER
          : record.idempotency_expires_at_ms,
        recovered: true,
      };
      if (normalizedStatus !== "COMPLETED") recoveredApprovals.set(record.approval_id, { record: safeRecord, result });
      planSubmissionsById.set(record.plan_id, submission);
      planSubmissionsByFingerprint.set(record.plan_fingerprint, submission);
    }
  }

  loadPersistedIdempotencyState();

  function releasePlanSubmission(submission) {
    if (!submission) return;
    for (const planId of submission.planIds) {
      if (planSubmissionsById.get(planId) === submission) planSubmissionsById.delete(planId);
    }
    if (planSubmissionsByFingerprint.get(submission.fingerprint) === submission) {
      planSubmissionsByFingerprint.delete(submission.fingerprint);
    }
  }

  function pruneExpiredPlanSubmissions() {
    for (const [approvalId, snapshot] of reconciliationSnapshots) {
      if (clock() - snapshot.checked_at_ms > RECONCILIATION_CHECK_TTL_MS) {
        reconciliationSnapshots.delete(approvalId);
      }
    }
    for (const submission of new Set(planSubmissionsByFingerprint.values())) {
      if (submission.inFlight) continue;
      if (submission.finalized && submission.expiresAt > clock()) continue;
      if (submission.recovered) {
        if (submission.expiresAt <= clock()) {
          releasePlanSubmission(submission);
          recoveredApprovals.delete(submission.approvalId);
          try { approvalStateStore?.remove?.(submission.approvalId); } catch {}
        }
        continue;
      }
      if (!submission.approvalId) {
        releasePlanSubmission(submission);
        continue;
      }
      const pending = pendingWorkflows.get(submission.approvalId);
      const view = pending?.workflow.getApproval(submission.approvalId);
      if (view?.workflow_status !== "WAITING_FOR_APPROVAL") {
        pendingWorkflows.delete(submission.approvalId);
        releasePlanSubmission(submission);
        try { approvalStateStore?.remove?.(submission.approvalId); } catch {}
      }
    }
  }

  async function reusePlanSubmission(submission, submittedPlanId) {
    const result = submission.result ?? await submission.promise;
    if (!result) return failure("PLAN_SUBMISSION_IN_PROGRESS", "相同计划正在校验，请稍后查询待确认项");
    return {
      ...clone(result),
      idempotency: {
        deduplicated: true,
        submitted_plan_id: submittedPlanId,
        original_plan_id: submission.planId,
        message: "检测到相同候选计划仍在处理中或待确认；已复用原结果，没有新建待确认项。",
      },
    };
  }

  async function invoke(toolName, args) {
    try {
      return await deviceRuntime.invoke(toolName, args);
    } catch (error) {
      return { success: false, error: { code: "DEVICE_RUNTIME_ERROR", message: error instanceof Error ? error.message : String(error) } };
    }
  }

  async function readRecoveredActionDeviceStates(record) {
    const actionsByDevice = new Map();
    for (const step of record.steps ?? []) {
      const deviceId = step?.action?.target_ref?.device_id;
      if (typeof deviceId !== "string" || !deviceId) continue;
      const actions = actionsByDevice.get(deviceId) ?? new Set();
      if (typeof step.action.name === "string") actions.add(step.action.name);
      actionsByDevice.set(deviceId, actions);
    }
    if (actionsByDevice.size === 0) {
      return {
        success: false,
        devices: [],
        error_code: "RECOVERY_TARGET_MISSING",
      };
    }

    const devices = [];
    for (const [deviceId, actions] of actionsByDevice) {
      const result = await invoke("get_state", { device_id: deviceId });
      const device = result?.device;
      if (!result?.success || !device || device.available !== true) {
        const rawCode = result?.error?.code;
        const errorCode = typeof rawCode === "string" && /^[A-Z0-9_]{1,80}$/.test(rawCode)
          ? rawCode
          : "DEVICE_STATE_UNAVAILABLE";
        return { success: false, devices, error_code: errorCode };
      }

      const snapshot = {
        device_id: deviceId,
        domain: typeof device.domain === "string" ? device.domain : "unknown",
        available: true,
        state: typeof device.state === "string" ? device.state.slice(0, 80) : "unknown",
        affected_actions: [...actions],
      };
      const attributes = device.attributes && typeof device.attributes === "object"
        ? device.attributes
        : {};
      const relevantAttribute = actions.has("set_temperature")
        ? "temperature"
        : actions.has("set_brightness")
          ? "brightness"
          : actions.has("set_position")
            ? "current_position"
            : null;
      if (relevantAttribute && Number.isFinite(attributes[relevantAttribute])) {
        snapshot[relevantAttribute] = attributes[relevantAttribute];
      } else if (relevantAttribute === "current_position" && Number.isFinite(attributes.position)) {
        snapshot.current_position = attributes.position;
      }
      devices.push(snapshot);
    }
    return { success: true, devices, checked_at_ms: clock() };
  }

  async function readInventory() {
    const result = await invoke("list_devices", {});
    if (!result?.success || !Array.isArray(result.devices)) {
      return { success: false, error: result?.error ?? { code: "DEVICE_INVENTORY_UNAVAILABLE", message: "无法读取当前设备清单" } };
    }
    return { success: true, devices: result.devices };
  }

  async function createDeviceEvidence(deviceId) {
    const state = await invoke("get_state", { device_id: deviceId });
    if (!state?.success || !state.device?.available) return null;
    const observedAt = clock();
    return {
      evidence_id: `device-state:${deviceId}`,
      evidence_type: "device_state",
      trust_level: "trusted",
      source_type: "device_manager_runtime",
      source_id: deviceId,
      observed_at: new Date(observedAt).toISOString(),
      expires_at: new Date(observedAt + EVIDENCE_MAX_AGE_MS).toISOString(),
      device_id: deviceId,
      domain: state.device.domain,
      state: state.device.state,
      available: state.device.available,
    };
  }

  async function evidenceForPlan(plan) {
    const deviceIds = [...new Set((Array.isArray(plan?.steps) ? plan.steps : [])
      .map((step) => step?.action?.target_ref?.device_id ?? step?.action?.resource_id)
      .filter((deviceId) => typeof deviceId === "string"))];
    const evidence = [];
    for (const deviceId of deviceIds) {
      const item = await createDeviceEvidence(deviceId);
      if (item) evidence.push(item);
    }
    return evidence;
  }

  function makeValidator(inventory, autoAllowedDeviceActions = []) {
    const allowedActions = [...new Set(inventory.devices.flatMap((device) => ACTIONS_BY_DOMAIN[device.domain] ?? []))];
    return new AgentPlanValidator({
      clock,
      maxSteps: 12,
      agents: [
        {
          agent_id: "learning-companion",
          capabilities: {
            normalize_learning_event: { effect: "planning" },
          },
        },
        {
          agent_id: "energy-saving",
          capabilities: {
            plan_event: { effect: "planning" },
          },
        },
        {
          agent_id: "device-manager",
          capabilities: {
            read_device_state: { effect: "read_only" },
            execute_device_action: {
              effect: "device_action",
              required_evidence: [{
                evidence_type: "device_state",
                trusted: true,
                allowed_sources: ["device_manager_runtime"],
                max_age_ms: EVIDENCE_MAX_AGE_MS,
              }],
              auto_allowed_device_actions: clone(autoAllowedDeviceActions),
            },
          },
        },
      ],
      householdPolicy: {
        allowedDeviceIds: inventory.devices.map((device) => device.device_id),
        allowedActions,
        autoAllowedDeviceActions: [],
      },
    });
  }

  function makeHandlers(plan) {
    const planSteps = new Map((plan.steps ?? []).map((step) => [step.step_id, step]));
    // Candidate plans originate in conversation. Evaluate their events with an
    // isolated planner instance so they cannot mutate the operational Energy
    // Agent's trusted occupancy cache, manual holds, cooldowns, or event IDs.
    const candidateEnergyAgent = new EnergySavingAgent({
      config: energyAgent.config,
      deviceClient: energyAgent.deviceClient,
      clock,
    });
    return {
      "learning-companion::normalize_learning_event": async ({ input }) => {
        try {
          const event = learningAgent.toEvent(input.observation, {
            event_id: input.event_id ?? `evt-learning-${createId()}`,
            trace_id: plan.trace_id,
            area: input.area,
            occurred_at: input.occurred_at,
            duration_ms: 0,
            needs_review: true,
          });
          return { result: { event, note: "由对话整理的观察默认 needs_review=true，不作为独立传感器证据。" } };
        } catch (error) {
          return { status: "DENIED", error: { code: "LEARNING_EVENT_INVALID", message: error instanceof Error ? error.message : String(error) } };
        }
      },
      "energy-saving::plan_event": async ({ input }) => {
        const candidateEvent = input?.event;
        if (!candidateEvent || typeof candidateEvent !== "object" || Array.isArray(candidateEvent)) {
          return { status: "DENIED", error: { code: "INVALID_EVENT", message: "energy-saving.plan_event 需要标准 Event 对象" } };
        }
        const result = await candidateEnergyAgent.handleEvent({
          ...clone(candidateEvent),
          // A plan submitted by the language model is never an authenticated
          // sensor event, even when it claims to come from a trusted adapter.
          source_agent: "openclaw-unverified-input",
        });
        return { result };
      },
      "device-manager::read_device_state": async ({ input }) => {
        const result = await invoke("get_state", { device_id: input.device_id });
        return result?.success ? { result } : {
          status: "FAILED",
          error: result?.error ?? { code: "DEVICE_STATE_UNAVAILABLE", message: "无法读取设备状态" },
        };
      },
      "device-manager::execute_device_action": async ({ plan_id, trace_id, step_id, input, action, dependency_results }) => {
        const state = await invoke("get_state", { device_id: action?.target_ref?.device_id });
        if (!state?.success || !state.device?.available) {
          return { status: "DENIED", error: state?.error ?? { code: "DEVICE_UNAVAILABLE", message: "设备当前不可用" } };
        }
        if (!actionAllowedForDomain(state.device, action.name)) {
          return { status: "DENIED", error: { code: "ACTION_DOMAIN_MISMATCH", message: `${state.device.domain} 不支持动作 ${action.name}` } };
        }

        const step = planSteps.get(step_id);
        const energyTasks = collectEnergyTasks(step, planSteps, dependency_results ?? {});
        if (input?.energy_task) energyTasks.push(input.energy_task);
        const hasEnergyAncestor = [...collectAncestorStepIds(step_id, planSteps)]
          .some((ancestorId) => planSteps.get(ancestorId)?.agent_id === "energy-saving")
          || Boolean(input?.energy_task);
        if (hasEnergyAncestor) {
          const matchingTask = energyTasks.find((task) =>
            task?.target_ref?.device_id === action.target_ref.device_id
            && task.action === action.name
            && JSON.stringify(task.parameters ?? {}) === JSON.stringify(action.parameters ?? {}));
          if (!matchingTask) {
            return { status: "DENIED", error: { code: "ENERGY_PLAN_ACTION_MISMATCH", message: "设备动作必须与节能 Agent 实际生成的任务完全一致" } };
          }
          const receipt = await deviceTaskRuntime.execute({
            ...clone(matchingTask),
            policy_decision: {
              decision: "ALLOW",
              decision_id: plan_id,
              reason_message: "设备动作已通过计划校验与必要确认",
            },
          });
          return receipt?.status === "SUCCEEDED"
            ? { result: { task_receipt: receipt } }
            : { status: receipt?.status === "DENIED" ? "DENIED" : "FAILED", error: receipt?.error ?? { code: "ENERGY_TASK_FAILED", message: "设备管家未能完成节能任务" } };
        }

        const result = await invoke("control_device", {
          device_id: action.target_ref.device_id,
          action: action.name,
          parameters: action.parameters ?? {},
          confirmed: true,
          task_id: `${plan_id}:${step_id}`,
          trace_id,
        });
        return result?.success
          ? { result }
          : { status: statusForDeviceResult(result), error: result?.error ?? { code: "DEVICE_ACTION_FAILED", message: "设备操作失败" } };
      },
    };
  }

  async function createWorkflow(plan, { autoAllowedDeviceActions = [], source = "unknown" } = {}) {
    const inventory = await readInventory();
    if (!inventory.success) return inventory;
    const validator = makeValidator(inventory, autoAllowedDeviceActions);
    const executor = new AgentPlanExecutor({ validator, handlers: makeHandlers(plan) });
    const workflow = new AgentPlanWorkflow({
      validator,
      executor,
      authorizeActor: async ({ actor }) => actor?.user_confirmed === true,
      evidenceProvider: ({ plan: pendingPlan }) => evidenceForPlan(pendingPlan),
      clock,
      approvalTtlMs,
      onStateChange: approvalStateStore
        ? (state) => approvalStateStore.recordWorkflowState({
          ...state,
          plan_fingerprint: planSubmissionFingerprint(state.plan),
        }, source)
        : null,
    });
    return { success: true, workflow, inventory };
  }

  async function preparePlan(plan) {
    const safePlan = clone(plan);
    if (!Array.isArray(safePlan?.steps)) return { plan: safePlan, evidence: [] };
    const evidence = await evidenceForPlan(safePlan);
    const evidenceByDevice = new Map(evidence.map((item) => [item.device_id, item]));
    for (const step of safePlan.steps) {
      const deviceId = step?.action?.target_ref?.device_id ?? step?.action?.resource_id;
      if (typeof deviceId !== "string") continue;
      const evidenceId = evidenceByDevice.get(deviceId)?.evidence_id;
      if (evidenceId) step.evidence_refs = [...new Set([...(step.evidence_refs ?? []), evidenceId])];
    }
    return { plan: safePlan, evidence };
  }

  function storePending(result, workflow, source, submission = null) {
    const approvalId = result?.approval?.approval_id;
    if (result?.workflow_status === "WAITING_FOR_APPROVAL" && approvalId) {
      if (submission) {
        submission.approvalId = approvalId;
        submission.expiresAt = Date.parse(result.approval.expires_at) || clock() + approvalTtlMs;
      }
      pendingWorkflows.set(approvalId, { workflow, source, submission });
    }
    return result;
  }

  async function runCandidatePlan(plan, submission) {
    const prepared = await preparePlan(plan);
    const created = await createWorkflow(prepared.plan, { source: "candidate_plan" });
    if (!created.success) return failure(created.error.code, created.error.message);
    const result = await created.workflow.submit(prepared.plan, { evidence: prepared.evidence });
    if (result.workflow_status === "CLARIFICATION_REQUIRED") {
      return describeConflictForUser(result, prepared.plan, created.inventory);
    }
    return storePending(result, created.workflow, "candidate_plan", submission);
  }

  async function submitAgentPlan({ plan } = {}) {
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
      return failure("INVALID_PLAN", "plan 必须是 JSON 对象");
    }

    const planId = plan.plan_id;
    if (typeof planId !== "string" || !planId.trim()) return runCandidatePlan(plan, null);

    pruneExpiredPlanSubmissions();
    const fingerprint = planSubmissionFingerprint(plan);
    const byId = planSubmissionsById.get(planId);
    if (byId) {
      if (byId.fingerprint !== fingerprint) {
        return failure(
          "PLAN_ID_REUSED_WITH_DIFFERENT_CONTENT",
          "相同 plan_id 已用于另一份仍在处理或待确认的计划；请使用新的 plan_id 后重新校验。",
          { plan_id: planId },
        );
      }
      return reusePlanSubmission(byId, planId);
    }

    const byFingerprint = planSubmissionsByFingerprint.get(fingerprint);
    if (byFingerprint) {
      byFingerprint.planIds.add(planId);
      planSubmissionsById.set(planId, byFingerprint);
      return reusePlanSubmission(byFingerprint, planId);
    }

    const submission = {
      planId,
      planIds: new Set([planId]),
      fingerprint,
      inFlight: true,
      promise: null,
      result: null,
      approvalId: null,
      expiresAt: null,
    };
    planSubmissionsById.set(planId, submission);
    planSubmissionsByFingerprint.set(fingerprint, submission);
    submission.promise = runCandidatePlan(clone(plan), submission);
    try {
      const result = await submission.promise;
      submission.result = clone(result);
      submission.inFlight = false;
      if (result.workflow_status !== "WAITING_FOR_APPROVAL") releasePlanSubmission(submission);
      return result;
    } catch (error) {
      submission.inFlight = false;
      releasePlanSubmission(submission);
      throw error;
    }
  }

  async function requestDeviceAction(params = {}) {
    const deviceId = params.device_id;
    const actionName = params.action;
    if (typeof deviceId !== "string" || !deviceId || typeof actionName !== "string" || !actionName) {
      return failure("INVALID_ARGUMENT", "device_id 和 action 是必填参数");
    }
    const inventory = await readInventory();
    if (!inventory.success) return failure(inventory.error.code, inventory.error.message);
    const device = inventory.devices.find((item) => item.device_id === deviceId);
    if (!device) return failure("DEVICE_NOT_ALLOWLISTED", `设备不在当前设备清单中：${deviceId}`);
    if (!actionAllowedForDomain(device, actionName)) {
      return failure("ACTION_DOMAIN_MISMATCH", `${device.domain} 不支持动作 ${actionName}`);
    }

    const planId = `plan-${createId()}`;
    const plan = {
      schema_version: PLAN_SCHEMA_VERSION,
      plan_id: planId,
      trace_id: params.trace_id ?? `trace-${planId}`,
      goal: `按用户明确指令执行 ${device.name ?? deviceId} 的 ${actionName}`,
      steps: [{
        step_id: "requested-device-action",
        agent_id: "device-manager",
        capability: "execute_device_action",
        depends_on: [],
        evidence_refs: [],
        input: {},
        action: {
          name: actionName,
          target_ref: { device_id: deviceId },
          parameters: clone(params.parameters ?? {}),
        },
      }],
    };
    const prepared = await preparePlan(plan);
    const confirmationPolicy = getDeviceActionConfirmationPolicy(device, actionName);
    const autoAllowedDeviceActions = !confirmationPolicy.required
      ? [{ device_id: deviceId, action: actionName }]
      : [];
    const created = await createWorkflow(prepared.plan, { autoAllowedDeviceActions, source: "direct_device_action" });
    if (!created.success) return failure(created.error.code, created.error.message);
    const result = await created.workflow.submit(prepared.plan, { evidence: prepared.evidence });
    return storePending(result, created.workflow, "direct_device_action");
  }

  function taskChallenge(task, approvalResult) {
    return {
      schema_version: task.schema_version ?? PLAN_SCHEMA_VERSION,
      task_id: task.task_id,
      target_agent: "device-manager",
      status: "CHALLENGE",
      retryable: false,
      completed_at: new Date(clock()).toISOString(),
      trace_id: task.trace_id,
      result: {},
      error: {
        code: "CONFIRMATION_REQUIRED",
        message: "此事件来自 OpenClaw 工具提交，未能验证为可信自动化来源；设备动作已暂停，请向用户展示设备和动作并询问是否执行。",
        approval_id: approvalResult.approval.approval_id,
        expires_at: approvalResult.approval.expires_at,
        device_id: task.target_ref.device_id,
        action: task.action,
      },
    };
  }

  async function executeEnergyTask(task, { trustedEventSource = false } = {}) {
    const action = deviceActionFromTask(task);
    if (!action || task?.source_agent !== "energy-saving" || task.target_agent !== "device-manager") {
      return {
        schema_version: task?.schema_version ?? PLAN_SCHEMA_VERSION,
        task_id: task?.task_id ?? "unknown",
        target_agent: "device-manager",
        status: "DENIED",
        retryable: false,
        completed_at: new Date(clock()).toISOString(),
        trace_id: task?.trace_id,
        result: {},
        error: { code: "UNTRUSTED_OR_INVALID_TASK", message: "仅接受由已注册节能 Agent 生成的合法设备任务" },
      };
    }
    const planId = `plan-${task.task_id}`;
    const plan = {
      schema_version: PLAN_SCHEMA_VERSION,
      plan_id: planId,
      trace_id: task.trace_id ?? `trace-${planId}`,
      goal: `节能 Agent 提议：${action.name} ${action.target_ref.device_id}`,
      steps: [{
        step_id: "energy-generated-action",
        agent_id: "device-manager",
        capability: "execute_device_action",
        depends_on: [],
        evidence_refs: [],
        input: { energy_task: clone(task) },
        action,
      }],
    };
    const inventory = await readInventory();
    if (!inventory.success) {
      return { ...taskChallengeFallback(task, clock), status: "FAILED", error: inventory.error };
    }
    const device = inventory.devices.find((item) => item.device_id === action.target_ref.device_id);
    const automatic = canAutoRunEnergyTask(task, device, trustedEventSource);
    const autoAllowedDeviceActions = automatic
      ? [{ device_id: action.target_ref.device_id, action: action.name }]
      : [];
    const prepared = await preparePlan(plan);
    const created = await createWorkflow(prepared.plan, { autoAllowedDeviceActions, source: "energy_task" });
    if (!created.success) return { ...taskChallengeFallback(task, clock), status: "FAILED", error: created.error };
    const result = await created.workflow.submit(prepared.plan, { evidence: prepared.evidence });
    if (result.workflow_status === "WAITING_FOR_APPROVAL") {
      storePending(result, created.workflow, "energy_task");
      return taskChallenge(task, result);
    }
    const receipt = result.steps?.[0]?.result?.task_receipt;
    if (receipt) return receipt;
    if (result.workflow_status === "COMPLETED") {
      return {
        schema_version: task.schema_version ?? PLAN_SCHEMA_VERSION,
        task_id: task.task_id,
        target_agent: "device-manager",
        status: "SUCCEEDED",
        retryable: false,
        completed_at: new Date(clock()).toISOString(),
        trace_id: task.trace_id,
        result: result.steps?.[0]?.result ?? {},
      };
    }
    return {
      schema_version: task.schema_version ?? PLAN_SCHEMA_VERSION,
      task_id: task.task_id,
      target_agent: "device-manager",
      status: result.workflow_status === "DENIED" || result.decision === "DENY" ? "DENIED" : "FAILED",
      retryable: false,
      completed_at: new Date(clock()).toISOString(),
      trace_id: task.trace_id,
      result: {},
      error: result.error ?? result.steps?.[0]?.error ?? {
        code: result.workflow_status ?? "ENERGY_TASK_FAILED",
        message: "节能任务未执行",
      },
    };
  }

  function taskChallengeFallback(task, time) {
    return {
      schema_version: task?.schema_version ?? PLAN_SCHEMA_VERSION,
      task_id: task?.task_id ?? "unknown",
      target_agent: "device-manager",
      status: "FAILED",
      retryable: false,
      completed_at: new Date(time()).toISOString(),
      trace_id: task?.trace_id,
      result: {},
      error: { code: "DEVICE_POLICY_UNAVAILABLE", message: "无法建立设备安全校验上下文" },
    };
  }

  async function resolveApproval({ approval_id, decision } = {}) {
    if (typeof approval_id !== "string" || !approval_id) {
      return { workflow_status: "INVALID_APPROVAL_ID", execution_performed: false };
    }
    const pending = pendingWorkflows.get(approval_id);
    if (!pending) {
      const recovered = recoveredApprovals.get(approval_id);
      if (!recovered) return { workflow_status: "APPROVAL_NOT_FOUND_OR_EXPIRED", approval_id, execution_performed: false };
      if (decision === "check_state" || decision === "reconciled") {
        if (recovered.record.status !== "EXECUTION_UNCERTAIN") {
          return { workflow_status: "INVALID_DECISION", approval_id, execution_performed: false };
        }
        if (decision === "check_state") {
          const stateCheck = await readRecoveredActionDeviceStates(recovered.record);
          if (!stateCheck.success) {
            reconciliationSnapshots.delete(approval_id);
            return {
              workflow_status: "EXECUTION_UNCERTAIN",
              approval_id,
              recovery_required: true,
              execution_uncertain: true,
              reconciliation_status: "DEVICE_STATE_UNAVAILABLE",
              current_device_states: stateCheck.devices,
              reconciliation_error_code: stateCheck.error_code,
              automatic_replay: false,
              message: "涉及设备的当前状态未能全部读取或存在离线设备；不确定记录仍保留，系统不会重放动作。请恢复设备/HA 连接后重新查询。",
            };
          }
          const fingerprint = JSON.stringify(stateCheck.devices);
          reconciliationSnapshots.set(approval_id, {
            checked_at_ms: stateCheck.checked_at_ms,
            fingerprint,
          });
          return {
            workflow_status: "EXECUTION_UNCERTAIN",
            approval_id,
            recovery_required: true,
            execution_uncertain: true,
            reconciliation_status: "WAITING_FOR_USER_REVIEW",
            checked_at: new Date(stateCheck.checked_at_ms).toISOString(),
            current_device_states: stateCheck.devices,
            automatic_replay: false,
            message: "已只读查询相关设备状态；不确定记录仍保留，尚未执行、撤销或关闭任何动作。请先把这些状态告知用户，并等待其后续明确要求关闭。",
          };
        }

        const previousCheck = reconciliationSnapshots.get(approval_id);
        if (!previousCheck || clock() - previousCheck.checked_at_ms > RECONCILIATION_CHECK_TTL_MS) {
          reconciliationSnapshots.delete(approval_id);
          return {
            workflow_status: "EXECUTION_UNCERTAIN",
            approval_id,
            recovery_required: true,
            execution_uncertain: true,
            reconciliation_status: "CHECK_REQUIRED",
            automatic_replay: false,
            message: "关闭前需要先查询并向用户展示涉及设备的当前状态；此记录仍保持阻止，尚未执行任何动作。",
          };
        }

        const stateCheck = await readRecoveredActionDeviceStates(recovered.record);
        if (!stateCheck.success) {
          reconciliationSnapshots.delete(approval_id);
          return {
            workflow_status: "EXECUTION_UNCERTAIN",
            approval_id,
            recovery_required: true,
            execution_uncertain: true,
            reconciliation_status: "DEVICE_STATE_UNAVAILABLE",
            current_device_states: stateCheck.devices,
            reconciliation_error_code: stateCheck.error_code,
            automatic_replay: false,
            message: "涉及设备的当前状态未能全部读取或存在离线设备；不确定记录仍保留，系统不会重放动作。请恢复设备/HA 连接并重新核对。",
          };
        }
        const stateFingerprint = JSON.stringify(stateCheck.devices);
        if (stateFingerprint !== previousCheck.fingerprint) {
          reconciliationSnapshots.set(approval_id, {
            checked_at_ms: stateCheck.checked_at_ms,
            fingerprint: stateFingerprint,
          });
          return {
            workflow_status: "EXECUTION_UNCERTAIN",
            approval_id,
            recovery_required: true,
            execution_uncertain: true,
            reconciliation_status: "STATE_CHANGED",
            checked_at: new Date(stateCheck.checked_at_ms).toISOString(),
            current_device_states: stateCheck.devices,
            automatic_replay: false,
            message: "关闭前复查发现设备状态与刚才展示的内容不同；记录仍保持阻止。请将最新状态告知用户，并等待其后续明确要求关闭。",
          };
        }

        let removed;
        try { removed = approvalStateStore?.remove?.(approval_id); } catch {
          return { workflow_status: "APPROVAL_STATE_PERSIST_FAILED", approval_id, execution_performed: false };
        }
        if (removed !== true) {
          return { workflow_status: "APPROVAL_ALREADY_RECONCILED", approval_id, execution_performed: false };
        }
        reconciliationSnapshots.delete(approval_id);
        recoveredApprovals.delete(approval_id);
        for (const submission of new Set(planSubmissionsByFingerprint.values())) {
          if (submission.approvalId === approval_id) releasePlanSubmission(submission);
        }
        return {
          workflow_status: "RECONCILED",
          approval_id,
          prior_execution_result: "UNKNOWN",
          automatic_replay: false,
          checked_at: new Date(stateCheck.checked_at_ms).toISOString(),
          current_device_states: stateCheck.devices,
          message: "不确定记录已按用户核对结果关闭；这不会证明或撤销此前动作。若仍需操作，必须重新规划并重新校验。",
        };
      }
      if (recovered.record.status === "EXECUTION_UNCERTAIN" && decision === "reject") {
        return {
          ...clone(recovered.result.approval),
          message: "拒绝旧确认不能判断或撤销可能已发生的设备动作。请先查询并核对设备现状；只有核对后再明确要求关闭不确定记录，才能解除此阻止。",
        };
      }
      if (decision === "reject") {
        try { approvalStateStore?.remove?.(approval_id); } catch {
          return { workflow_status: "APPROVAL_STATE_PERSIST_FAILED", approval_id, execution_performed: false };
        }
        recoveredApprovals.delete(approval_id);
        for (const submission of new Set(planSubmissionsByFingerprint.values())) {
          if (submission.approvalId === approval_id) releasePlanSubmission(submission);
        }
        return { workflow_status: "REJECTED", approval_id, execution_performed: false, message: "已关闭旧确认项；没有执行设备动作。" };
      }
      if (!["approve", "defer"].includes(decision)) {
        return { workflow_status: "INVALID_DECISION", approval_id, execution_performed: false };
      }
      return clone(recovered.result.approval);
    }
    if (decision === "defer") {
      const view = pending.workflow.getApproval(approval_id);
      if (view.workflow_status !== "WAITING_FOR_APPROVAL") {
        pendingWorkflows.delete(approval_id);
        releasePlanSubmission(pending.submission);
      }
      return view;
    }
    if (!new Set(["approve", "reject"]).has(decision)) {
      return { workflow_status: "INVALID_DECISION", approval_id, execution_performed: false };
    }
    const result = decision === "approve"
      ? await pending.workflow.approve(approval_id, { actor: { id: "openclaw-user-turn", user_confirmed: true } })
      : await pending.workflow.reject(approval_id, { actor: { id: "openclaw-user-turn", user_confirmed: true } });
    if (result.workflow_status !== "WAITING_FOR_APPROVAL" && result.workflow_status !== "EVIDENCE_REFRESH_FAILED") {
      pendingWorkflows.delete(approval_id);
      const sideEffectPossible = result.workflow_status === "COMPLETED"
        || result.workflow_status === "EXECUTION_UNCERTAIN"
        || result.execution_uncertain === true
        || result.partial_effect_possible === true;
      if (sideEffectPossible) {
        if (pending.submission) {
          pending.submission.result = clone(result);
          pending.submission.inFlight = false;
          pending.submission.finalized = true;
        }
        // Keep the durable terminal tombstone through the original idempotency
        // window. A lost tool response must not cause the same plan to execute
        // again immediately after a retry or Gateway restart.
        return result;
      }
      try { approvalStateStore?.remove?.(approval_id); } catch {
        if (pending.submission) {
          pending.submission.result = clone(result);
          pending.submission.inFlight = false;
          pending.submission.recovered = true;
        }
        return {
          ...result,
          persistence_warning: "确认状态文件未能清理；如 Gateway 随后重启，同一计划会被保守地阻止或要求核对。",
        };
      }
      releasePlanSubmission(pending.submission);
    }
    return result;
  }

  function listPendingApprovals() {
    pruneExpiredPlanSubmissions();
    const output = [...recoveredApprovals.values()].map(({ record }) => recoveryView(record));
    for (const [approvalId, pending] of pendingWorkflows) {
      const view = pending.workflow.getApproval(approvalId);
      if (view.workflow_status === "WAITING_FOR_APPROVAL") output.push({ ...view, source: pending.source });
      else {
        pendingWorkflows.delete(approvalId);
        releasePlanSubmission(pending.submission);
        try { approvalStateStore?.remove?.(approvalId); } catch {}
      }
    }
    return output;
  }

  async function invokeTool(name, params = {}) {
    if (name === "submit_agent_plan") return submitAgentPlan(params);
    if (name === "control_device") return requestDeviceAction(params);
    if (name === "resolve_agent_action_confirmation") return resolveApproval(params);
    if (name === "list_pending_agent_action_confirmations") return { pending: listPendingApprovals() };
    return failure("TOOL_NOT_FOUND", `未知 Agent 计划工具：${name}`);
  }

  return {
    submitAgentPlan,
    requestDeviceAction,
    executeEnergyTask,
    resolveApproval,
    listPendingApprovals,
    invokeTool,
  };
}
