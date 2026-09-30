import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function unpackToolResult(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const textBlock = result?.content?.find((block) => block.type === "text" && typeof block.text === "string");
  if (textBlock) {
    try {
      return JSON.parse(textBlock.text);
    } catch {
      return textBlock.text;
    }
  }
  return result;
}

test("OpenClaw SDK 注册后的真实工具回调可用隔离临时文件完成记忆闭环", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-openclaw-memory-runtime-"));
  const previousMemoryPath = process.env.FAMILY_MEMORY_PATH;
  process.env.FAMILY_MEMORY_PATH = path.join(directory, "isolated-memory.json");
  t.after(async () => {
    if (previousMemoryPath === undefined) delete process.env.FAMILY_MEMORY_PATH;
    else process.env.FAMILY_MEMORY_PATH = previousMemoryPath;
    await fs.rm(directory, { recursive: true, force: true });
  });

  const { default: plugin } = await import(`../src/openclaw-plugin.js?isolated-memory=${Date.now()}`);
  const registeredTools = new Map();
  plugin.register({
    pluginConfig: {},
    registerTool(tool) {
      registeredTools.set(tool.name, tool);
    },
  });

  async function invoke(name, params) {
    const tool = registeredTools.get(name);
    assert.ok(tool, `OpenClaw 插件未注册工具 ${name}`);
    const result = await tool.execute(`test-${name}`, params, undefined, undefined);
    return unpackToolResult(result);
  }

  const remembered = await invoke("remember_household_preference", {
    memory_type: "comfort_temperature_c",
    value: 26,
    room_id: "bedroom",
    user_explicit_request: true,
  });
  assert.equal(remembered.success, true);
  const preference = await invoke("get_household_preference", {
    memory_type: "comfort_temperature_c",
    room_id: "bedroom",
  });
  assert.equal(preference.value, 26);

  for (let index = 1; index <= 3; index += 1) {
    const observation = await invoke("propose_household_memory_candidate", {
      routine_type: "sleep_time",
      observed_time: "22:34",
      occurred_at: `2026-09-${20 + index}T14:34:00Z`,
      event_id: `isolated-sleep-${index}`,
      time_zone: "Asia/Shanghai",
      confidence: 0.95,
      consent_to_observe: true,
    });
    assert.equal(observation.success, true);
  }

  const candidates = await invoke("list_household_memories", { include_pending: true });
  const candidate = candidates.find((memory) => memory.memory_type === "sleep_time");
  assert.equal(candidate.status, "pending_confirmation");

  const prematurePreference = await invoke("get_household_preference", {
    memory_type: "sleep_time",
    time_zone: "Asia/Shanghai",
    day_type: "weekday",
  });
  assert.equal(prematurePreference, null);

  const confirmation = await invoke("confirm_household_memory_candidate", {
    memory_id: candidate.memory_id,
    user_confirmed: true,
  });
  assert.equal(confirmation.memory.status, "confirmed");

  const preview = await invoke("preview_household_routine", {
    routine_type: "sleep_time",
    time_zone: "Asia/Shanghai",
    day_type: "weekday",
  });
  assert.equal(preview.status, "PREVIEW_ONLY");
  assert.equal(preview.suggestion.local_time, "22:30");
  assert.equal(preview.automation_enabled, false);
  assert.equal(preview.execution_performed, false);

  const forgotten = await invoke("forget_household_memory", { memory_id: candidate.memory_id });
  assert.equal(forgotten.deleted, true);
  assert.equal(await fs.stat(process.env.FAMILY_MEMORY_PATH).then(() => true), true);
  assert.equal(await fs.stat(path.join(directory, "family-memory-v0.1.json")).then(() => true).catch(() => false), false);
});
