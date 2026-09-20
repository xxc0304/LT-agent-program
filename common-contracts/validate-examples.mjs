import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const examples = [
  ["examples/device-control-task.json", "task"],
  ["examples/device-control-receipt.json", "receipt"],
  ["examples/door-unlock-challenge.json", "receipt"],
  ["examples/device-action-event.json", "event"],
];

const allowedPrivacy = new Set(["family", "sensitive", "restricted"]);
const allowedStatus = new Set(["SUCCEEDED", "FAILED", "DENIED", "CHALLENGE", "TIMEOUT", "RETRYABLE"]);

function required(value, fields) {
  for (const field of fields) assert.ok(value[field] !== undefined, `${field} is required`);
}

function validateTask(value) {
  required(value, ["schema_version", "task_id", "source_agent", "target_agent", "task_type", "priority", "deadline_ms", "resource_requirement", "privacy_level", "payload"]);
  assert.equal(value.schema_version, "0.1");
  assert.ok(["control_device", "get_state", "run_scene", "diagnose_device"].includes(value.task_type));
  assert.ok(["low", "normal", "high", "critical"].includes(value.priority));
  assert.ok(Number.isInteger(value.deadline_ms) && value.deadline_ms >= 0);
  assert.ok(["local", "edge", "cloud"].includes(value.resource_requirement.execution_mode));
  assert.ok(allowedPrivacy.has(value.privacy_level));
  assert.equal(typeof value.payload, "object");
}

function validateReceipt(value) {
  required(value, ["schema_version", "task_id", "target_agent", "status", "completed_at"]);
  assert.equal(value.schema_version, "0.1");
  assert.ok(allowedStatus.has(value.status));
  assert.match(value.completed_at, /^\d{4}-\d{2}-\d{2}T/);
}

function validateEvent(value) {
  required(value, ["schema_version", "event_id", "source_agent", "event_type", "occurred_at", "privacy_level", "payload"]);
  assert.equal(value.schema_version, "0.1");
  assert.ok(typeof value.event_id === "string" && value.event_id.length > 0);
  assert.ok(typeof value.source_agent === "string" && value.source_agent.length > 0);
  assert.ok(typeof value.event_type === "string" && value.event_type.length > 0);
  assert.match(value.occurred_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(allowedPrivacy.has(value.privacy_level));
  assert.equal(typeof value.payload, "object");
  if (value.received_at) assert.match(value.received_at, /^\d{4}-\d{2}-\d{2}T/);
  if (value.data_level) assert.ok(["L0", "L1", "L2", "L3"].includes(value.data_level));
}

for (const [relativePath, type] of examples) {
  const value = JSON.parse(await readFile(join(root, relativePath), "utf8"));
  if (type === "task") validateTask(value);
  else if (type === "receipt") validateReceipt(value);
  else validateEvent(value);
  console.log(`PASS ${relativePath}`);
}

console.log(`Validated ${examples.length} contract examples.`);
