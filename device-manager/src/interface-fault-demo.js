import { createMockOrchestrator, makeDeviceActionTask } from "./mock-orchestrator.js";
import { createDeviceToolRuntime } from "./tools.js";

function makeTask(suffix) {
  return makeDeviceActionTask({
    task_id: `task-interface-${suffix}`,
    trace_id: `trace-interface-${suffix}`,
    device_id: "switch.living_room_plug",
    action: "turn_on",
  });
}

async function runScenario(name, orchestrator, task, deviceRuntime) {
  const record = await orchestrator.submit(task);
  return {
    scenario: name,
    status: record.receipt.status,
    error_code: record.receipt.error?.code ?? null,
    trace_id: record.trace_id,
    stages: record.stages.map(({ stage, status }) => ({ stage, status })),
    device_control_count: deviceRuntime?.homeAssistant?.getAuditLog?.().length ?? 0,
    verified: record.receipt.result?.action_result?.result?.verified ?? null,
  };
}

const results = [];

{
  const deviceRuntime = createDeviceToolRuntime();
  results.push(await runScenario(
    "正常链路",
    createMockOrchestrator({ deviceRuntime }),
    makeTask("success"),
    deviceRuntime,
  ));
}

{
  const deviceRuntime = createDeviceToolRuntime();
  results.push(await runScenario(
    "ResourceStatus 缺字段",
    createMockOrchestrator({
      deviceRuntime,
      resourceProvider: async () => ({ node_id: "mock-edge-01", supported_compute: ["switch"], data_zone: "home_local" }),
    }),
    makeTask("resource-missing"),
    deviceRuntime,
  ));
}

{
  const deviceRuntime = createDeviceToolRuntime();
  results.push(await runScenario(
    "PolicyDecision 超时",
    createMockOrchestrator({
      deviceRuntime,
      policyProvider: () => new Promise(() => {}),
      timeouts: { policy: 10 },
    }),
    makeTask("policy-timeout"),
    deviceRuntime,
  ));
}

{
  const task = makeTask("receipt-mismatch");
  const deviceRuntime = createDeviceToolRuntime();
  results.push(await runScenario(
    "设备管家返回 trace 不匹配的回执",
    createMockOrchestrator({
      deviceRuntime,
      taskExecutor: async () => ({
        task_id: task.task_id,
        target_agent: "device-manager",
        status: "SUCCEEDED",
        completed_at: new Date().toISOString(),
        trace_id: "wrong-trace-id",
        result: {},
      }),
    }),
    task,
    deviceRuntime,
  ));
}

const report = {
  suite: "agent-group-a05-mock-interface-faults",
  backend: "Mock Home Assistant",
  real_interfaces_connected: false,
  results,
};

console.log(JSON.stringify(report, null, 2));

const expected = ["SUCCEEDED", "FAILED", "TIMEOUT", "FAILED"];
if (results.some((result, index) => result.status !== expected[index])) process.exitCode = 1;
if (results.slice(1).some((result) => result.device_control_count !== 0)) process.exitCode = 1;
if (results[0].verified !== true) process.exitCode = 1;
