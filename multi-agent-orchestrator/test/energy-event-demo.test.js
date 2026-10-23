import test from "node:test";
import assert from "node:assert/strict";
import { runEnergyEventDemo } from "../src/energy-event-demo.js";

test("occupancy event is routed through energy agent and device manager to Mock HA", async () => {
  const result = await runEnergyEventDemo();

  assert.equal(result.success, true);
  assert.equal(result.simulation, true);
  assert.equal(result.backend, "Mock Home Assistant");
  assert.equal(result.trace.status, "SUCCEEDED");
  assert.deepEqual(result.trace.agents_involved, ["ha-event-adapter", "energy-saving", "device-manager"]);
  assert.equal(result.trace.planned_tasks.length, 2);
  assert.equal(result.trace.receipts.length, 2);
  assert.ok(Object.values(result.final_states).every((state) => state.device.state === "off"));
});
