import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const storeModuleUrl = new URL("../src/agent-approval-state-store.js", import.meta.url).href;

function runStoreProcess(script, filePath) {
  const env = {
    PATH: process.env.PATH ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    WINDIR: process.env.WINDIR ?? "",
    TEMP: process.env.TEMP ?? tmpdir(),
    TMP: process.env.TMP ?? tmpdir(),
    DEVICE_MANAGER_APPROVAL_STATE_PATH: filePath,
  };
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("审批状态跨 Node 进程重启恢复且不持久化对话输入", () => {
  const directory = mkdtempSync(join(tmpdir(), "lt-agent-approval-process-restart-"));
  const filePath = join(directory, "approval-state.json");
  try {
    const writeScript = `
      import { AgentApprovalStateStore } from ${JSON.stringify(storeModuleUrl)};
      const store = new AgentApprovalStateStore();
      const now = Date.now();
      const records = [
        ["approval-process-pending", "plan-process-pending", "WAITING_FOR_APPROVAL"],
        ["approval-process-executing", "plan-process-executing", "EXECUTING"],
      ];
      for (const [approval_id, plan_id, status] of records) {
        store.recordWorkflowState({
          approval_id,
          status,
          plan_fingerprint: "fingerprint-process-restart",
          created_at_ms: now,
          expires_at_ms: now + 300000,
          plan: {
            plan_id,
            goal: "PRIVATE_GOAL_MUST_NOT_PERSIST",
            steps: [{
              step_id: "step-light",
              agent_id: "device-manager",
              capability: "execute_device_action",
              input: { raw_event: "PRIVATE_EVENT_MUST_NOT_PERSIST" },
              action: {
                name: "turn_on",
                target_ref: { device_id: "light.living_room" },
                parameters: { raw_text: "PRIVATE_PARAMETER_MUST_NOT_PERSIST" },
              },
            }],
          },
        }, "process_restart_test");
      }
    `;
    runStoreProcess(writeScript, filePath);

    const persisted = readFileSync(filePath, "utf8");
    assert.match(persisted, /WAITING_FOR_APPROVAL/);
    assert.match(persisted, /EXECUTING/);
    assert.doesNotMatch(persisted, /PRIVATE_(?:GOAL|EVENT|PARAMETER)_MUST_NOT_PERSIST/);

    const restartScript = `
      import assert from "node:assert/strict";
      import { AgentApprovalStateStore } from ${JSON.stringify(storeModuleUrl)};
      const store = new AgentApprovalStateStore();
      const records = new Map(store.list().map((record) => [record.approval_id, record]));
      assert.equal(records.get("approval-process-pending")?.status, "RECOVERY_REQUIRED");
      assert.equal(records.get("approval-process-executing")?.status, "EXECUTION_UNCERTAIN");
      console.log(JSON.stringify([...records.values()].map(({ approval_id, status }) => ({ approval_id, status }))));
    `;
    const restarted = JSON.parse(runStoreProcess(restartScript, filePath));
    assert.deepEqual(restarted, [
      { approval_id: "approval-process-pending", status: "RECOVERY_REQUIRED" },
      { approval_id: "approval-process-executing", status: "EXECUTION_UNCERTAIN" },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
