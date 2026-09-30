import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTaskAliases } from "../task-compat.mjs";

test("保留 canonical 字段并返回新对象", () => {
  const input = { source_agent: "energy-saving", target_agent: "device-manager", task_id: "task-1" };
  const result = normalizeTaskAliases(input, { requireSource: true });

  assert.equal(result.error, undefined);
  assert.deepEqual(result.task, input);
  assert.notEqual(result.task, input);
});

test("将旧 source/target 别名转换成 canonical 字段", () => {
  const result = normalizeTaskAliases({ source: "energy-saving", target: "device-manager" }, { requireSource: true });

  assert.deepEqual(result.task, { source_agent: "energy-saving", target_agent: "device-manager" });
});

test("允许一致的双字段并在结果中删除别名", () => {
  const result = normalizeTaskAliases({
    source_agent: "energy-saving",
    source: "energy-saving",
    target_agent: "device-manager",
    target: "device-manager",
  });

  assert.deepEqual(result.task, { source_agent: "energy-saving", target_agent: "device-manager" });
});

test("拒绝 source 或 target 别名冲突", () => {
  const sourceConflict = normalizeTaskAliases({
    source_agent: "energy-saving",
    source: "learning-companion",
    target_agent: "device-manager",
  });
  const targetConflict = normalizeTaskAliases({
    source_agent: "energy-saving",
    target_agent: "device-manager",
    target: "security-agent",
  });

  assert.match(sourceConflict.error, /source_agent.*source/);
  assert.match(targetConflict.error, /target_agent.*target/);
});

test("拒绝缺失目标、必需来源和空白别名", () => {
  assert.match(normalizeTaskAliases({ source_agent: "energy-saving" }).error, /target_agent/);
  assert.match(normalizeTaskAliases({ target_agent: "device-manager" }, { requireSource: true }).error, /source_agent/);
  assert.match(normalizeTaskAliases({ source: " ", target: "device-manager" }).error, /source/);
});
