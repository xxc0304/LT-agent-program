function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateTaskAliases(task) {
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
 * Dependency-free validator for the JSON Schema keywords currently used by
 * this repository. Extend it or adopt a full JSON Schema implementation if
 * the contracts add unsupported keywords.
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
