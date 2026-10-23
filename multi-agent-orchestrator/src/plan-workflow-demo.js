import { AgentPlanValidator } from "./plan-validator.js";
import { AgentPlanExecutor } from "./plan-executor.js";
import { AgentPlanWorkflow } from "./plan-workflow.js";

const validator = new AgentPlanValidator({
  agents: [{
    agent_id: "device-manager",
    capabilities: { execute_device_action: { effect: "device_action" } },
  }],
  householdPolicy: {
    allowedDeviceIds: ["light.study"],
    allowedActions: ["turn_off"],
    autoAllowedDeviceActions: [],
  },
});

const executor = new AgentPlanExecutor({
  validator,
  handlers: {
    "device-manager::execute_device_action": async ({ action }) => ({
      result: { backend: "mock", requested_state: action.name === "turn_off" ? "off" : "on" },
    }),
  },
});

const workflow = new AgentPlanWorkflow({
  validator,
  executor,
  authorizeActor: async ({ actor }) => actor.id === "demo-parent",
  evidenceProvider: async () => [],
});

const plan = {
  schema_version: "0.1",
  plan_id: "demo-plan-confirmation",
  trace_id: "trace-demo-plan-confirmation",
  goal: "关闭学习灯",
  steps: [{
    step_id: "turn-off-study-light",
    agent_id: "device-manager",
    capability: "execute_device_action",
    depends_on: [],
    evidence_refs: [],
    action: { name: "turn_off", target_ref: { device_id: "light.study" }, parameters: {} },
  }],
};

const pending = await workflow.submit(plan);
console.log("=== 提交后等待人工确认：未执行设备动作 ===");
console.log(JSON.stringify(pending, null, 2));

const completed = await workflow.approve(pending.approval.approval_id, {
  actor: { id: "demo-parent" },
});
console.log("\n=== 模拟授权确认后重新校验并调用本地 Mock handler ===");
console.log(JSON.stringify(completed, null, 2));
console.log("\n演示只使用进程内 Mock handler 和模拟身份授权，不连接 OpenClaw、Home Assistant 或真实设备。");
