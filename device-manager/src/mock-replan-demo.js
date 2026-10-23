import { EnergySavingAgent } from "../../energy-saving/src/energy-agent.js";
import { MockHomeAssistant } from "./mock-ha.js";
import { createAgentPlanTools } from "./agent-plan-tools.js";
import { createDeviceTaskRuntime } from "./task-runtime.js";
import { createDeviceToolRuntime } from "./tools.js";

function makePlan({ planId, steps, goal }) {
  return {
    schema_version: "0.1",
    plan_id: planId,
    trace_id: "trace-mock-feedback-replan",
    goal,
    steps: steps.map(({ step_id, action }) => ({
      step_id,
      agent_id: "device-manager",
      capability: "execute_device_action",
      depends_on: [],
      evidence_refs: [],
      input: {},
      action: {
        name: action,
        target_ref: { device_id: "light.living_room" },
        parameters: {},
      },
    })),
  };
}

/**
 * Exercise the OpenClaw plan-tool boundary using a dedicated Mock HA.
 * The utterances are fixtures: no LLM, gateway, live HA, or real device is used.
 */
export async function runMockFeedbackReplanDemo() {
  const homeAssistant = new MockHomeAssistant();
  const deviceRuntime = createDeviceToolRuntime(homeAssistant);
  const energyAgent = new EnergySavingAgent({
    deviceClient: { listDevices: () => deviceRuntime.invoke("list_devices", {}) },
  });
  const tools = createAgentPlanTools({
    deviceRuntime,
    deviceTaskRuntime: createDeviceTaskRuntime(deviceRuntime),
    energyAgent,
  });
  const conversation = [];

  conversation.push({ role: "user", text: "客厅灯既要求打开也要求关闭，但没有指定先后顺序。" });
  const conflictingPlan = makePlan({
    planId: "mock-conflicting-plan",
    goal: "处理客厅灯",
    steps: [
      { step_id: "turn-on-light", action: "turn_on" },
      { step_id: "turn-off-light", action: "turn_off" },
    ],
  });
  const conflict = await tools.invokeTool("submit_agent_plan", { plan: conflictingPlan });
  conversation.push({
    role: "assistant_feedback",
    text: conflict.clarification?.user_question ?? "工具未返回可用的澄清问题。",
  });

  // Simulate the user's clarification, then construct a new—not mutated—plan.
  conversation.push({ role: "user", text: "最终保持关闭，只留关灯。" });
  const revisedPlan = makePlan({
    planId: "mock-revised-plan",
    goal: "关闭客厅灯并确认状态",
    steps: [{ step_id: "turn-off-light-only", action: "turn_off" }],
  });
  const revised = await tools.invokeTool("submit_agent_plan", { plan: revisedPlan });

  let approval = null;
  let execution = null;
  if (revised.workflow_status === "WAITING_FOR_APPROVAL") {
    conversation.push({
      role: "assistant_plan",
      text: "新计划仅关闭客厅灯。候选计划写操作仍需用户确认；演示将模拟用户明确同意。",
    });
    conversation.push({ role: "user", text: "确认执行这个新计划。" });
    approval = await tools.invokeTool("resolve_agent_action_confirmation", {
      approval_id: revised.approval.approval_id,
      decision: "approve",
    });
    execution = approval;
  }

  const finalState = deviceRuntime.invoke("get_state", { device_id: "light.living_room" });
  const audit = homeAssistant.getAuditLog();
  return {
    demo: "Mock 冲突反馈 → 用户澄清 → 新计划重新校验 → 明确确认 → 执行与状态回读",
    conversation,
    conflict_gate: {
      status: conflict.workflow_status,
      reason: conflict.clarification?.reason,
      affected_devices: conflict.clarification?.conflicts?.map(({ device_name, actions }) => ({
        device_name,
        actions: actions.map(({ action, action_label }) => ({ action, action_label })),
      })) ?? [],
      execution_performed: conflict.execution_performed,
      approval_allowed: conflict.clarification?.approval_allowed,
    },
    revised_plan: {
      status: revised.workflow_status,
      goal: revisedPlan.goal,
      actions: revisedPlan.steps.map((step) => step.action.name),
      execution_performed_before_confirmation: revised.execution_performed,
    },
    confirmation: approval ? {
      workflow_status: approval.workflow_status,
      decision: approval.decision,
    } : null,
    final_state: finalState.success ? {
      device_name: finalState.device.name,
      state: finalState.device.state,
    } : null,
    audit: audit.map(({ device_id, action, verified, result_state }) => ({
      device_id,
      action,
      verified,
      result_state,
    })),
    success: conflict.workflow_status === "CLARIFICATION_REQUIRED"
      && conflict.execution_performed === false
      && revised.workflow_status === "WAITING_FOR_APPROVAL"
      && approval?.workflow_status === "COMPLETED"
      && finalState.success === true
      && finalState.device.state === "off"
      && audit.length === 1
      && audit[0].action === "turn_off"
      && audit[0].verified === true,
    real_home_assistant_connected: false,
    openclaw_gateway_called: false,
    llm_used: false,
    note: "只通过本地 OpenClaw 工具实现调用的计划工具边界和独立 Mock HA 验证流程；对话文本是固定测试样例，不证明 Gateway 已调用大模型，也不代表真实 HA/家电联调。",
  };
}

if (process.argv[1] && process.argv[1].endsWith("mock-replan-demo.js")) {
  console.log(JSON.stringify(await runMockFeedbackReplanDemo(), null, 2));
}
