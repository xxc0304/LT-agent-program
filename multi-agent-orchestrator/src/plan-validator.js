import { createHash } from "node:crypto";

const PLAN_SCHEMA_VERSION = "0.1";
const PLAN_DECISIONS = Object.freeze({
  ALLOW: "ALLOW",
  NEED_CONFIRMATION: "NEED_CONFIRMATION",
  DENY: "DENY",
});

const DEFAULT_ACTION_CONFLICT_GROUPS = Object.freeze({
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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fingerprintAgentPlan(plan) {
  return createHash("sha256").update(stableStringify(plan)).digest("hex");
}

function normalizeCapabilities(capabilities) {
  if (Array.isArray(capabilities)) {
    return new Map(capabilities.map((capability) => [capability, { effect: "read_only" }]));
  }
  if (!isRecord(capabilities)) return new Map();
  return new Map(Object.entries(capabilities).map(([name, descriptor]) => [
    name,
    typeof descriptor === "string" ? { effect: descriptor } : { ...descriptor },
  ]));
}

function validatePlanShape(plan, maxSteps) {
  const errors = [];
  if (!isRecord(plan)) return ["plan 必须是 JSON 对象"];
  if (plan.schema_version !== PLAN_SCHEMA_VERSION) errors.push(`schema_version 必须为 ${PLAN_SCHEMA_VERSION}`);
  for (const field of ["plan_id", "trace_id", "goal"]) {
    if (typeof plan[field] !== "string" || !plan[field].trim()) errors.push(`${field} 必须是非空字符串`);
  }
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    errors.push("steps 必须是非空数组");
    return errors;
  }
  if (plan.steps.length > maxSteps) errors.push(`steps 不能超过 ${maxSteps} 个`);
  return errors;
}

function getStepReference(step) {
  return step?.action?.target_ref?.device_id ?? step?.action?.resource_id ?? null;
}

function getStepActionName(step) {
  return step?.action?.name ?? step?.action?.action ?? null;
}

function getConflictGroup(step, actionConflictGroups) {
  return step?.action?.conflict_group
    ?? actionConflictGroups[getStepActionName(step)]
    ?? null;
}

function operationFingerprint(step) {
  return stableStringify({
    action: getStepActionName(step),
    parameters: step?.action?.parameters ?? {},
  });
}

function buildStepGraph(steps) {
  const byId = new Map();
  const errors = [];

  for (const [index, step] of steps.entries()) {
    if (!isRecord(step)) {
      errors.push(`steps[${index}] 必须是 JSON 对象`);
      continue;
    }
    if (typeof step.step_id !== "string" || !step.step_id.trim()) {
      errors.push(`steps[${index}].step_id 必须是非空字符串`);
      continue;
    }
    if (byId.has(step.step_id)) errors.push(`step_id 重复：${step.step_id}`);
    else byId.set(step.step_id, step);
  }

  for (const step of byId.values()) {
    if (typeof step.agent_id !== "string" || !step.agent_id.trim()) errors.push(`${step.step_id}.agent_id 必须是非空字符串`);
    if (typeof step.capability !== "string" || !step.capability.trim()) errors.push(`${step.step_id}.capability 必须是非空字符串`);
    if (!Array.isArray(step.depends_on ?? [])) errors.push(`${step.step_id}.depends_on 必须是数组`);
    if (!Array.isArray(step.evidence_refs ?? [])) errors.push(`${step.step_id}.evidence_refs 必须是数组`);
    if (step.input !== undefined && !isRecord(step.input)) errors.push(`${step.step_id}.input 必须是 JSON 对象`);
  }

  for (const step of byId.values()) {
    for (const dependency of step.depends_on ?? []) {
      if (typeof dependency !== "string" || !byId.has(dependency)) {
        errors.push(`${step.step_id} 依赖了不存在的步骤：${dependency}`);
      } else if (dependency === step.step_id) {
        errors.push(`${step.step_id} 不能依赖自身`);
      }
    }
  }

  return { byId, errors };
}

function topologicalSort(byId) {
  const indegree = new Map([...byId.keys()].map((stepId) => [stepId, 0]));
  const outgoing = new Map([...byId.keys()].map((stepId) => [stepId, []]));
  for (const [stepId, step] of byId) {
    for (const dependency of step.depends_on ?? []) {
      if (!byId.has(dependency)) continue;
      indegree.set(stepId, indegree.get(stepId) + 1);
      outgoing.get(dependency).push(stepId);
    }
  }

  const ready = [...byId.keys()].filter((stepId) => indegree.get(stepId) === 0);
  const ordered = [];
  while (ready.length > 0) {
    const stepId = ready.shift();
    ordered.push(stepId);
    for (const next of outgoing.get(stepId)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) ready.push(next);
    }
  }
  return ordered.length === byId.size ? ordered : null;
}

function dependsTransitivelyOn(stepId, ancestorId, byId, seen = new Set()) {
  if (stepId === ancestorId) return true;
  if (seen.has(stepId)) return false;
  seen.add(stepId);
  const step = byId.get(stepId);
  return (step?.depends_on ?? []).some((dependency) => dependsTransitivelyOn(dependency, ancestorId, byId, seen));
}

function validateEvidence(step, capability, evidenceById, now, maxClockSkewMs, findings) {
  const refs = step.evidence_refs ?? [];
  const evidence = [];
  for (const evidenceId of refs) {
    if (typeof evidenceId !== "string" || !evidenceById.has(evidenceId)) {
      findings.push({
        code: "EVIDENCE_NOT_FOUND",
        decision: PLAN_DECISIONS.DENY,
        step_id: step.step_id,
        message: `证据引用不存在或未由可信运行时提供：${evidenceId}`,
      });
      continue;
    }
    evidence.push(evidenceById.get(evidenceId));
  }

  for (const requirement of capability.required_evidence ?? []) {
    const match = evidence.find((item) => item.evidence_type === requirement.evidence_type);
    if (!match) {
      findings.push({
        code: "REQUIRED_EVIDENCE_MISSING",
        decision: PLAN_DECISIONS.DENY,
        step_id: step.step_id,
        message: `缺少必需证据：${requirement.evidence_type}`,
      });
      continue;
    }
    if (requirement.trusted === true && match.trust_level !== "trusted") {
      findings.push({
        code: "EVIDENCE_NOT_TRUSTED",
        decision: PLAN_DECISIONS.DENY,
        step_id: step.step_id,
        evidence_id: match.evidence_id,
        message: `证据 ${match.evidence_id} 不属于可信来源`,
      });
    }
    if (Array.isArray(requirement.allowed_sources)
      && !requirement.allowed_sources.includes(match.source_type)) {
      findings.push({
        code: "EVIDENCE_SOURCE_NOT_ALLOWED",
        decision: PLAN_DECISIONS.DENY,
        step_id: step.step_id,
        evidence_id: match.evidence_id,
        message: `证据 ${match.evidence_id} 的来源类型不在该能力允许范围内`,
      });
    }
    const observedAt = Date.parse(match.observed_at);
    if (!Number.isFinite(observedAt)) {
      findings.push({
        code: "EVIDENCE_TIME_INVALID",
        decision: PLAN_DECISIONS.DENY,
        step_id: step.step_id,
        evidence_id: match.evidence_id,
        message: `证据 ${match.evidence_id} 缺少有效 observed_at`,
      });
      continue;
    }
    if (observedAt > now + maxClockSkewMs) {
      findings.push({
        code: "EVIDENCE_FROM_FUTURE",
        decision: PLAN_DECISIONS.DENY,
        step_id: step.step_id,
        evidence_id: match.evidence_id,
        message: `证据 ${match.evidence_id} 的时间超出允许的时钟偏差`,
      });
    }
    if (Number.isFinite(requirement.max_age_ms) && now - observedAt > requirement.max_age_ms) {
      findings.push({
        code: "EVIDENCE_STALE",
        decision: PLAN_DECISIONS.DENY,
        step_id: step.step_id,
        evidence_id: match.evidence_id,
        message: `证据 ${match.evidence_id} 已过期`,
      });
    }
    if (match.expires_at) {
      const expiresAt = Date.parse(match.expires_at);
      if (!Number.isFinite(expiresAt) || expiresAt <= now) {
        findings.push({
          code: "EVIDENCE_EXPIRED",
          decision: PLAN_DECISIONS.DENY,
          step_id: step.step_id,
          evidence_id: match.evidence_id,
          message: `证据 ${match.evidence_id} 的 expires_at 无效或已过期`,
        });
      }
    }
  }
}

/**
 * Deterministic safety gate for a candidate agent plan. It never calls an LLM
 * and never executes tools: model-produced plans are proposals only.
 */
export class AgentPlanValidator {
  constructor({
    clock = () => Date.now(),
    maxSteps = 12,
    maxClockSkewMs = 60_000,
    agents = [],
    householdPolicy = {},
    actionConflictGroups = DEFAULT_ACTION_CONFLICT_GROUPS,
  } = {}) {
    this.clock = clock;
    this.maxSteps = maxSteps;
    this.maxClockSkewMs = maxClockSkewMs;
    this.agents = new Map();
    this.householdPolicy = {
      allowedDeviceIds: householdPolicy.allowedDeviceIds ?? [],
      allowedActions: householdPolicy.allowedActions ?? [],
      autoAllowedDeviceActions: householdPolicy.autoAllowedDeviceActions ?? [],
      blockedActions: householdPolicy.blockedActions ?? [],
    };
    this.actionConflictGroups = actionConflictGroups;
    for (const agent of agents) this.registerAgent(agent);
  }

  registerAgent({ agent_id, capabilities } = {}) {
    if (typeof agent_id !== "string" || !agent_id.trim()) throw new Error("agent_id 必须是非空字符串");
    this.agents.set(agent_id, normalizeCapabilities(capabilities));
    return { success: true, agent_id };
  }

  listAgents() {
    return [...this.agents.entries()].map(([agent_id, capabilities]) => ({
      agent_id,
      capabilities: [...capabilities.entries()].map(([name, descriptor]) => ({ name, ...clone(descriptor) })),
    }));
  }

  evaluate(plan, {
    evidence = [],
    approval = null,
  } = {}) {
    const shapeErrors = validatePlanShape(plan, this.maxSteps);
    if (shapeErrors.length > 0) {
      return {
        decision: PLAN_DECISIONS.DENY,
        plan_id: plan?.plan_id ?? null,
        findings: shapeErrors.map((message) => ({ code: "INVALID_PLAN", decision: PLAN_DECISIONS.DENY, message })),
        ordered_step_ids: [],
      };
    }

    const { byId, errors } = buildStepGraph(plan.steps);
    const findings = errors.map((message) => ({ code: "INVALID_PLAN_GRAPH", decision: PLAN_DECISIONS.DENY, message }));
    const orderedStepIds = topologicalSort(byId);
    if (!orderedStepIds) {
      findings.push({ code: "PLAN_DEPENDENCY_CYCLE", decision: PLAN_DECISIONS.DENY, message: "步骤依赖形成循环，无法执行" });
    }

    const evidenceById = new Map();
    for (const item of evidence) {
      if (isRecord(item) && typeof item.evidence_id === "string" && !evidenceById.has(item.evidence_id)) {
        evidenceById.set(item.evidence_id, item);
      }
    }
    const now = this.clock();
    const approvalMatchesPlan = approval?.plan_id === plan.plan_id
      && approval?.plan_fingerprint === fingerprintAgentPlan(plan)
      && approval?.approved === true;

    for (const step of byId.values()) {
      const capabilities = this.agents.get(step.agent_id);
      if (!capabilities) {
        findings.push({
          code: "AGENT_NOT_REGISTERED",
          decision: PLAN_DECISIONS.DENY,
          step_id: step.step_id,
          message: `Agent 未登记：${step.agent_id}`,
        });
        continue;
      }
      const capability = capabilities.get(step.capability);
      if (!capability) {
        findings.push({
          code: "CAPABILITY_NOT_REGISTERED",
          decision: PLAN_DECISIONS.DENY,
          step_id: step.step_id,
          message: `Agent ${step.agent_id} 未登记能力 ${step.capability}`,
        });
        continue;
      }

      validateEvidence(step, capability, evidenceById, now, this.maxClockSkewMs, findings);

      if (capability.effect === "device_action") {
        const actionName = getStepActionName(step);
        const targetRef = getStepReference(step);
        if (!actionName || !targetRef) {
          findings.push({
            code: "DEVICE_ACTION_INCOMPLETE",
            decision: PLAN_DECISIONS.DENY,
            step_id: step.step_id,
            message: "设备动作必须提供 action.name 和 action.target_ref.device_id（或 action.resource_id）",
          });
          continue;
        }
        if (!this.householdPolicy.allowedDeviceIds.includes(targetRef)) {
          findings.push({
            code: "DEVICE_NOT_ALLOWLISTED",
            decision: PLAN_DECISIONS.DENY,
            step_id: step.step_id,
            target_ref: targetRef,
            message: `目标设备未在家庭白名单中：${targetRef}`,
          });
          continue;
        }
        if (!this.householdPolicy.allowedActions.includes(actionName)) {
          findings.push({
            code: "ACTION_NOT_ALLOWLISTED",
            decision: PLAN_DECISIONS.DENY,
            step_id: step.step_id,
            action: actionName,
            message: `动作未在家庭允许清单中：${actionName}`,
          });
          continue;
        }
        if (this.householdPolicy.blockedActions.includes(actionName)) {
          findings.push({
            code: "ACTION_BLOCKED_BY_POLICY",
            decision: PLAN_DECISIONS.DENY,
            step_id: step.step_id,
            message: `家庭策略禁止自动执行动作：${actionName}`,
          });
          continue;
        }
        const capabilityAutoAllowlist = Array.isArray(capability.auto_allowed_device_actions)
          ? capability.auto_allowed_device_actions
          : this.householdPolicy.autoAllowedDeviceActions;
        const autoAllowed = capabilityAutoAllowlist.some((item) =>
          item?.device_id === targetRef && item?.action === actionName);
        const requiresConfirmation = capability.requires_confirmation === true || !autoAllowed;
        if (requiresConfirmation && !approvalMatchesPlan) {
          findings.push({
            code: "USER_CONFIRMATION_REQUIRED",
            decision: PLAN_DECISIONS.NEED_CONFIRMATION,
            step_id: step.step_id,
            action: actionName,
            target_ref: targetRef,
            message: `动作 ${actionName} 未被家庭策略预先授权，需要对本计划进行明确确认`,
          });
        }
      } else if (capability.effect && !["read_only", "planning"].includes(capability.effect)) {
        findings.push({
          code: "UNSUPPORTED_EFFECT",
          decision: PLAN_DECISIONS.DENY,
          step_id: step.step_id,
          message: `当前校验器不支持副作用类型：${capability.effect}`,
        });
      }
    }

    const steps = [...byId.values()];
    for (let leftIndex = 0; leftIndex < steps.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < steps.length; rightIndex += 1) {
        const left = steps[leftIndex];
        const right = steps[rightIndex];
        const leftCapabilities = this.agents.get(left.agent_id);
        const rightCapabilities = this.agents.get(right.agent_id);
        if (leftCapabilities?.get(left.capability)?.effect !== "device_action"
          || rightCapabilities?.get(right.capability)?.effect !== "device_action") continue;
        const sameTarget = getStepReference(left) === getStepReference(right);
        const group = getConflictGroup(left, this.actionConflictGroups);
        const sameGroup = group && group === getConflictGroup(right, this.actionConflictGroups);
        const differentCommands = operationFingerprint(left) !== operationFingerprint(right);
        const explicitlyOrdered = dependsTransitivelyOn(left.step_id, right.step_id, byId)
          || dependsTransitivelyOn(right.step_id, left.step_id, byId);
        if (sameTarget && sameGroup && differentCommands && !explicitlyOrdered) {
          findings.push({
            code: "PLAN_RESOURCE_CONFLICT",
            decision: PLAN_DECISIONS.NEED_CONFIRMATION,
            step_ids: [left.step_id, right.step_id],
            resource_id: getStepReference(left),
            conflict_group: group,
            message: "计划中包含未声明先后关系的互斥设备动作；需要澄清或调整计划",
          });
        }
      }
    }

    const decision = findings.some((finding) => finding.decision === PLAN_DECISIONS.DENY)
      ? PLAN_DECISIONS.DENY
      : findings.some((finding) => finding.decision === PLAN_DECISIONS.NEED_CONFIRMATION)
        ? PLAN_DECISIONS.NEED_CONFIRMATION
        : PLAN_DECISIONS.ALLOW;

    return {
      decision,
      plan_id: plan.plan_id,
      trace_id: plan.trace_id,
      plan_fingerprint: fingerprintAgentPlan(plan),
      ordered_step_ids: orderedStepIds ?? [],
      findings,
      execution_performed: false,
    };
  }
}

export { PLAN_DECISIONS, PLAN_SCHEMA_VERSION };
