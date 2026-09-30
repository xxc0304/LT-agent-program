const FIELD_ALIASES = Object.freeze([
  ["source_agent", "source"],
  ["target_agent", "target"],
]);

/**
 * Normalize Task field aliases at an Agent boundary.
 * Returns a new object with canonical names only; never mutates the input.
 */
export function normalizeTaskAliases(task, { requireSource = false } = {}) {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    return { error: "任务必须是 JSON 对象" };
  }

  const normalized = { ...task };
  for (const [canonicalField, aliasField] of FIELD_ALIASES) {
    const canonical = task[canonicalField];
    const alias = task[aliasField];
    const hasCanonical = canonical !== undefined;
    const hasAlias = alias !== undefined;
    const required = canonicalField === "target_agent" || (canonicalField === "source_agent" && requireSource);

    if (!hasCanonical && !hasAlias) {
      if (required) return { error: `缺少必填字段：${canonicalField}` };
      continue;
    }

    for (const [field, value] of [[canonicalField, canonical], [aliasField, alias]]) {
      if (value !== undefined && (typeof value !== "string" || !value.trim())) {
        return { error: `${field} 必须是非空字符串` };
      }
    }
    if (hasCanonical && hasAlias && canonical !== alias) {
      return { error: `${canonicalField} 与兼容别名 ${aliasField} 不一致` };
    }

    normalized[canonicalField] = hasCanonical ? canonical : alias;
    delete normalized[aliasField];
  }

  return { task: normalized };
}
