import { readFileSync } from "node:fs";
import { MockHomeAssistant } from "./mock-ha.js";
import { createIndependentLearningEnergyWorkflow } from "./independent-learning-energy-workflow.js";
import { createOrchestratorBridge } from "./orchestrator-bridge.js";
import { createDeviceToolRuntime } from "./tools.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function createObservation(now, overrides = {}) {
  return {
    observation_id: "mock-observation-study-room-001",
    area: "living_room",
    observed_at: new Date(now - 30_000).toISOString(),
    behavior: "away_from_desk",
    presence: "away_from_desk",
    confidence: 0.94,
    duration_ms: 600_000,
    needs_review: false,
    annotation_scope: "individual",
    target_child_specified: true,
    evidence: "仅用于本地模拟的结构化观测摘要。",
    ...overrides,
  };
}

function createLearningEvent(observation, traceId, eventId) {
  return {
    schema_version: "0.1",
    event_id: eventId,
    source_agent: "learning-companion",
    event_type: "learning_behavior",
    occurred_at: observation.observed_at,
    received_at: new Date().toISOString(),
    confidence: observation.confidence,
    needs_review: observation.needs_review,
    privacy_level: "restricted",
    data_level: "L3",
    trace_id: traceId,
    source: { type: "learning_behavior_model", id: "learning-companion" },
    payload: {
      behavior: observation.behavior,
      presence: observation.presence,
      area: observation.area,
      duration_ms: observation.duration_ms,
      annotation_scope: observation.annotation_scope,
      target_child_specified: observation.target_child_specified,
      evidence: observation.evidence,
    },
  };
}

function createEnergyTask(traceId, taskId) {
  return {
    schema_version: "0.1",
    task_id: taskId,
    source_agent: "energy-saving",
    target_agent: "device-manager",
    task_type: "device_action",
    target_ref: { device_id: "light.living_room" },
    action: "turn_off",
    parameters: {},
    priority: "P3",
    deadline_ms: 30_000,
    resource_requirement: { execution_mode: "local", capabilities: ["device_control"] },
    privacy_level: "family",
    data_level: "L0",
    idempotency_key: `energy:${taskId}`,
    trace_id: traceId,
  };
}

async function runScenario({ name, trusted = true, observationOverrides = {}, energyDecision = "NO_ACTION", now }) {
  const observation = createObservation(now, observationOverrides);
  const traceId = `trace-mock-learning-energy-${name}`;
  const initialDevices = JSON.parse(readFileSync(new URL("../config/devices.json", import.meta.url), "utf8"))
    .map((device) => device.device_id === "light.living_room"
      ? { ...device, state: "on", attributes: { ...device.attributes, brightness: 100 } }
      : device);
  const homeAssistant = new MockHomeAssistant({ devices: initialDevices });
  const runtime = createDeviceToolRuntime(homeAssistant);

  const agentInvocations = [];
  const agentClient = {
    async invoke(request) {
      agentInvocations.push(request.agentId);
      if (request.agentId === "learning-companion") {
        return {
          status: "ok",
          output: createLearningEvent(observation, request.traceId, `evt-${name}`),
        };
      }
      if (request.agentId !== "energy-saving") throw new Error(`Mock 不允许调用 ${request.agentId}`);
      if (energyDecision === "NO_ACTION") {
        return {
          status: "ok",
          output: {
            schema_version: "0.1",
            outcome: "NO_ACTION",
            source_agent: "energy-saving",
            trace_id: request.traceId,
            reason_code: "OCCUPANCY_NOT_CONFIRMED",
          },
        };
      }
      return { status: "ok", output: createEnergyTask(request.traceId, `task-${name}`) };
    },
  };
  const bridge = createOrchestratorBridge(runtime);
  const workflow = createIndependentLearningEnergyWorkflow({
    agentClient,
    isTrustedObservation: () => trusted,
    clock: () => now,
    executeEnergyTask: (task, options) => bridge.agentPlanTools.executeEnergyTask(task, options),
  });
  const result = await workflow.evaluate({ observation, traceId, idempotencyKey: `mock-${name}` });
  const state = runtime.invoke("get_state", { device_id: "light.living_room" });
  if (!state.success) throw new Error(`Mock 设备状态回读失败：${state.error?.code ?? "UNKNOWN"}`);

  return {
    scenario: name,
    status: result.status,
    reason_code: result.reason_code ?? result.reason_codes?.join(",") ?? null,
    agents_involved: result.agents_involved,
    simulated_agent_invocations: agentInvocations,
    execution_performed: result.execution_performed,
    confirmation_required: result.confirmation_required === true,
    final_light_state: state.device.state,
    mock_action_audit_entries: homeAssistant.auditLog.length,
  };
}

/**
 * Demonstrates only the composition layer. Agent responses and the trusted
 * observation attestation are test fixtures; all device operations use a new
 * in-memory Mock Home Assistant instance.
 */
export async function runIndependentLearningEnergyDemo({ now = () => Date.now() } = {}) {
  const timestamp = now();
  const scenarios = [
    await runScenario({ name: "untrusted-source", trusted: false, now: timestamp }),
    await runScenario({
      name: "needs-review",
      observationOverrides: { needs_review: true },
      now: timestamp,
    }),
    await runScenario({ name: "energy-no-action", energyDecision: "NO_ACTION", now: timestamp }),
    await runScenario({ name: "candidate-needs-confirmation", energyDecision: "TASK", now: timestamp }),
  ];
  const deviceActionsExecuted = scenarios.reduce((total, scenario) => total + scenario.mock_action_audit_entries, 0);
  const success = scenarios[0].status === "REJECTED"
    && scenarios[0].simulated_agent_invocations.length === 0
    && scenarios[1].status === "REVIEW_REQUIRED"
    && scenarios[1].simulated_agent_invocations.join(",") === "learning-companion"
    && scenarios[2].status === "NO_ACTION"
    && scenarios[2].simulated_agent_invocations.join(",") === "learning-companion,energy-saving"
    && scenarios[3].status === "CHALLENGE"
    && scenarios[3].confirmation_required
    && deviceActionsExecuted === 0
    && scenarios.every((scenario) => scenario.final_light_state === "on"
      && scenario.execution_performed === false
      && scenario.mock_action_audit_entries === 0);
  return {
    success,
    simulation: true,
    backend: "in-memory Mock Home Assistant",
    model_calls: 0,
    real_home_assistant_connected: false,
    device_actions_executed: deviceActionsExecuted,
    scenarios,
    note: "Agent 回复、观测来源认证均为测试夹具。展示的是本地编排/安全门禁代码路径，不是 OpenClaw 独立 Agent、视觉识别、真实传感器或真实设备验收。",
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = await runIndependentLearningEnergyDemo();
  console.log(JSON.stringify(result, null, 2));
  if (!result.success) process.exitCode = 1;
}
