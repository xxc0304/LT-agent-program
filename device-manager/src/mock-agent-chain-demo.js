import { randomUUID } from "node:crypto";

import { MockHomeAssistant } from "./mock-ha.js";
import { createOrchestratorBridge } from "./orchestrator-bridge.js";
import { createDeviceToolRuntime } from "./tools.js";

/**
 * Run a synthetic learning-departure scenario against a dedicated Mock HA.
 * This is intentionally separate from the configured runtime so a demo can
 * never actuate a real Home Assistant installation.
 */
export async function runMockAgentChainDemo({
  now = () => new Date(),
  createRunId = randomUUID,
} = {}) {
  const runId = createRunId();
  const occurredAt = now().toISOString();
  const traceId = `trace-${runId}`;
  const homeAssistant = new MockHomeAssistant();
  const deviceRuntime = createDeviceToolRuntime(homeAssistant);
  const bridge = createOrchestratorBridge(deviceRuntime, {
    trustedOccupancySourceAgents: ["ha-event-adapter"],
    trustedEventSourceAgents: ["ha-event-adapter", "learning-companion"],
  });

  // Give the scheduler a controllable target so the demo proves an actual
  // Mock device state transition rather than returning a planned task only.
  const initialLight = deviceRuntime.invoke("control_device", {
    device_id: "light.living_room",
    action: "turn_on",
    task_id: `demo-setup-${runId}`,
    trace_id: traceId,
  });
  if (!initialLight.success) {
    return {
      success: false,
      simulation: true,
      backend: "Mock Home Assistant",
      error: { code: "MOCK_SETUP_FAILED", message: "无法建立演示所需的初始灯具状态。" },
    };
  }

  // Both events below are generated demo fixtures, not camera/HA observations.
  const occupancyEvent = {
    schema_version: "0.1",
    event_id: `evt-${runId}-mock-occupancy`,
    source_agent: "ha-event-adapter",
    event_type: "occupancy_changed",
    occurred_at: occurredAt,
    privacy_level: "family",
    trace_id: traceId,
    payload: { area: "living_room", occupied: false, observed_for_ms: 60_000 },
  };
  const occupancyTrace = await bridge.dispatchTrustedEvent(occupancyEvent, {
    sourceAgent: "ha-event-adapter",
  });

  const learningEvent = {
    schema_version: "0.1",
    event_id: `evt-${runId}-mock-learning-departure`,
    source_agent: "learning-companion",
    event_type: "learning_behavior",
    occurred_at: occurredAt,
    confidence: 0.95,
    needs_review: false,
    privacy_level: "restricted",
    data_level: "L3",
    trace_id: traceId,
    payload: {
      behavior: "standing",
      presence: "away_from_desk",
      area: "living_room",
      duration_ms: 600_000,
      evidence: "演示用合成事件：模拟连续多帧未检测到孩子在书桌区域",
    },
  };
  const trace = await bridge.dispatchTrustedEvent(learningEvent, {
    sourceAgent: "learning-companion",
  });
  const finalState = deviceRuntime.invoke("get_state", { device_id: "light.living_room" });

  return {
    success: trace.status === "SUCCEEDED"
      && finalState.success === true
      && finalState.device?.state === "off",
    simulation: true,
    backend: "Mock Home Assistant",
    scenario: "learning_departure",
    trigger: "用户自然语言请求触发本地演示工具",
    synthetic_events: [
      { event_type: occupancyEvent.event_type, source_agent: occupancyEvent.source_agent },
      { event_type: learningEvent.event_type, source_agent: learningEvent.source_agent },
    ],
    occupancy_trace: occupancyTrace.status,
    status: trace.status,
    trace_id: traceId,
    agents_involved: trace.agents_involved,
    stages: trace.stages,
    planned_tasks: trace.planned_tasks,
    receipts: trace.receipts,
    final_light_state: finalState.device?.state ?? null,
    note: "本次为自然语言发起的本地 Mock 演示。占用与学习事件均为程序生成的合成样例，不代表真实传感器或视觉识别结果；不会访问或控制真实 Home Assistant/家电。",
  };
}
