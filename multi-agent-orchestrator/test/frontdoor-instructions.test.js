import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const instructionsUrl = new URL("../../openclaw-agents/dev/AGENTS.md", import.meta.url);
const energyInstructionsUrl = new URL("../../openclaw-agents/energy-saving/AGENTS.md", import.meta.url);
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
  assert.match(instructions, /至少 3 天/);
  assert.match(instructions, /只有 1–2 天数据/);
  assert.match(instructions, /结构化放入该步骤的 `input`/);
  assert.match(instructions, /每日项使用 `\{date, energy_kwh\}`/);
  assert.match(instructions, /调度器也会在调用 Agent 前拦截/);
  assert.match(instructions, /不得在同一份计划里同时追问并派发能源管家步骤/);
  assert.match(instructions, /不得猜造 ID 或能力名/);
  assert.match(instructions, /不得在主对话里自行计算来替代 Agent/);
  assert.match(instructions, /不得猜测电器故障/);
  assert.match(instructions, /自然、简短的中文/);
  assert.match(instructions, /不得点名或推测具体哪些设备\/读数有重叠/);

  const energyInstructions = await readFile(energyInstructionsUrl, "utf8");
  assert.match(energyInstructions, /capability=analyze_energy_usage/);
  assert.match(energyInstructions, /不得盲目重复调用/);
  assert.match(energyInstructions, /自行计算替代结果/);

  const pluginSource = await readFile(pluginUrl, "utf8");
  assert.match(pluginSource, /MULTIPLE_DEVICE_ACTION_STEPS_REQUIRE_AGGREGATION/);
  assert.match(pluginSource, /只自动重提一次/);
  assert.match(pluginSource, /Type\.Literal\("clarify"/);
  assert.match(pluginSource, /Type\.Literal\("unsupported"/);
  assert.match(pluginSource, /frontdoorDescription\(registeredAgents\)/);
  assert.match(pluginSource, /多个现有能力可以组合完成的任务/);
  assert.match(pluginSource, /账期预算进度估算有专门的数据门槛/);
  assert.match(pluginSource, /只提交 decision=clarify 追问缺失信息/);
  assert.match(pluginSource, /结构化放入该步骤的 input/);
  assert.match(pluginSource, /daily_totals 每项格式为 \{date, energy_kwh\}/);
  assert.match(pluginSource, /调度器还会在调用 Agent 前核对结构化数据/);
  assert.match(pluginSource, /不得在同一计划里一边追问一边派发能源管家步骤/);
  assert.match(pluginSource, /name: "analyze_energy_usage"/);
  assert.match(pluginSource, /name: "evaluate_energy_effect"/);
  assert.match(pluginSource, /name: "forecast_energy_budget"/);
  assert.match(pluginSource, /name: "plan_energy_optimization"/);
  assert.match(pluginSource, /不得用用户输入自行补算来替代 Agent/);
  assert.match(pluginSource, /面向普通家庭用户用自然、简短的中文交流/);
  assert.match(pluginSource, /不得猜测或点名具体哪些设备\/读数可能重叠/);
});
