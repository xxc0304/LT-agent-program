import { createMockOrchestrator, makeDeviceActionTask } from "./mock-orchestrator.js";

const orchestrator = createMockOrchestrator();

function show(title, record) {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify({
    trace_id: record.trace_id,
    policy_decision: record.policy_decision,
    selected_node: record.resource_status.node_id,
    stages: record.stages,
    receipt: record.receipt,
  }, null, 2));
}

const plugTask = makeDeviceActionTask({
  task_id: "task-demo-orchestrator-001",
  trace_id: "trace-demo-orchestrator-001",
  device_id: "switch.living_room_plug",
  action: "turn_on",
});
show("1. Task → PolicyDecision → ResourceStatus → Device Manager", await orchestrator.submit(plugTask));
show("2. 重复幂等任务（不应再次控制）", await orchestrator.submit(plugTask));

const unlockTask = makeDeviceActionTask({
  task_id: "task-demo-orchestrator-002",
  trace_id: "trace-demo-orchestrator-002",
  device_id: "lock.front_door",
  action: "unlock",
  compute_class: "lock",
  idempotency_key: "task-demo-orchestrator-002:unlock",
});
show("3. 高风险动作进入 CHALLENGE", await orchestrator.submit(unlockTask));
