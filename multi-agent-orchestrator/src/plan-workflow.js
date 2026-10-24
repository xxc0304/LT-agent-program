import { randomUUID } from "node:crypto";

function clone(value) {
  return structuredClone(value);
}

function hasActorIdentity(actor) {
  return actor && typeof actor.id === "string" && actor.id.trim().length > 0;
}

/**
 * Process-local approval workflow for candidate Agent plans.
 * Authentication/authorization and trusted evidence retrieval are injected by
 * the host application. `onStateChange` lets the host persist a safe summary;
 * this class itself does not define a storage format or auth boundary.
 */
export class AgentPlanWorkflow {
  constructor({
    validator,
    executor,
    authorizeActor,
    evidenceProvider,
    clock = () => Date.now(),
    approvalTtlMs = 5 * 60_000,
    onStateChange = null,
  } = {}) {
    if (!validator || typeof validator.evaluate !== "function") {
      throw new Error("AgentPlanWorkflow 必须接收 AgentPlanValidator");
    }
    if (!executor || typeof executor.execute !== "function") {
      throw new Error("AgentPlanWorkflow 必须接收 AgentPlanExecutor");
    }
    if (executor.validator !== validator) {
      throw new Error("AgentPlanWorkflow 与 AgentPlanExecutor 必须使用同一个校验器实例");
    }
    if (typeof authorizeActor !== "function") {
      throw new Error("AgentPlanWorkflow 必须接收可信的 authorizeActor 回调");
    }
    if (typeof evidenceProvider !== "function") {
      throw new Error("AgentPlanWorkflow 必须接收可信的 evidenceProvider 回调");
    }
    if (!Number.isFinite(approvalTtlMs) || approvalTtlMs <= 0) {
      throw new Error("approvalTtlMs 必须是正数");
    }

    this.validator = validator;
    this.executor = executor;
    this.authorizeActor = authorizeActor;
    this.evidenceProvider = evidenceProvider;
    this.clock = clock;
    this.approvalTtlMs = approvalTtlMs;
    this.onStateChange = onStateChange;
    this.records = new Map();
  }

  async submit(plan, { evidence = [] } = {}) {
    const safePlan = clone(plan);
    const safeEvidence = clone(evidence);
    if (!Array.isArray(safeEvidence)) {
      return {
        workflow_status: "DENIED",
        decision: "DENY",
        findings: [{ code: "INVALID_EVIDENCE_CONTEXT", message: "evidence 必须是数组" }],
        execution_performed: false,
      };
    }

    const validation = this.validator.evaluate(safePlan, { evidence: safeEvidence });
    if (validation.decision === "DENY") {
      return { ...validation, workflow_status: "DENIED", execution_performed: false };
    }
    // A resource conflict is not something a user should "approve". The
    // candidate must first be clarified/replanned so the executor never has
    // to guess an ordering between mutually exclusive actions.
    const resourceConflicts = validation.findings?.filter(
      (finding) => finding.code === "PLAN_RESOURCE_CONFLICT",
    ) ?? [];
    if (resourceConflicts.length > 0) {
      return {
        ...validation,
        workflow_status: "CLARIFICATION_REQUIRED",
        clarification: {
          required: true,
          reason: "RESOURCE_CONFLICT",
          message: "计划包含同一设备的互斥动作；请先询问用户期望的动作或先后顺序，再重新提交计划。此版本不会执行或接受对冲突计划的批准。",
          conflicts: clone(resourceConflicts),
        },
        execution_performed: false,
      };
    }
    if (validation.decision === "NEED_CONFIRMATION") {
      return this._createPending(safePlan, safeEvidence, validation);
    }

    const execution = await this.executor.execute(safePlan, { evidence: safeEvidence });
    if (execution.decision === "NEED_CONFIRMATION") {
      return this._createPending(safePlan, safeEvidence, execution);
    }
    if (execution.decision === "DENY") {
      return { ...execution, workflow_status: "DENIED", execution_performed: false };
    }
    return {
      ...execution,
      workflow_status: execution.execution_status === "SUCCEEDED" ? "COMPLETED" : "EXECUTION_FAILED",
      ...(execution.execution_status !== "SUCCEEDED" && execution.execution_performed
        ? { partial_effect_possible: true }
        : {}),
    };
  }

  getApproval(approvalId) {
    const record = this.records.get(approvalId);
    if (!record) return { workflow_status: "NOT_FOUND", approval_id: approvalId };
    this._expireIfDue(record);
    return this._approvalView(record);
  }

  listPending() {
    for (const record of this.records.values()) this._expireIfDue(record);
    return [...this.records.values()]
      .filter((record) => record.status === "WAITING_FOR_APPROVAL")
      .map((record) => this._approvalView(record));
  }

  sweepExpired() {
    let expired = 0;
    for (const record of this.records.values()) {
      if (this._expireIfDue(record)) expired += 1;
    }
    return { expired };
  }

  async approve(approvalId, { actor } = {}) {
    const record = this.records.get(approvalId);
    if (!record) return { workflow_status: "NOT_FOUND", approval_id: approvalId };
    this._expireIfDue(record);
    if (record.status === "APPROVING") {
      return { workflow_status: "APPROVAL_IN_PROGRESS", approval_id: approvalId };
    }
    if (record.status !== "WAITING_FOR_APPROVAL") return this._terminalResult(record);
    if (!hasActorIdentity(actor)) {
      return { workflow_status: "AUTHENTICATION_REQUIRED", approval_id: approvalId };
    }

    record.status = "APPROVING";
    if (!await this._persist(record)) {
      record.status = "WAITING_FOR_APPROVAL";
      return { workflow_status: "APPROVAL_STATE_PERSIST_FAILED", approval_id: approvalId, execution_performed: false };
    }
    const authorized = await this._authorize(record, actor, "approve");
    if (!authorized.success) {
      if (this._expireIfDue(record, true)) return this._terminalResult(record);
      record.status = "WAITING_FOR_APPROVAL";
      await this._persist(record);
      return { workflow_status: authorized.status, approval_id: approvalId };
    }
    if (this._expireIfDue(record, true)) return this._terminalResult(record);

    let evidence;
    try {
      evidence = await this.evidenceProvider({
        phase: "approval",
        plan: clone(record.plan),
        previousEvidence: clone(record.evidence),
      });
      if (!Array.isArray(evidence)) throw new Error("evidenceProvider 必须返回数组");
      evidence = clone(evidence);
    } catch (error) {
      if (this._expireIfDue(record, true)) return this._terminalResult(record);
      record.status = "WAITING_FOR_APPROVAL";
      const persisted = await this._persist(record);
      return {
        workflow_status: persisted ? "EVIDENCE_REFRESH_FAILED" : "APPROVAL_STATE_PERSIST_FAILED",
        approval_id: approvalId,
        ...(persisted ? { message: error instanceof Error ? error.message : String(error) } : { execution_performed: false }),
      };
    }
    if (this._expireIfDue(record, true)) return this._terminalResult(record);

    const approval = {
      plan_id: record.plan.plan_id,
      plan_fingerprint: record.planFingerprint,
      approved: true,
    };
    record.status = "EXECUTING";
    if (!await this._persist(record)) {
      record.status = "RECOVERY_REQUIRED";
      record.result = {
        workflow_status: "APPROVAL_STATE_PERSIST_FAILED",
        approval_id: approvalId,
        execution_performed: false,
      };
      return clone(record.result);
    }
    try {
      const execution = await this.executor.execute(record.plan, { evidence, approval });
      const workflowStatus = execution.decision === "NEED_CONFIRMATION"
        ? "PLAN_REVISION_REQUIRED"
        : execution.decision === "DENY"
          ? "DENIED_AFTER_RECHECK"
          : execution.execution_status === "SUCCEEDED"
            ? "COMPLETED"
            : "EXECUTION_FAILED";
      record.status = workflowStatus;
      record.result = {
        ...execution,
        approval_id: approvalId,
        workflow_status: workflowStatus,
        ...(workflowStatus === "PLAN_REVISION_REQUIRED"
          ? { message: "重新校验后仍需澄清；请调整候选计划并重新提交，不能重复批准同一计划" }
          : {}),
        ...(workflowStatus === "EXECUTION_FAILED" && execution.execution_performed
          ? { partial_effect_possible: true }
          : {}),
      };
      if (!await this._persist(record)) record.result.persistence_warning = "执行结果无法写入确认状态文件；如进程随后重启，请把设备当前状态视为待核对。";
      return clone(record.result);
    } catch (error) {
      record.status = "EXECUTION_UNCERTAIN";
      record.result = {
        workflow_status: "EXECUTION_UNCERTAIN",
        approval_id: approvalId,
        plan_id: record.plan.plan_id,
        execution_uncertain: true,
        message: error instanceof Error ? error.message : String(error),
      };
      await this._persist(record);
      return clone(record.result);
    }
  }

  async reject(approvalId, { actor } = {}) {
    const record = this.records.get(approvalId);
    if (!record) return { workflow_status: "NOT_FOUND", approval_id: approvalId };
    this._expireIfDue(record);
    if (record.status === "APPROVING" || record.status === "REJECTING") {
      return { workflow_status: "DECISION_IN_PROGRESS", approval_id: approvalId };
    }
    if (record.status !== "WAITING_FOR_APPROVAL") return this._terminalResult(record);
    if (!hasActorIdentity(actor)) {
      return { workflow_status: "AUTHENTICATION_REQUIRED", approval_id: approvalId };
    }

    record.status = "REJECTING";
    if (!await this._persist(record)) {
      record.status = "WAITING_FOR_APPROVAL";
      return { workflow_status: "APPROVAL_STATE_PERSIST_FAILED", approval_id: approvalId, execution_performed: false };
    }
    const authorized = await this._authorize(record, actor, "reject");
    if (!authorized.success) {
      if (this._expireIfDue(record, true)) return this._terminalResult(record);
      record.status = "WAITING_FOR_APPROVAL";
      await this._persist(record);
      return { workflow_status: authorized.status, approval_id: approvalId };
    }
    if (this._expireIfDue(record, true)) return this._terminalResult(record);

    record.status = "REJECTED";
    record.result = {
      workflow_status: "REJECTED",
      approval_id: approvalId,
      plan_id: record.plan.plan_id,
      execution_performed: false,
    };
    await this._persist(record);
    return clone(record.result);
  }

  async _createPending(plan, evidence, validation) {
    const approvalId = randomUUID();
    const createdAt = this.clock();
    const record = {
      approvalId,
      status: "WAITING_FOR_APPROVAL",
      plan: clone(plan),
      evidence: clone(evidence),
      planFingerprint: validation.plan_fingerprint,
      validation: clone(validation),
      createdAt,
      expiresAt: createdAt + this.approvalTtlMs,
      result: null,
    };
    this.records.set(approvalId, record);
    if (!await this._persist(record)) {
      this.records.delete(approvalId);
      return {
        workflow_status: "APPROVAL_STATE_PERSIST_FAILED",
        decision: "DENY",
        approval_id: approvalId,
        execution_performed: false,
        message: "待确认项未能安全持久化，因此没有创建可批准项。",
      };
    }
    return {
      ...clone(validation),
      workflow_status: record.status,
      approval: this._approvalView(record),
      execution_performed: false,
    };
  }

  async _persist(record) {
    if (typeof this.onStateChange !== "function") return true;
    try {
      const result = await this.onStateChange({
        approval_id: record.approvalId,
        status: record.status,
        plan: clone(record.plan),
        plan_fingerprint: record.planFingerprint,
        created_at_ms: record.createdAt,
        expires_at_ms: record.expiresAt,
      });
      return result !== false;
    } catch {
      return false;
    }
  }

  async _authorize(record, actor, action) {
    try {
      const allowed = await this.authorizeActor({
        actor: clone(actor),
        action,
        approval_id: record.approvalId,
        plan_id: record.plan.plan_id,
        plan_fingerprint: record.planFingerprint,
      });
      return allowed === true
        ? { success: true }
        : { success: false, status: "AUTHORIZATION_DENIED" };
    } catch {
      return { success: false, status: "AUTHORIZATION_UNAVAILABLE" };
    }
  }

  _expireIfDue(record, includeInProgress = false) {
    if (record.status !== "WAITING_FOR_APPROVAL"
      && !(includeInProgress && ["APPROVING", "REJECTING"].includes(record.status))) return false;
    if (this.clock() < record.expiresAt) return false;
    record.status = "EXPIRED_NO_ACTION";
    record.result = {
      workflow_status: "EXPIRED_NO_ACTION",
      approval_id: record.approvalId,
      plan_id: record.plan.plan_id,
      execution_performed: false,
    };
    return true;
  }

  _approvalView(record) {
    return {
      approval_id: record.approvalId,
      workflow_status: record.status,
      plan_id: record.plan.plan_id ?? null,
      plan_fingerprint: record.planFingerprint,
      goal: record.plan.goal ?? "",
      created_at: new Date(record.createdAt).toISOString(),
      expires_at: new Date(record.expiresAt).toISOString(),
      findings: clone(record.validation.findings ?? []),
      steps: (record.plan.steps ?? []).map((step) => ({
        step_id: step.step_id,
        agent_id: step.agent_id,
        capability: step.capability,
        ...(step.action ? {
          action: {
            name: step.action.name ?? step.action.action ?? null,
            target_ref: clone(step.action.target_ref ?? step.action.resource_id ?? null),
          },
        } : {}),
      })),
    };
  }

  _terminalResult(record) {
    return record.result
      ? clone(record.result)
      : { workflow_status: record.status, approval_id: record.approvalId };
  }
}
