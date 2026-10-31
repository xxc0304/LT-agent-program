import { PlatformAgentRegistry } from "./platform-agent-registry.js";

const RUN_STATUSES = Object.freeze({
  COMPLETED: "COMPLETED",
  NEEDS_CLARIFICATION: "NEEDS_CLARIFICATION",
  UNSUPPORTED: "UNSUPPORTED",
  NEEDS_CONFIRMATION: "NEEDS_CONFIRMATION",
  BLOCKED: "BLOCKED",
  FAILED: "FAILED",
});

const UNKNOWN_CAPABILITY_MESSAGE = "我暂时找不到已接入的功能来完成这件事，所以没有执行任何操作。";

const SUCCESSFUL_AGENT_STATUSES = new Set(["COMPLETED", "PROPOSED", "NO_ACTION"]);
const STOP_AGENT_STATUSES = new Set([
  "NEEDS_CLARIFICATION",
  "NEEDS_CONFIRMATION",
  "CONFLICT",
  "BLOCKED",
  "FAILED",
]);
const STOP_STATUS_PRIORITY = Object.freeze({
  FAILED: 0,
  BLOCKED: 1,
  CONFLICT: 2,
  NEEDS_CONFIRMATION: 3,
  NEEDS_CLARIFICATION: 4,
});
const ACTION_CONFLICT_GROUPS = Object.freeze({
  turn_on: "power",
  turn_off: "power",
  lock: "lock_state",
  unlock: "lock_state",
  open: "position",
  close: "position",
  stop: "position",
  set_temperature: "temperature",
  set_target_temperature: "temperature",
  set_brightness: "brightness",
  set_color_temperature: "color_temperature",
  set_hvac_mode: "hvac_mode",
  set_fan_mode: "fan_mode",
});
const ENERGY_BUDGET_MINIMUM_COMPLETE_DAYS = 3;
const ENERGY_BUDGET_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UTC_DAY_MS = 86_400_000;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    const error = new Error(`${field} must be a non-empty string`);
    error.code = "INVALID_ORCHESTRATION_INPUT";
    throw error;
  }
  return value.trim();
}

function failPlan(message, code = "INVALID_ORCHESTRATION_PLAN") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validatePlan({ request, plan, context }, { maxSteps }) {
  const normalizedRequest = requireText(request, "request");
  if (normalizedRequest.length > 4_000) failPlan("request exceeds 4000 characters");
  if (!isRecord(context)) failPlan("context must be a JSON object");
  if (!isRecord(plan)) failPlan("plan must be an object");
  const traceId = requireText(plan.trace_id, "plan.trace_id");
  if (traceId.length > 128) failPlan("plan.trace_id cannot exceed 128 characters");
  const decision = plan.decision ?? "dispatch";
  if (!["dispatch", "clarify", "unsupported"].includes(decision)) {
    failPlan("plan.decision must be dispatch, clarify, or unsupported");
  }

  if (decision !== "dispatch") {
    const steps = plan.steps ?? [];
    if (!Array.isArray(steps) || steps.length > maxSteps) failPlan(`plan.steps must be an array of at most ${maxSteps} items`);
    if (decision === "clarify") {
      const question = requireText(plan.question, "plan.question");
      if (question.length > 1_000) failPlan("plan.question cannot exceed 1000 characters");
      return { request: normalizedRequest, traceId, context: clone(context), decision, question, plannedStepIds: steps.map((step) => step?.step_id).filter((id) => typeof id === "string") };
    }
    const message = requireText(plan.message, "plan.message");
    if (message.length > 1_000) failPlan("plan.message cannot exceed 1000 characters");
    return { request: normalizedRequest, traceId, context: clone(context), decision, message, plannedStepIds: steps.map((step) => step?.step_id).filter((id) => typeof id === "string") };
  }

  if (!Array.isArray(plan.steps) || plan.steps.length === 0) failPlan("plan.steps must be a non-empty array for dispatch");
  if (plan.steps.length > maxSteps) failPlan(`plan.steps cannot exceed ${maxSteps}`);
  const stepById = new Map();

  for (const [index, step] of plan.steps.entries()) {
    if (!isRecord(step)) failPlan(`plan.steps[${index}] must be an object`);
    const stepId = requireText(step.step_id, `plan.steps[${index}].step_id`);
    if (stepId.length > 128) failPlan("step_id cannot exceed 128 characters");
    if (stepById.has(stepId)) failPlan(`duplicate step_id: ${stepId}`);
    requireText(step.agent_id, `plan.steps[${index}].agent_id`);
    const capability = requireText(step.capability, `plan.steps[${index}].capability`);
    if (capability.length > 128) failPlan(`${stepId}.capability cannot exceed 128 characters`);
    const task = requireText(step.task, `plan.steps[${index}].task`);
    if (task.length > 4_000) failPlan(`${stepId}.task cannot exceed 4000 characters`);
    if (step.input !== undefined && !isRecord(step.input)) failPlan(`${stepId}.input must be an object`);
    if (step.depends_on !== undefined
      && (!Array.isArray(step.depends_on) || step.depends_on.some((dependency) => typeof dependency !== "string"))) {
      failPlan(`${stepId}.depends_on must be an array of step IDs`);
    }
    if (step.action !== undefined && !isRecord(step.action)) failPlan(`${stepId}.action must be an object`);
    stepById.set(stepId, step);
  }

  for (const [stepId, step] of stepById) {
    for (const dependency of step.depends_on ?? []) {
      if (!stepById.has(dependency)) failPlan(`${stepId} depends on missing step ${dependency}`);
      if (dependency === stepId) failPlan(`${stepId} cannot depend on itself`);
    }
  }

  const ordered = [];
  const remaining = new Set(stepById.keys());
  while (remaining.size > 0) {
    const ready = [...remaining].filter((stepId) =>
      (stepById.get(stepId).depends_on ?? []).every((dependency) => !remaining.has(dependency)));
    if (ready.length === 0) failPlan("plan dependency graph contains a cycle", "PLAN_DEPENDENCY_CYCLE");
    ordered.push(...ready);
    for (const stepId of ready) remaining.delete(stepId);
  }

  return { request: normalizedRequest, traceId, context: clone(context), decision, stepById, ordered };
}

function noDispatchResult({ status, traceId, reasonCode, message, question, stepIds = [] }) {
  return {
    status,
    trace_id: traceId,
    agent_calls_performed: false,
    device_action_agent_invoked: false,
    reason_code: reasonCode,
    ...(question ? { question } : {}),
    ...(message ? { message } : {}),
    results: [],
    remaining_step_ids: stepIds,
  };
}

function parseBudgetDate(value) {
  if (typeof value !== "string" || !ENERGY_BUDGET_DATE_PATTERN.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) return null;
  return timestamp;
}

function budgetDailyEnergyKwh(item) {
  if (!isRecord(item)) return null;
  const canonicalValue = item.energy_kwh;
  const commonAlias = item.kwh;
  if (canonicalValue !== undefined && commonAlias !== undefined && canonicalValue !== commonAlias) return null;
  const value = canonicalValue ?? commonAlias;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeBudgetForecastInput(input) {
  if (!Array.isArray(input.daily_totals)) return clone(input);
  return {
    ...clone(input),
    daily_totals: input.daily_totals.map((item) => {
      if (!isRecord(item) || item.energy_kwh !== undefined || item.kwh === undefined) return clone(item);
      const { kwh, ...rest } = item;
      return { ...rest, energy_kwh: kwh };
    }),
  };
}

function energyBudgetForecastQuestion(step) {
  const input = isRecord(step.input) ? step.input : {};
  const missing = [];
  const budgetValid = Number.isFinite(input.budget_kwh) && input.budget_kwh > 0;
  if (!budgetValid) missing.push("本期用电预算");

  const startMs = parseBudgetDate(input.period_start);
  const endMs = parseBudgetDate(input.period_end);
  const throughMs = parseBudgetDate(input.through_date);
  const dateRangeValid = startMs !== null && endMs !== null && throughMs !== null
    && endMs >= startMs && throughMs >= startMs && throughMs <= endMs;
  if (!dateRangeValid) missing.push("账期起止日期和统计截止日");

  const dailyTotals = Array.isArray(input.daily_totals) ? input.daily_totals : null;
  if (!dailyTotals) missing.push("从账期开始到统计截止日的逐日电量");

  let coverageValid = false;
  if (dateRangeValid && dailyTotals) {
    const observedDays = Math.floor((throughMs - startMs) / UTC_DAY_MS) + 1;
    if (observedDays < ENERGY_BUDGET_MINIMUM_COMPLETE_DAYS) {
      missing.push(`至少 ${ENERGY_BUDGET_MINIMUM_COMPLETE_DAYS} 个完整日的数据`);
    }
    if (observedDays > 366) missing.push("不超过 366 天的统计范围");

    const totalsByDate = new Map();
    let entriesValid = dailyTotals.length <= 366;
    if (entriesValid) {
      for (const item of dailyTotals) {
        const energyKwh = budgetDailyEnergyKwh(item);
        if (!isRecord(item)
          || parseBudgetDate(item.date) === null
          || energyKwh === null
          || totalsByDate.has(item.date)) {
          entriesValid = false;
          break;
        }
        totalsByDate.set(item.date, energyKwh);
      }
    }

    const contiguous = entriesValid
      && observedDays <= 366
      && dailyTotals.length === observedDays
      && Array.from({ length: observedDays }, (_, offset) =>
        new Date(startMs + offset * UTC_DAY_MS).toISOString().slice(0, 10),
      ).every((date) => totalsByDate.has(date));
    if (!contiguous) missing.push("连续、无重复且没有漏天的逐日数据");
    coverageValid = contiguous && observedDays >= ENERGY_BUDGET_MINIMUM_COMPLETE_DAYS;
  }

  if (input.coverage_attested_complete !== true) missing.push("确认这些数据覆盖完整且没有漏天");
  if (missing.length === 0 && coverageValid) return null;

  const uniqueMissing = [...new Set(missing)];
  return `现在还不能估算本期预算。请补充${uniqueMissing.join("、")}；至少需要 ${ENERGY_BUDGET_MINIMUM_COMPLETE_DAYS} 个从账期开始连续统计的完整日，并确认数据没有漏天。`;
}

function findEnergyBudgetForecastClarification(plan) {
  for (const step of plan.stepById.values()) {
    if (step.agent_id !== "energy-saving" || step.capability !== "forecast_energy_budget") continue;
    const question = energyBudgetForecastQuestion(step);
    if (question) return { question, stepId: step.step_id };
  }
  return null;
}

function dependsTransitivelyOn(stepId, ancestorId, stepById, seen = new Set()) {
  if (stepId === ancestorId) return true;
  if (seen.has(stepId)) return false;
  seen.add(stepId);
  return (stepById.get(stepId)?.depends_on ?? []).some((dependency) =>
    dependsTransitivelyOn(dependency, ancestorId, stepById, seen));
}

function actionDetails(step) {
  const action = step.action;
  if (!isRecord(action)) return null;
  const name = action.name ?? action.action;
  const resourceId = action.target_ref?.device_id ?? action.resource_id;
  if (typeof name !== "string" || typeof resourceId !== "string") return null;
  return {
    name,
    resourceId,
    conflictGroup: action.conflict_group ?? ACTION_CONFLICT_GROUPS[name] ?? name,
    fingerprint: stableStringify({ name, parameters: action.parameters ?? {} }),
  };
}

function findActionConflicts(plan, registry, stepById) {
  const actions = plan.steps
    .filter((step) => registry.getCapability(step.agent_id, step.capability)?.effect === "device_action")
    .map((step) => ({ step, action: actionDetails(step) }))
    .filter((item) => item.action);
  const conflicts = [];
  for (let leftIndex = 0; leftIndex < actions.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < actions.length; rightIndex += 1) {
      const left = actions[leftIndex];
      const right = actions[rightIndex];
      const ordered = dependsTransitivelyOn(left.step.step_id, right.step.step_id, stepById)
        || dependsTransitivelyOn(right.step.step_id, left.step.step_id, stepById);
      if (!ordered
        && left.action.resourceId === right.action.resourceId
        && left.action.conflictGroup === right.action.conflictGroup
        && left.action.fingerprint !== right.action.fingerprint) {
        conflicts.push({
          step_ids: [left.step.step_id, right.step.step_id],
          resource_id: left.action.resourceId,
          conflict_group: left.action.conflictGroup,
          actions: [left.action.name, right.action.name],
        });
      }
    }
  }
  return conflicts;
}

function findIncompleteDeviceActionSteps(plan, registry) {
  return plan.steps
    .filter((step) => registry.getCapability(step.agent_id, step.capability)?.effect === "device_action")
    .filter((step) => actionDetails(step) === null)
    .map((step) => step.step_id);
}

function agentOutcome(raw, step, traceId) {
  if (!isRecord(raw) || typeof raw.status !== "string") {
    return {
      status: "FAILED",
      error: { code: "INVALID_AGENT_RESULT", message: "Agent must return a JSON object with a typed status" },
    };
  }
  if (raw.source_agent !== step.agent_id || raw.trace_id !== traceId) {
    return {
      status: "FAILED",
      error: { code: "AGENT_REPLY_IDENTITY_MISMATCH", message: "Agent reply source_agent or trace_id does not match the dispatched request" },
    };
  }
  if (!SUCCESSFUL_AGENT_STATUSES.has(raw.status) && !STOP_AGENT_STATUSES.has(raw.status)) {
    return {
      status: "FAILED",
      error: { code: "INVALID_AGENT_RESULT_STATUS", message: `Unsupported Agent status: ${raw.status}` },
    };
  }
  if (raw.status === "NEEDS_CLARIFICATION" || raw.status === "NEEDS_CONFIRMATION" || raw.status === "CONFLICT") {
    const question = typeof raw.question === "string" && raw.question.trim()
      ? raw.question.trim()
      : raw.message;
    if (typeof question !== "string" || !question.trim()) {
      return {
        status: "FAILED",
        error: { code: "AGENT_QUESTION_MISSING", message: `${raw.status} must include a user-facing question` },
      };
    }
    return {
      status: raw.status,
      question: question.trim(),
      ...(Array.isArray(raw.options) ? { options: clone(raw.options) } : {}),
      ...(typeof raw.reason_code === "string" ? { reason_code: raw.reason_code } : {}),
      ...(raw.conflicts !== undefined ? { conflicts: clone(raw.conflicts) } : {}),
      ...(isRecord(raw.result) ? { result: clone(raw.result) } : {}),
    };
  }
  if (raw.status === "BLOCKED" || raw.status === "FAILED") {
    return {
      status: raw.status,
      error: isRecord(raw.error)
        ? clone(raw.error)
        : { code: raw.reason_code ?? `AGENT_${raw.status}`, message: raw.message ?? `Agent returned ${raw.status}` },
      ...(raw.side_effects_unknown === true ? { side_effects_unknown: true } : {}),
    };
  }
  return {
    status: raw.status,
    ...(typeof raw.summary === "string" ? { summary: raw.summary } : {}),
    result: isRecord(raw.result) ? clone(raw.result) : {},
  };
}

function topLevelForAgentStatus(status) {
  if (status === "NEEDS_CONFIRMATION") return RUN_STATUSES.NEEDS_CONFIRMATION;
  if (status === "NEEDS_CLARIFICATION" || status === "CONFLICT") return RUN_STATUSES.NEEDS_CLARIFICATION;
  if (status === "BLOCKED") return RUN_STATUSES.BLOCKED;
  return RUN_STATUSES.FAILED;
}

function isSuccessfulOutcome(outcome) {
  return SUCCESSFUL_AGENT_STATUSES.has(outcome.status);
}

function selectStoppingOutcome(results, stepById) {
  const planOrder = new Map([...stepById.keys()].map((stepId, index) => [stepId, index]));
  return results
    .filter((outcome) => STOP_AGENT_STATUSES.has(outcome.status))
    .sort((left, right) => (STOP_STATUS_PRIORITY[left.status] - STOP_STATUS_PRIORITY[right.status])
      || (planOrder.get(left.step_id) - planOrder.get(right.step_id)))[0] ?? null;
}

/**
 * Platform-level deterministic dispatcher. OpenClaw proposes the plan; this
 * layer validates the registered Agent/capability graph, dispatches through
 * Agent adapters, and halts on ambiguity, conflict, confirmation, or failure.
 * It has no device API and cannot execute physical actions directly.
 */
export function createPlatformOrchestrator({ registry, maxSteps = 12 } = {}) {
  if (!(registry instanceof PlatformAgentRegistry)) {
    throw new Error("createPlatformOrchestrator requires a PlatformAgentRegistry");
  }
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 100) {
    throw new Error("maxSteps must be an integer between 1 and 100");
  }

  return {
    listAgents() {
      return registry.listAgents();
    },

    async run({ request, plan, context = {} } = {}) {
      const normalized = validatePlan({ request, plan, context }, { maxSteps });
      if (normalized.decision === "clarify") {
        return noDispatchResult({
          status: RUN_STATUSES.NEEDS_CLARIFICATION,
          traceId: normalized.traceId,
          reasonCode: "OPENCLAW_REQUESTED_CLARIFICATION",
          question: normalized.question,
          stepIds: normalized.plannedStepIds,
        });
      }
      if (normalized.decision === "unsupported") {
        return noDispatchResult({
          status: RUN_STATUSES.UNSUPPORTED,
          traceId: normalized.traceId,
          reasonCode: "NO_REGISTERED_CAPABILITY_MATCH",
          message: normalized.message,
          stepIds: normalized.plannedStepIds,
        });
      }

      for (const [stepId, step] of normalized.stepById) {
        const agent = registry.getAgent(step.agent_id);
        if (!agent) {
          return noDispatchResult({
            status: RUN_STATUSES.UNSUPPORTED,
            traceId: normalized.traceId,
            reasonCode: "AGENT_NOT_REGISTERED",
            message: UNKNOWN_CAPABILITY_MESSAGE,
            stepIds: plan.steps.map((plannedStep) => plannedStep.step_id),
          });
        }
        if (!registry.getCapability(step.agent_id, step.capability)) {
          return noDispatchResult({
            status: RUN_STATUSES.UNSUPPORTED,
            traceId: normalized.traceId,
            reasonCode: "CAPABILITY_NOT_REGISTERED",
            message: UNKNOWN_CAPABILITY_MESSAGE,
            stepIds: plan.steps.map((plannedStep) => plannedStep.step_id),
          });
        }
        if (!agent.invoke) failPlan(`Agent ${step.agent_id} has no adapter`, "AGENT_ADAPTER_UNAVAILABLE");
        if (step.input !== undefined) {
          try {
            JSON.stringify(step.input);
          } catch {
            failPlan(`${stepId}.input must be JSON serializable`);
          }
        }
      }

      const budgetClarification = findEnergyBudgetForecastClarification(normalized);
      if (budgetClarification) {
        return noDispatchResult({
          status: RUN_STATUSES.NEEDS_CLARIFICATION,
          traceId: normalized.traceId,
          reasonCode: "ENERGY_BUDGET_DATA_INCOMPLETE",
          question: budgetClarification.question,
          stepIds: [...normalized.stepById.keys()],
        });
      }

      const deviceActionStepIds = plan.steps
        .filter((step) => registry.getCapability(step.agent_id, step.capability)?.effect === "device_action")
        .map((step) => step.step_id);
      const incompleteDeviceActionStepIds = findIncompleteDeviceActionSteps(plan, registry);
      if (deviceActionStepIds.length > 1 && incompleteDeviceActionStepIds.length > 0) {
        return {
          status: RUN_STATUSES.BLOCKED,
          trace_id: normalized.traceId,
          agent_calls_performed: false,
          device_action_agent_invoked: false,
          reason_code: "DEVICE_ACTION_DETAILS_REQUIRED",
          error: {
            code: "DEVICE_ACTION_DETAILS_REQUIRED",
            message: "Aggregate the complete device intent into one device-manager action step so it can resolve the registered devices and validate the whole plan before execution.",
          },
          incomplete_step_ids: incompleteDeviceActionStepIds,
          results: [],
          remaining_step_ids: plan.steps.map((step) => step.step_id),
        };
      }

      const conflicts = findActionConflicts(plan, registry, normalized.stepById);
      if (conflicts.length > 0) {
        return {
          status: RUN_STATUSES.NEEDS_CLARIFICATION,
          trace_id: normalized.traceId,
          agent_calls_performed: false,
          device_action_agent_invoked: false,
          question: "这几项设备操作可能互相冲突。你希望保留哪一项，或按什么先后顺序执行？",
          reason_code: "DEVICE_ACTION_CONFLICT",
          conflicts,
          results: [],
          remaining_step_ids: plan.steps.map((step) => step.step_id),
        };
      }

      if (deviceActionStepIds.length > 1) {
        return {
          status: RUN_STATUSES.BLOCKED,
          trace_id: normalized.traceId,
          agent_calls_performed: false,
          device_action_agent_invoked: false,
          reason_code: "MULTIPLE_DEVICE_ACTION_STEPS_REQUIRE_AGGREGATION",
          error: {
            code: "MULTIPLE_DEVICE_ACTION_STEPS_REQUIRE_AGGREGATION",
            message: "Submit the complete device intent through one device-manager action step. The device manager validates multi-device plans as a whole before execution.",
          },
          results: [],
          remaining_step_ids: plan.steps.map((step) => step.step_id),
        };
      }

      const completed = new Map();
      const pending = new Set(normalized.ordered);
      const results = [];
      let stopObserved = false;

      while (pending.size > 0) {
        const ready = [...pending].filter((stepId) =>
          (normalized.stepById.get(stepId).depends_on ?? []).every((dependency) => completed.has(dependency)));
        if (ready.length === 0) failPlan("No runnable step remains in the dependency graph", "PLAN_DEPENDENCY_CYCLE");

        const analysisSteps = ready.filter((stepId) =>
          registry.getCapability(
            normalized.stepById.get(stepId).agent_id,
            normalized.stepById.get(stepId).capability,
          ).effect !== "device_action");
        const actionSteps = ready.filter((stepId) => !analysisSteps.includes(stepId));

        // Let all ready analysis/planning Agents finish before starting any
        // device-action Agent. A clarification from one of them prevents the
        // device manager from receiving a possibly premature action request.
        const batch = analysisSteps.length > 0 ? analysisSteps : [actionSteps[0]];
        const byAgent = new Map();
        for (const stepId of batch) {
          const agentId = normalized.stepById.get(stepId).agent_id;
          if (!byAgent.has(agentId)) byAgent.set(agentId, []);
          byAgent.get(agentId).push(stepId);
        }

        const agentBatches = await Promise.all([...byAgent.values()].map(async (stepIds) => {
          const agentResults = [];
          for (const stepId of stepIds) {
            if (stopObserved) break;
            const step = normalized.stepById.get(stepId);
            const dependencyResults = Object.fromEntries((step.depends_on ?? []).map((dependencyId) => [
              dependencyId,
              clone(completed.get(dependencyId).result ?? {}),
            ]));
            const call = {
              agentId: step.agent_id,
              capability: step.capability,
              task: step.task.trim(),
              input: step.agent_id === "energy-saving" && step.capability === "forecast_energy_budget"
                ? normalizeBudgetForecastInput(step.input ?? {})
                : clone(step.input ?? {}),
              action: step.action ? clone(step.action) : null,
              dependencyResults,
              originalRequest: normalized.request,
              context: clone(normalized.context),
              traceId: normalized.traceId,
              stepId,
            };
            let outcome;
            const startedAt = Date.now();
            try {
              const raw = await registry.getAgent(step.agent_id).invoke(call);
              outcome = agentOutcome(raw, step, normalized.traceId);
            } catch (error) {
              outcome = {
                status: "FAILED",
                error: {
                  code: error?.code ?? "AGENT_INVOCATION_FAILED",
                  message: error instanceof Error ? error.message : String(error),
                },
                ...(error?.sentBeforeError === true
                  && registry.getCapability(step.agent_id, step.capability).effect === "device_action"
                  ? { side_effects_unknown: true }
                  : {}),
              };
            }
            const record = {
              step_id: stepId,
              agent_id: step.agent_id,
              capability: step.capability,
              capability_effect: registry.getCapability(step.agent_id, step.capability).effect,
              elapsed_ms: Date.now() - startedAt,
              ...outcome,
            };
            agentResults.push(record);
            if (!isSuccessfulOutcome(outcome)) {
              stopObserved = true;
              break;
            }
          }
          return agentResults;
        }));

        for (const agentResults of agentBatches) {
          for (const outcome of agentResults) {
            results.push(outcome);
            pending.delete(outcome.step_id);
            if (isSuccessfulOutcome(outcome)) completed.set(outcome.step_id, outcome);
          }
        }

        const stopped = selectStoppingOutcome(results, normalized.stepById);
        if (stopped) {
          const deviceActionAgentInvoked = results.some((outcome) => outcome.capability_effect === "device_action");
          return {
            status: topLevelForAgentStatus(stopped.status),
            trace_id: normalized.traceId,
            agent_calls_performed: results.length > 0,
            device_action_agent_invoked: deviceActionAgentInvoked,
            results,
            remaining_step_ids: [...pending],
            ...(stopped.question ? { question: stopped.question } : {}),
            ...(stopped.options ? { options: stopped.options } : {}),
            ...(stopped.reason_code ? { reason_code: stopped.reason_code } : {}),
            ...(stopped.conflicts ? { conflicts: stopped.conflicts } : {}),
            ...(stopped.error ? { error: stopped.error } : {}),
            ...(stopped.side_effects_unknown ? { side_effects_unknown: true } : {}),
            blocked_step_id: stopped.step_id,
          };
        }
      }

      return {
        status: RUN_STATUSES.COMPLETED,
        trace_id: normalized.traceId,
        agent_calls_performed: results.length > 0,
        device_action_agent_invoked: results.some((outcome) => outcome.capability_effect === "device_action"),
        results,
        remaining_step_ids: [],
      };
    },
  };
}

export { RUN_STATUSES as PLATFORM_ORCHESTRATION_STATUSES };
