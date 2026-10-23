import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function unpack(result) {
  const text = result?.content?.find((block) => block.type === "text")?.text;
  if (text) return JSON.parse(text);
  return result?.structuredContent ?? result;
}

test("OpenClaw 暴露提醒收件箱工具，但插件加载不会自动启动或写入", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-openclaw-routine-tools-"));
  const previous = {
    memory: process.env.FAMILY_MEMORY_PATH,
    inbox: process.env.DEVICE_MANAGER_ROUTINE_INBOX_PATH,
    timeZone: process.env.HOUSEHOLD_TIME_ZONE,
    schedule: process.env.DEVICE_MANAGER_ROUTINE_SCHEDULE_ENABLED,
  };
  process.env.FAMILY_MEMORY_PATH = path.join(directory, "family-memory.json");
  process.env.DEVICE_MANAGER_ROUTINE_INBOX_PATH = path.join(directory, "reminders.json");
  delete process.env.HOUSEHOLD_TIME_ZONE;
  delete process.env.DEVICE_MANAGER_ROUTINE_SCHEDULE_ENABLED;
  t.after(async () => {
    if (previous.memory === undefined) delete process.env.FAMILY_MEMORY_PATH;
    else process.env.FAMILY_MEMORY_PATH = previous.memory;
    if (previous.inbox === undefined) delete process.env.DEVICE_MANAGER_ROUTINE_INBOX_PATH;
    else process.env.DEVICE_MANAGER_ROUTINE_INBOX_PATH = previous.inbox;
    if (previous.timeZone === undefined) delete process.env.HOUSEHOLD_TIME_ZONE;
    else process.env.HOUSEHOLD_TIME_ZONE = previous.timeZone;
    if (previous.schedule === undefined) delete process.env.DEVICE_MANAGER_ROUTINE_SCHEDULE_ENABLED;
    else process.env.DEVICE_MANAGER_ROUTINE_SCHEDULE_ENABLED = previous.schedule;
    await fs.rm(directory, { recursive: true, force: true });
  });

  const { default: plugin } = await import(`../src/openclaw-plugin.js?routine-notifications=${Date.now()}-${Math.random()}`);
  const tools = new Map();
  plugin.register({ pluginConfig: {}, registerTool(tool) { tools.set(tool.name, tool); } });
  for (const name of [
    "check_household_routine_reminders",
    "start_household_routine_reminders",
    "stop_household_routine_reminders",
    "get_household_routine_reminder_status",
    "list_household_routine_reminders",
    "acknowledge_household_routine_reminder",
  ]) assert.ok(tools.has(name), `缺少 OpenClaw 工具 ${name}`);

  async function invoke(name, params = {}) {
    return unpack(await tools.get(name).execute(`test-${name}`, params, undefined, undefined));
  }
  const status = await invoke("get_household_routine_reminder_status");
  assert.equal(status.schedule_authorized, false);
  assert.equal(status.user_consent_enabled, false);
  assert.equal(status.runner.running, false);
  assert.equal(JSON.stringify(status).includes(directory), false, "不得向模型泄漏本地收件箱绝对路径");
  assert.equal((await invoke("check_household_routine_reminders")).error.code, "HOUSEHOLD_TIME_ZONE_REQUIRED");
  assert.equal((await invoke("start_household_routine_reminders")).error.code, "HOUSEHOLD_TIME_ZONE_REQUIRED");
  assert.deepEqual((await invoke("list_household_routine_reminders")).notifications, []);
  assert.equal(await fs.stat(path.join(directory, "reminders.json")).then(() => true).catch(() => false), false,
    "读取空收件箱不得创建文件");
});

