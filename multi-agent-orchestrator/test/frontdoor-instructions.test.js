import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const instructionsUrl = new URL("../../openclaw-agents/dev/AGENTS.md", import.meta.url);
const pluginUrl = new URL("../src/openclaw-platform-plugin.js", import.meta.url);

test("OpenClaw main-Agent instructions use the dynamic platform frontdoor, not the legacy fixed relay", async () => {
  const instructions = await readFile(instructionsUrl, "utf8");

  assert.match(instructions, /orchestrate_household_agents/);
  assert.match(instructions, /不要调用旧的固定转发工具 `talk_to_device_manager`/);
  assert.match(instructions, /不要直接调用设备管家插件的任何工具/);
  assert.doesNotMatch(instructions, /当用户提出家庭[^\n]*调用 `talk_to_device_manager`/);
  assert.match(instructions, /多设备请求必须作为一个完整的 `device_action` 任务/);
  assert.match(instructions, /只重提一次/);
  assert.match(instructions, /decision=clarify/);
  assert.match(instructions, /decision=unsupported/);
  assert.match(instructions, /不得猜造 ID 或能力名/);

  const pluginSource = await readFile(pluginUrl, "utf8");
  assert.match(pluginSource, /MULTIPLE_DEVICE_ACTION_STEPS_REQUIRE_AGGREGATION/);
  assert.match(pluginSource, /只自动重提一次/);
  assert.match(pluginSource, /Type\.Literal\("clarify"/);
  assert.match(pluginSource, /Type\.Literal\("unsupported"/);
  assert.match(pluginSource, /frontdoorDescription\(registeredAgents\)/);
  assert.match(pluginSource, /多个现有能力可以组合完成的任务/);
});
