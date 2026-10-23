import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateAgainstSchema, validateTaskAliases } from "./schema-validator.mjs";

const root = dirname(fileURLToPath(import.meta.url));

const validExamples = [
  ["examples/device.json", "device.schema.json"],
  ["examples/resource-status-edge.json", "resource-status.schema.json"],
  ["examples/policy-decision-challenge.json", "policy-decision.schema.json"],
  ["examples/device-control-task.json", "task.schema.json"],
  ["examples/device-action-task.json", "task.schema.json"],
  ["examples/orchestrator-device-action-task.json", "task.schema.json"],
  ["examples/device-control-receipt.json", "task-receipt.schema.json"],
  ["examples/door-unlock-challenge.json", "task-receipt.schema.json"],
  ["examples/device-action-event.json", "event.schema.json"],
  ["examples/learning-behavior-event.json", "event.schema.json"],
  ["examples/study-session-started-event.json", "event.schema.json"],
  ["examples/study-lamp-reminder-task.json", "task.schema.json"],
  ["examples/security-door-contact-event.json", "event.schema.json"],
  ["examples/security-motion-event.json", "event.schema.json"],
  ["examples/security-lock-state-event.json", "event.schema.json"],
  ["examples/security-stranger-suspected-event.json", "event.schema.json"],
  ["examples/security-fall-suspected-event.json", "event.schema.json"],
];

const invalidExamples = [
  ["examples/invalid/device-missing-availability.json", "device.schema.json"],
  ["examples/invalid/event-missing-id.json", "event.schema.json"],
  ["examples/invalid/task-missing-trace.json", "task.schema.json"],
  ["examples/invalid/task-conflicting-target-alias.json", "task.schema.json"],
];

async function loadSchema(schemaFile) {
  return JSON.parse(await readFile(join(root, "schemas", schemaFile), "utf8"));
}

async function loadExample(relativePath) {
  return JSON.parse(await readFile(join(root, relativePath), "utf8"));
}

for (const [relativePath, schemaFile] of validExamples) {
  const [value, schema] = await Promise.all([loadExample(relativePath), loadSchema(schemaFile)]);
  const errors = validateAgainstSchema(value, schema);
  if (schemaFile === "task.schema.json") errors.push(...validateTaskAliases(value));
  assert.deepEqual(errors, [], `${relativePath}: ${errors.join("; ")}`);
  console.log(`PASS ${relativePath}`);
}

for (const [relativePath, schemaFile] of invalidExamples) {
  const [value, schema] = await Promise.all([loadExample(relativePath), loadSchema(schemaFile)]);
  const errors = validateAgainstSchema(value, schema);
  if (schemaFile === "task.schema.json") errors.push(...validateTaskAliases(value));
  assert.ok(errors.length > 0, `${relativePath} should be rejected`);
  console.log(`PASS rejected ${relativePath}: ${errors[0]}`);
}

console.log(`Validated ${validExamples.length} valid and ${invalidExamples.length} intentionally invalid contract examples.`);
