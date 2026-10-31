import { AgentPlanValidator } from "./plan-validator.js";
import { AgentPlanExecutor } from "./plan-executor.js";

const now = Date.now();
const evidence = [{
  evidence_id: "ha-study-occupancy-001",
  evidence_type: "occupancy",
  trust_level: "trusted",
  source_type: "home_assistant",
  source_id: "binary_sensor.study_occupancy",
  observed_at: new Date(now - 10_000).toISOString(),
}];

const validator = new AgentPlanValidator({
  agents: [
    {
      agent_id: "device-manager",
      capabilities: {
        read_occupancy: {
          effect: "read_only",
          required_evidence: [{
            evidence_type: "occupancy",
            trusted: true,
            allowed_sources: ["home_assistant"],
            max_age_ms: 60_000,
          }],
        },
        execute_device_action: { effect: "device_action" },
      },
    },
    {
      agent_id: "energy-saving",
      capabilities: { plan_energy_action: { effect: "planning" } },
    },
    {
      agent_id: "learning-companion",
      capabilities: { analyze_learning_behavior: { effect: "read_only" } },
    },
  ],
  householdPolicy: {
    allowedDeviceIds: ["light.study"],
    allowedActions: ["turn_on", "turn_off"],
    autoAllowedDeviceActions: [{ device_id: "light.study", action: "turn_off" }],
  },
});

const executor = new AgentPlanExecutor({
  validator,
  handlers: {
    "device-manager::read_occupancy": async () => ({ result: { occupied: false, source: "mock" } }),
    "energy-saving::plan_energy_action": async ({ dependency_results }) => ({
      result: {
        proposed_action: dependency_results["read-occupancy"].occupied ? "none" : "turn_off",
      },
    }),
    "device-manager::execute_device_action": async ({ action, dependency_results }) => {
      if (dependency_results["assess-energy"].proposed_action !== action.name) {
        return { status: "DENIED", error: { code: "PLAN_RESULT_MISMATCH", message: "节能计划与设备动作不一致" } };
      }
      return { result: { backend: "mock", state: "off" } };
    },
  },
});

const safePlan = {
  schema_version: "0.1",
  plan_id: "demo-safe-energy-plan",
  trace_id: "trace-demo-safe-energy-plan",
  goal: "占用条件符合时，由能源管家建议关闭学习灯",
  steps: [
    {
      step_id: "read-occupancy",
      agent_id: "device-manager",
      capability: "read_occupancy",
      depends_on: [],
      evidence_refs: ["ha-study-occupancy-001"],
      input: { area: "study" },
    },
    {
      step_id: "assess-energy",
      agent_id: "energy-saving",
      capability: "plan_energy_action",
      depends_on: ["read-occupancy"],
      evidence_refs: ["ha-study-occupancy-001"],
      input: { area: "study" },
    },
    {
      step_id: "turn-off-light",
      agent_id: "device-manager",
      capability: "execute_device_action",
      depends_on: ["assess-energy"],
      evidence_refs: ["ha-study-occupancy-001"],
      action: {
        name: "turn_off",
        target_ref: { device_id: "light.study" },
        parameters: {},
      },
    },
  ],
};

const conflictingPlan = {
  ...safePlan,
  plan_id: "demo-conflicting-plan",
  trace_id: "trace-demo-conflicting-plan",
  goal: "同一计划里同时要求开灯和关灯",
  steps: [
    {
      step_id: "turn-on",
      agent_id: "device-manager",
      capability: "execute_device_action",
      depends_on: [],
      evidence_refs: [],
      action: { name: "turn_on", target_ref: { device_id: "light.study" }, parameters: {} },
    },
    {
      step_id: "turn-off",
      agent_id: "device-manager",
      capability: "execute_device_action",
      depends_on: [],
      evidence_refs: [],
      action: { name: "turn_off", target_ref: { device_id: "light.study" }, parameters: {} },
    },
  ],
};

const unknownAgentPlan = {
  ...safePlan,
  plan_id: "demo-unknown-agent-plan",
  trace_id: "trace-demo-unknown-agent-plan",
  steps: [{
    step_id: "invented-capability",
    agent_id: "unregistered-agent",
    capability: "control_everything",
    depends_on: [],
    evidence_refs: [],
  }],
};

for (const [title, plan, options] of [
  ["授权范围内、证据有效的计划（仅调用本地 Mock handler）", safePlan, { evidence }],
  ["同一设备存在未排序的冲突动作", conflictingPlan],
  ["模型提议未登记的 Agent", unknownAgentPlan],
]) {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(await executor.execute(plan, options), null, 2));
}

console.log("\n演示只运行进程内 Mock capability handler；没有调用模型、OpenClaw Agent、Home Assistant 或真实设备。");
