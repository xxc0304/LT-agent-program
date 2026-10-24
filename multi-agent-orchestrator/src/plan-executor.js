const EXECUTION_STATUSES = new Set([
  "SUCCEEDED",
  "FAILED",
  "DENIED",
  "CHALLENGE",
  "TIMEOUT",
]);

function clone(value) {
  return structuredClone(value);
}

function handlerKey(agentId, capability) {
  return `${agentId}::${capability}`;
}

/**
 * Execute a validated, acyclic candidate plan using explicitly registered
 * local capability handlers. This is a deterministic runtime; it does not
 * generate plans or grant handlers additional permissions.
 */
export class AgentPlanExecutor {
  constructor({ validator, handlers = new Map() } = {}) {
    if (!validator || typeof validator.evaluate !== "function") {
      throw new Error("AgentPlanExecutor 必须接收 AgentPlanValidator");
    }
    this.validator = validator;
    this.handlers = new Map();
    const entries = handlers instanceof Map ? handlers.entries() : Object.entries(handlers);
    for (const [key, handler] of entries) this.registerHandler(key, handler);
  }

  registerHandler(key, handler) {
    if (typeof key !== "string" || !key.includes("::")) {
      throw new Error("handler key 格式必须为 agent_id::capability");
    }
    if (typeof handler !== "function") throw new Error(`handler ${key} 必须是函数`);
    this.handlers.set(key, handler);
    return { success: true, key };
  }

  async execute(plan, { evidence = [], approval = null } = {}) {
    const validation = this.validator.evaluate(plan, { evidence, approval });
    if (validation.decision !== "ALLOW") {
      return {
        ...validation,
        execution_status: validation.decision,
        execution_performed: false,
        steps: [],
      };
    }

    const planSteps = new Map(plan.steps.map((step) => [step.step_id, step]));
    const evidenceById = new Map(evidence.map((item) => [item.evidence_id, item]));
    const outcomesById = new Map();
    const stepOutcomes = [];
    let executionPerformed = false;
    let failureSeen = false;

    for (const stepId of validation.ordered_step_ids) {
      const step = planSteps.get(stepId);
      if (failureSeen) {
        const outcome = {
          step_id: stepId,
          agent_id: step.agent_id,
          capability: step.capability,
          status: "SKIPPED_AFTER_STEP_FAILURE",
          error: { code: "PLAN_STOPPED_AFTER_STEP_FAILURE" },
        };
        outcomesById.set(stepId, outcome);
        stepOutcomes.push(outcome);
        continue;
      }
      const failedDependency = (step.depends_on ?? []).find(
        (dependencyId) => outcomesById.get(dependencyId)?.status !== "SUCCEEDED",
      );
      if (failedDependency) {
        const outcome = {
          step_id: stepId,
          agent_id: step.agent_id,
          capability: step.capability,
          status: "SKIPPED_DEPENDENCY",
          error: { code: "DEPENDENCY_NOT_SUCCEEDED", dependency_step_id: failedDependency },
        };
        outcomesById.set(stepId, outcome);
        stepOutcomes.push(outcome);
        failureSeen = true;
        continue;
      }

      const key = handlerKey(step.agent_id, step.capability);
      const handler = this.handlers.get(key);
      if (!handler) {
        const outcome = {
          step_id: stepId,
          agent_id: step.agent_id,
          capability: step.capability,
          status: "FAILED",
          error: { code: "CAPABILITY_HANDLER_UNAVAILABLE", message: `没有注册执行器：${key}` },
        };
        outcomesById.set(stepId, outcome);
        stepOutcomes.push(outcome);
        failureSeen = true;
        continue;
      }

      executionPerformed = true;
      const startedAt = Date.now();
      try {
        const rawResult = await handler({
          plan_id: plan.plan_id,
          trace_id: plan.trace_id,
          step_id: stepId,
          input: clone(step.input ?? {}),
          action: step.action ? clone(step.action) : null,
          evidence: (step.evidence_refs ?? []).map((evidenceId) => evidenceById.get(evidenceId)).filter(Boolean).map(clone),
          dependency_results: Object.fromEntries((step.depends_on ?? []).map((dependencyId) => [
            dependencyId,
            clone(outcomesById.get(dependencyId).result ?? {}),
          ])),
        });
        const reportedStatus = rawResult?.status ?? "SUCCEEDED";
        const status = EXECUTION_STATUSES.has(reportedStatus) ? reportedStatus : "FAILED";
        const outcome = {
          step_id: stepId,
          agent_id: step.agent_id,
          capability: step.capability,
          status,
          elapsed_ms: Date.now() - startedAt,
          result: status === "SUCCEEDED" ? clone(rawResult?.result ?? {}) : {},
          ...(status === "SUCCEEDED" ? {} : {
            error: clone(rawResult?.error ?? {
              code: status === "FAILED" ? "AGENT_STEP_FAILED" : `AGENT_STEP_${status}`,
              message: `步骤返回 ${status}`,
            }),
          }),
        };
        outcomesById.set(stepId, outcome);
        stepOutcomes.push(outcome);
        if (status !== "SUCCEEDED") failureSeen = true;
      } catch (error) {
        const outcome = {
          step_id: stepId,
          agent_id: step.agent_id,
          capability: step.capability,
          status: "FAILED",
          elapsed_ms: Date.now() - startedAt,
          result: {},
          error: { code: "AGENT_STEP_EXCEPTION", message: error instanceof Error ? error.message : String(error) },
        };
        outcomesById.set(stepId, outcome);
        stepOutcomes.push(outcome);
        failureSeen = true;
      }
    }

    const failed = stepOutcomes.some((step) => ["FAILED", "DENIED", "CHALLENGE", "TIMEOUT"].includes(step.status));
    const executionStatus = failed ? "FAILED" : "SUCCEEDED";
    return {
      ...validation,
      execution_status: executionStatus,
      execution_performed: executionPerformed,
      steps: stepOutcomes,
    };
  }
}

export { handlerKey as agentCapabilityHandlerKey };
