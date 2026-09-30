import { normalizeTaskAliases } from "../../common-contracts/task-compat.mjs";

const CONTRACT_VERSION = "0.1";
const CANONICAL_PRIORITIES = new Set(["P0", "P1", "P2", "P3", "P4"]);
const DATA_LEVELS = new Set(["L0", "L1", "L2", "L3"]);
const PRIVACY_LEVELS = new Set(["family", "sensitive", "restricted"]);
const EXECUTION_MODES = new Set(["local", "edge", "cloud"]);

const PRIORITY_RANK = Object.freeze({
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
  P4: 4,
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
});

function clone(value) {
  return structuredClone(value);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function taskOperationFingerprint(task) {
  const { task_id, trace_id, ...operation } = task;
  return stableStringify(operation);
}

async function settleWithin(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { timedOut: false, value: await promise };
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve(promise).then((value) => ({ timedOut: false, value })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      }),
    ]);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function priorityRank(priority) {
  return PRIORITY_RANK[priority] ?? 99;
}

function eventTraceId(event) {
  return event?.trace_id ?? `trace-${event?.event_id ?? Date.now()}`;
}

function validateEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return "事件必须是 JSON 对象";
  for (const field of ["event_id", "event_type", "payload"]) {
    if (event[field] === undefined) return `缺少事件字段：${field}`;
  }
  if (typeof event.event_id !== "string" || !event.event_id) return "event_id 必须是非空字符串";
  if (typeof event.event_type !== "string" || !event.event_type) return "event_type 必须是非空字符串";
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return "payload 必须是 JSON 对象";
  return null;
}

function validateTask(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) return "任务必须是 JSON 对象";
  for (const field of ["schema_version", "task_id", "task_type", "target_ref", "action", "priority", "deadline_ms", "resource_requirement", "privacy_level", "data_level", "idempotency_key", "trace_id"]) {
    if (task[field] === undefined) return `缺少任务字段：${field}`;
  }
  if (task.schema_version !== CONTRACT_VERSION) return `不支持的 schema_version：${task.schema_version}`;
  if (typeof task.task_id !== "string" || !task.task_id.trim()) return "task_id 必须是非空字符串";
  if (task.task_type !== "device_action") return "当前调度器只执行 device_action 任务";
  if (!task.target_ref || typeof task.target_ref !== "object" || Array.isArray(task.target_ref)
    || typeof task.target_ref.device_id !== "string" || !task.target_ref.device_id.trim()) {
    return "target_ref.device_id 必须是非空字符串";
  }
  if (typeof task.action !== "string" || !task.action.trim()) return "action 必须是非空字符串";
  if (!CANONICAL_PRIORITIES.has(task.priority)) return `不支持的 canonical priority：${task.priority}`;
  if (!Number.isInteger(task.deadline_ms) || task.deadline_ms < 0) return "deadline_ms 必须是非负整数";
  if (!DATA_LEVELS.has(task.data_level)) return `不支持的 data_level：${task.data_level}`;
  if (!PRIVACY_LEVELS.has(task.privacy_level)) return `不支持的 privacy_level：${task.privacy_level}`;
  if (!task.resource_requirement || typeof task.resource_requirement !== "object" || Array.isArray(task.resource_requirement)) {
    return "resource_requirement 必须是 JSON 对象";
  }
  if (!EXECUTION_MODES.has(task.resource_requirement.execution_mode)) return "resource_requirement.execution_mode 不合法";
  if (task.resource_requirement.capabilities !== undefined
    && (!Array.isArray(task.resource_requirement.capabilities)
      || task.resource_requirement.capabilities.some((capability) => typeof capability !== "string"))) {
    return "resource_requirement.capabilities 必须是字符串数组";
  }
  if (typeof task.idempotency_key !== "string" || !task.idempotency_key.trim()) return "idempotency_key 必须是非空字符串";
  if (typeof task.trace_id !== "string" || !task.trace_id.trim()) return "trace_id 必须是非空字符串";
  return null;
}

function newTrace(event, clock) {
  const traceId = eventTraceId(event);
  return {
    schema_version: CONTRACT_VERSION,
    trace_id: traceId,
    event_id: event?.event_id ?? null,
    source_agent: event?.source_agent ?? null,
    event_type: event?.event_type ?? null,
    status: "RECEIVED",
    agents_involved: event?.source_agent ? [event.source_agent] : [],
    stages: [],
    planned_tasks: [],
    receipts: [],
    errors: [],
    created_at: nowIso(clock),
    updated_at: nowIso(clock),
  };
}

/**
 * Small deterministic scheduler for the project MVP.
 * It routes Events to subscribed agents, orders Tasks by priority/deadline,
 * invokes the target Agent, and records a trace that can be shown to users.
 */
export class MultiAgentScheduler {
  constructor({ clock = () => Date.now(), maxAttempts = 2, handlerTimeoutMs = 10000, taskTimeoutMs = 30000 } = {}) {
    this.clock = clock;
    this.maxAttempts = maxAttempts;
    this.handlerTimeoutMs = handlerTimeoutMs;
    this.taskTimeoutMs = taskTimeoutMs;
    this.agents = new Map();
    this.queue = [];
    this.sequence = 0;
    this.seenIdempotencyKeys = new Map();
    this.seenEvents = new Map();
    this.traces = new Map();
    this.executionLog = [];
  }

  registerAgent({ agent_id, manifest = {}, consumes = [], handleEvent, executeTask } = {}) {
    const id = agent_id ?? manifest.agent_id;
    if (!id) throw new Error("Agent 必须提供 agent_id");
    if (typeof handleEvent !== "function" && typeof executeTask !== "function") {
      throw new Error(`Agent ${id} 至少需要 handleEvent 或 executeTask`);
    }
    this.agents.set(id, {
      agent_id: id,
      manifest: clone(manifest),
      consumes: new Set(consumes),
      handleEvent,
      executeTask,
    });
    return { success: true, agent_id: id };
  }

  listAgents() {
    return [...this.agents.values()].map((agent) => ({
      agent_id: agent.agent_id,
      consumes: [...agent.consumes],
      capabilities: agent.manifest.capabilities ?? [],
      execution_mode: agent.manifest.execution_mode ?? null,
    }));
  }

  getTrace(traceId) {
    const trace = this.traces.get(traceId);
    return trace ? clone(trace) : null;
  }

  listTraces() {
    return [...this.traces.values()].map(clone);
  }

  getExecutionLog() {
    return clone(this.executionLog);
  }

  async handleEvent(event, { autoRun = true } = {}) {
    const validationError = validateEvent(event);
    const traceId = eventTraceId(event);
    if (validationError) {
      const trace = newTrace(event, this.clock);
      trace.status = "REJECTED";
      trace.errors.push({ code: "INVALID_EVENT", message: validationError });
      this.#stage(trace, "event_rejected", "scheduler", "failed", { error: validationError });
      this.traces.set(traceId, trace);
      return clone(trace);
    }

    const fingerprint = stableStringify(event);
    const previousEvent = this.seenEvents.get(event.event_id);
    if (previousEvent) {
      if (previousEvent.fingerprint !== fingerprint) {
        const rejected = newTrace(event, this.clock);
        rejected.status = "REJECTED";
        rejected.errors.push({ code: "EVENT_ID_CONFLICT", message: `event_id 已被不同内容使用：${event.event_id}` });
        this.#stage(rejected, "event_rejected", "scheduler", "failed", { error: "EVENT_ID_CONFLICT" });
        return clone(rejected);
      }
      const original = this.traces.get(previousEvent.trace_id);
      if (original) {
        this.#stage(original, "event_deduplicated", "scheduler", "skipped", { event_id: event.event_id });
        return clone(original);
      }
    }

    const trace = newTrace(event, this.clock);
    this.traces.set(traceId, trace);
    this.seenEvents.set(event.event_id, { fingerprint, trace_id: traceId });
    this.#stage(trace, "event_received", "scheduler", "ok", { event_type: event.event_type });

    const consumers = [...this.agents.values()]
      .filter((agent) => agent.consumes.has(event.event_type) || agent.consumes.has("*"))
      .filter((agent) => typeof agent.handleEvent === "function");

    if (consumers.length === 0) {
      trace.status = "NO_ROUTE";
      this.#stage(trace, "event_routing", "scheduler", "skipped", { reason: "NO_EVENT_CONSUMER" });
      this.#touch(trace);
      return clone(trace);
    }

    for (const agent of consumers) {
      this.#addAgent(trace, agent.agent_id);
      const startedAt = this.clock();
      let result;
      try {
        const outcome = await settleWithin(agent.handleEvent(event), this.handlerTimeoutMs);
        if (outcome.timedOut) {
          result = {
            status: "FAILED",
            tasks: [],
            error: {
              code: "AGENT_HANDLER_TIMEOUT",
              message: `Agent ${agent.agent_id} 事件处理超时`,
              side_effects_unknown: true,
            },
          };
        } else {
          result = outcome.value;
        }
      } catch (error) {
        result = {
          status: "FAILED",
          tasks: [],
          error: { code: "AGENT_HANDLER_ERROR", message: error.message },
        };
      }
      const status = result?.status ?? "FAILED";
      this.#stage(trace, "agent_invoked", agent.agent_id, status.toLowerCase(), {
        elapsed_ms: this.clock() - startedAt,
        planned_task_count: result?.tasks?.length ?? 0,
        error: result?.error ?? null,
      });
      if (result?.error) trace.errors.push({ agent_id: agent.agent_id, ...clone(result.error) });
      for (const task of result?.tasks ?? []) {
        const enqueueResult = this.enqueueTask(task, { trace_id: traceId, parent_agent: agent.agent_id });
        if (!enqueueResult.success) {
          trace.errors.push({
            agent_id: agent.agent_id,
            task_id: task?.task_id ?? null,
            ...clone(enqueueResult.error),
          });
          this.#stage(trace, "task_rejected", agent.agent_id, "failed", {
            task_id: task?.task_id ?? null,
            error: enqueueResult.error,
          });
          continue;
        }
        if (enqueueResult.deduplicated) {
          this.#stage(trace, "task_deduplicated", agent.agent_id, "skipped", {
            task_id: task.task_id,
            idempotency_key: task.idempotency_key,
          });
          continue;
        }
        this.#stage(trace, "task_enqueued", agent.agent_id, "ok", {
          task_id: task.task_id,
          target_agent: task.target_agent ?? task.target,
          priority: task.priority,
        });
      }
    }

    if (autoRun) await this.drain();
    else this.#setPendingStatus(trace);
    this.#touch(trace);
    return clone(trace);
  }

  enqueueTask(task, { trace_id = task?.trace_id, parent_agent = null } = {}) {
    const normalized = normalizeTaskAliases(task, { requireSource: true });
    const validationError = normalized.error ?? validateTask(normalized.task);
    if (validationError) return { success: false, error: { code: "INVALID_TASK", message: validationError } };
    const canonicalTask = normalized.task;
    const previous = this.seenIdempotencyKeys.get(canonicalTask.idempotency_key);
    if (previous) {
      if (previous.fingerprint !== taskOperationFingerprint(canonicalTask)) {
        return { success: false, error: { code: "IDEMPOTENCY_KEY_CONFLICT", message: `幂等键已被不同任务内容使用：${canonicalTask.idempotency_key}` } };
      }
      return { success: true, deduplicated: true, previous_task_id: previous.task_id };
    }

    const traceId = trace_id ?? canonicalTask.trace_id;
    const item = {
      task: clone({ ...canonicalTask, trace_id: traceId }),
      trace_id: traceId,
      parent_agent,
      attempt: 1,
      sequence: this.sequence++,
      enqueuedAt: this.clock(),
    };
    this.queue.push(item);
    this.seenIdempotencyKeys.set(canonicalTask.idempotency_key, { task_id: canonicalTask.task_id, fingerprint: taskOperationFingerprint(canonicalTask) });
    const trace = this.#ensureTrace(traceId, canonicalTask, parent_agent);
    if (!trace.planned_tasks.some((planned) => planned.task_id === canonicalTask.task_id)) {
      trace.planned_tasks.push({
        task_id: canonicalTask.task_id,
        target_agent: canonicalTask.target_agent,
        device_id: canonicalTask.target_ref?.device_id ?? null,
        priority: canonicalTask.priority,
        idempotency_key: canonicalTask.idempotency_key,
      });
    }
    return { success: true, deduplicated: false, task_id: canonicalTask.task_id };
  }

  async drain() {
    const processed = [];
    while (this.queue.length > 0) {
      this.queue.sort((a, b) => {
        const priority = priorityRank(a.task.priority) - priorityRank(b.task.priority);
        if (priority !== 0) return priority;
        const deadline = (a.task.deadline_ms ?? Number.MAX_SAFE_INTEGER) - (b.task.deadline_ms ?? Number.MAX_SAFE_INTEGER);
        return deadline || a.sequence - b.sequence;
      });

      const item = this.queue.shift();
      const task = item.task;
      const trace = this.#ensureTrace(item.trace_id, task, item.parent_agent);
      const targetAgentId = task.target_agent ?? task.target;
      const target = this.agents.get(targetAgentId);
      this.#addAgent(trace, targetAgentId);
      if (this.clock() - item.enqueuedAt > task.deadline_ms) {
        const receipt = {
          schema_version: CONTRACT_VERSION,
          task_id: task.task_id,
          target_agent: targetAgentId,
          status: "TIMEOUT",
          retryable: false,
          completed_at: nowIso(this.clock),
          trace_id: item.trace_id,
          result: {},
          error: {
            code: "DEADLINE_EXCEEDED",
            message: `任务在开始执行前已超过 ${task.deadline_ms}ms 截止时限`,
            side_effects_unknown: false,
          },
        };
        trace.receipts.push(receipt);
        this.#stage(trace, "task_expired", targetAgentId, "timeout", { task_id: task.task_id, elapsed_ms: this.clock() - item.enqueuedAt });
        this.executionLog.push({ trace_id: item.trace_id, task_id: task.task_id, target_agent: targetAgentId, attempt: item.attempt, status: receipt.status });
        processed.push({ task: clone(task), receipt });
        this.#touch(trace);
        continue;
      }
      this.#stage(trace, "task_dispatched", targetAgentId, target ? "started" : "failed", {
        task_id: task.task_id,
        device_id: task.target_ref?.device_id ?? null,
        priority: task.priority,
        attempt: item.attempt,
      });

      let receipt;
      if (!target || typeof target.executeTask !== "function") {
        receipt = {
          schema_version: CONTRACT_VERSION,
          task_id: task.task_id,
          target_agent: targetAgentId,
          status: "FAILED",
          completed_at: nowIso(this.clock),
          trace_id: item.trace_id,
          result: {},
          error: { code: "TARGET_AGENT_UNAVAILABLE", message: `目标 Agent 不可用：${targetAgentId}` },
        };
      } else {
        try {
          const outcome = await settleWithin(target.executeTask(task), this.taskTimeoutMs);
          if (outcome.timedOut) {
            const timeoutRetrySafe = target.manifest.timeout_retry_safe === true;
            receipt = {
              schema_version: CONTRACT_VERSION,
              task_id: task.task_id,
              target_agent: targetAgentId,
              status: "TIMEOUT",
              retryable: timeoutRetrySafe,
              completed_at: nowIso(this.clock),
              trace_id: item.trace_id,
              result: {},
              error: {
                code: "TARGET_AGENT_TIMEOUT",
                message: `目标 Agent ${targetAgentId} 执行超时`,
                side_effects_unknown: true,
              },
            };
          } else {
            receipt = outcome.value;
          }
        } catch (error) {
          receipt = {
            schema_version: CONTRACT_VERSION,
            task_id: task.task_id,
            target_agent: targetAgentId,
            status: "FAILED",
            completed_at: nowIso(this.clock),
            trace_id: item.trace_id,
            result: {},
            error: { code: "TARGET_AGENT_ERROR", message: error.message, side_effects_unknown: true },
          };
        }
      }

      receipt = clone(receipt ?? {
        task_id: task.task_id,
        target_agent: targetAgentId,
        status: "FAILED",
        error: { code: "EMPTY_RECEIPT", message: "目标 Agent 未返回回执" },
      });
      trace.receipts.push(receipt);
      const retryable = receipt.status === "RETRYABLE" || (receipt.status === "TIMEOUT" && receipt.retryable === true);
      if (retryable && item.attempt < this.maxAttempts) {
        this.queue.push({ ...item, attempt: item.attempt + 1, sequence: this.sequence++ });
        this.#stage(trace, "task_retry_scheduled", targetAgentId, "retryable", {
          task_id: task.task_id,
          attempt: item.attempt + 1,
          error: receipt.error ?? null,
        });
      } else {
        this.#stage(trace, "task_completed", targetAgentId, String(receipt.status ?? "FAILED").toLowerCase(), {
          task_id: task.task_id,
          attempt: item.attempt,
          error: receipt.error ?? null,
        });
        this.executionLog.push({
          trace_id: item.trace_id,
          task_id: task.task_id,
          target_agent: targetAgentId,
          attempt: item.attempt,
          status: receipt.status,
        });
      }
      processed.push({ task: clone(task), receipt });
      this.#touch(trace);
    }

    for (const trace of this.traces.values()) this.#finalizeTrace(trace);
    return clone(processed);
  }

  #ensureTrace(traceId, task = {}, parentAgent = null) {
    let trace = this.traces.get(traceId);
    if (!trace) {
      trace = newTrace({
        event_id: null,
        event_type: "task_dispatch",
        source_agent: parentAgent,
        trace_id: traceId,
      }, this.clock);
      trace.status = "PLANNED";
      this.traces.set(traceId, trace);
    }
    if (task.source_agent) this.#addAgent(trace, task.source_agent);
    return trace;
  }

  #addAgent(trace, agentId) {
    if (agentId && !trace.agents_involved.includes(agentId)) trace.agents_involved.push(agentId);
  }

  #stage(trace, stage, agentId, status, details = {}) {
    trace.stages.push({
      stage,
      agent_id: agentId,
      status,
      occurred_at: nowIso(this.clock),
      ...clone(details),
    });
    this.#touch(trace);
  }

  #touch(trace) {
    trace.updated_at = nowIso(this.clock);
  }

  #setPendingStatus(trace) {
    trace.status = trace.planned_tasks.length > 0 ? "PLANNED" : "NO_ACTION";
  }

  #finalizeTrace(trace) {
    if (trace.planned_tasks.length === 0) {
      if (trace.errors.length > 0) trace.status = "FAILED";
      else if (["RECEIVED", "PLANNED"].includes(trace.status)) trace.status = "NO_ACTION";
      return;
    }
    const receiptsByTask = new Map(trace.receipts.map((receipt) => [receipt.task_id, receipt]));
    if (trace.planned_tasks.some((task) => !receiptsByTask.has(task.task_id))) {
      trace.status = "PLANNED";
      return;
    }
    const statuses = [...receiptsByTask.values()].map((receipt) => receipt.status);
    if (statuses.every((status) => status === "SUCCEEDED")) trace.status = "SUCCEEDED";
    else if (statuses.includes("CHALLENGE")) trace.status = "CHALLENGE";
    else if (statuses.includes("DENIED")) trace.status = "DENIED";
    else if (statuses.includes("TIMEOUT")) trace.status = "TIMEOUT";
    else trace.status = "FAILED";
  }
}

export const SCHEDULER_PRIORITY_RANK = PRIORITY_RANK;
