import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateTaskAliases(task) {
  const errors = [];
  for (const [canonical, alias] of [["source_agent", "source"], ["target_agent", "target"]]) {
    if (Object.hasOwn(task, canonical) && Object.hasOwn(task, alias) && task[canonical] !== task[alias]) {
      errors.push(`$.${canonical} must match compatibility alias $.${alias}`);
    }
  }
  return errors;
}

function matchesType(value, type) {
  if (type === "null") return value === null;
  if (type === "object") return isObject(value);
  if (type === "array") return Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return true;
}

/**
 * Dependency-free validator for the JSON Schema keywords used in this repo.
 * It intentionally handles only the documented subset; use a full JSON
 * Schema implementation when the contract adopts unsupported keywords.
 */
export function validateAgainstSchema(value, schema, path = "$", errors = []) {
  if (schema.oneOf) {
    const matchingBranches = schema.oneOf.filter((branch) =>
      validateAgainstSchema(value, branch, path, []).length === 0,
    ).length;
    if (matchingBranches !== 1) {
      errors.push(`${path} must match exactly one oneOf branch (matched ${matchingBranches})`);
    }
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${path} must be ${types.join(" or ")}`);
      return errors;
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.join(", ")}`);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path} must contain at least ${schema.minLength} character(s)`);
    }
    if (schema.format === "date-time"
      && (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)))) {
      errors.push(`${path} must be a valid date-time string`);
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`);
  }

  if (isObject(value)) {
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) errors.push(`${path}.${required} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) errors.push(`${path}.${key} is not allowed`);
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) validateAgainstSchema(value[key], childSchema, `${path}.${key}`, errors);
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validateAgainstSchema(item, schema.items, `${path}[${index}]`, errors));
  }

  return errors;
}

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
