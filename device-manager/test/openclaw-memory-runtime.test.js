import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PreferenceMemoryStore } from "../../agent-memory/src/memory-store.js";

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

test("OpenClaw SDK 暴露持久观察授权，但不允许模型伪造观察证据", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-openclaw-memory-runtime-"));
  const previousMemoryPath = process.env.FAMILY_MEMORY_PATH;
  const previousMemoryBackend = process.env.FAMILY_MEMORY_BACKEND;
  const previousDatabasePath = process.env.FAMILY_MEMORY_DB_PATH;
  process.env.FAMILY_MEMORY_PATH = path.join(directory, "isolated-memory.json");
  process.env.FAMILY_MEMORY_BACKEND = "json";
  delete process.env.FAMILY_MEMORY_DB_PATH;
  t.after(async () => {
    if (previousMemoryPath === undefined) delete process.env.FAMILY_MEMORY_PATH;
    else process.env.FAMILY_MEMORY_PATH = previousMemoryPath;
    if (previousMemoryBackend === undefined) delete process.env.FAMILY_MEMORY_BACKEND;
    else process.env.FAMILY_MEMORY_BACKEND = previousMemoryBackend;
    if (previousDatabasePath === undefined) delete process.env.FAMILY_MEMORY_DB_PATH;
    else process.env.FAMILY_MEMORY_DB_PATH = previousDatabasePath;
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
  assert.equal(registeredTools.has("propose_household_memory_candidate"), false,
    "对话模型不得自行伪造习惯观察的事件、日期或置信度");

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

  const enabled = await invoke("set_household_observation_consent", {
    enabled: true,
    user_explicit_confirmation: true,
  });
  assert.equal(enabled.enabled, true);
  assert.equal((await invoke("get_household_observation_consent", {})).enabled, true);

  assert.equal((await invoke("get_household_device_action_observation_consent", {})).enabled, false);
  const deviceLearningEnabled = await invoke("set_household_device_action_observation_consent", {
    enabled: true,
    user_explicit_confirmation: true,
  });
  assert.equal(deviceLearningEnabled.enabled, true);
  const deviceLearningRevoked = await invoke("set_household_device_action_observation_consent", {
    enabled: false,
    user_explicit_confirmation: true,
  });
  assert.equal(deviceLearningRevoked.enabled, false);

  const prematurePreference = await invoke("get_household_preference", {
    memory_type: "sleep_time",
    time_zone: "Asia/Shanghai",
    day_type: "weekday",
  });
  assert.equal(prematurePreference, null);

  const preview = await invoke("preview_household_routine", {
    routine_type: "sleep_time",
    time_zone: "Asia/Shanghai",
    day_type: "weekday",
  });
  assert.equal(preview.status, "NO_CONFIRMED_PREFERENCE");
  assert.equal(preview.automation_enabled, false);
  assert.equal(preview.execution_performed, false);

  const revoked = await invoke("set_household_observation_consent", {
    enabled: false,
    user_explicit_confirmation: true,
  });
  assert.equal(revoked.enabled, false);
  assert.equal(revoked.deleted_inferred_memory_count, 0);
  assert.equal((await invoke("get_household_observation_consent", {})).enabled, false);

  const forgotten = await invoke("forget_household_memory", { memory_id: remembered.memory.memory_id });
  assert.equal(forgotten.deleted, true);
  assert.equal(await fs.stat(process.env.FAMILY_MEMORY_PATH).then(() => true), true);
  assert.equal(await fs.stat(path.join(directory, "family-memory-v0.1.json")).then(() => true).catch(() => false), false);
});

test("OpenClaw 设备管家记忆工具可通过配置写入 SQLite，并在服务停止时关闭数据库", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-openclaw-memory-sqlite-"));
  const previous = {
    backend: process.env.FAMILY_MEMORY_BACKEND,
    database: process.env.FAMILY_MEMORY_DB_PATH,
    json: process.env.FAMILY_MEMORY_PATH,
  };
  const databasePath = path.join(directory, "gateway-state", "family-memory.sqlite");
  const jsonPath = path.join(directory, "should-not-be-used.json");
  process.env.FAMILY_MEMORY_BACKEND = "sqlite";
  process.env.FAMILY_MEMORY_DB_PATH = databasePath;
  process.env.FAMILY_MEMORY_PATH = jsonPath;

  let stopMemoryService;
  t.after(async () => {
    try { await stopMemoryService?.(); } catch {}
    if (previous.backend === undefined) delete process.env.FAMILY_MEMORY_BACKEND;
    else process.env.FAMILY_MEMORY_BACKEND = previous.backend;
    if (previous.database === undefined) delete process.env.FAMILY_MEMORY_DB_PATH;
    else process.env.FAMILY_MEMORY_DB_PATH = previous.database;
    if (previous.json === undefined) delete process.env.FAMILY_MEMORY_PATH;
    else process.env.FAMILY_MEMORY_PATH = previous.json;
    await fs.rm(directory, { recursive: true, force: true });
  });

  const { default: plugin } = await import(`../src/openclaw-plugin.js?sqlite-memory=${Date.now()}`);
  const registeredTools = new Map();
  const registeredServices = new Map();
  plugin.register({
    pluginConfig: {},
    registerTool(tool) { registeredTools.set(tool.name, tool); },
    registerService(service) { registeredServices.set(service.id, service); },
  });
  const memoryService = registeredServices.get("device-manager-household-memory");
  assert.ok(memoryService);
  await memoryService.start({ logger: { info() {} } });
  stopMemoryService = () => memoryService.stop();

  async function invoke(name, params) {
    const tool = registeredTools.get(name);
    assert.ok(tool, `OpenClaw 插件未注册工具 ${name}`);
    return unpackToolResult(await tool.execute(`test-${name}`, params, undefined, undefined));
  }

  const saved = await invoke("remember_household_preference", {
    memory_type: "comfort_temperature_c",
    value: 22,
    room_id: "living_room",
    user_explicit_request: true,
  });
  assert.equal(saved.success, true);
  assert.equal((await invoke("get_household_preference", {
    memory_type: "comfort_temperature_c",
    room_id: "living_room",
  })).value, 22);
  assert.equal(await fs.stat(databasePath).then(() => true), true);
  assert.equal(await fs.stat(jsonPath).then(() => true).catch(() => false), false);

  const reopened = new PreferenceMemoryStore({ backend: "sqlite", databasePath });
  try {
    assert.equal((await reopened.getPreference({ memory_type: "comfort_temperature_c", room_id: "living_room" })).value, 22);
  } finally {
    reopened.close();
  }
});

test("OpenClaw 插件级 SQLite 配置优先于旧环境变量并使用指定家庭数据库", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-openclaw-memory-plugin-config-"));
  const previous = {
    backend: process.env.FAMILY_MEMORY_BACKEND,
    database: process.env.FAMILY_MEMORY_DB_PATH,
    json: process.env.FAMILY_MEMORY_PATH,
  };
  const databasePath = path.join(directory, "profile", "device-manager", "family-memory.sqlite");
  const legacyDatabasePath = path.join(directory, "legacy", "should-not-be-used.sqlite");
  const jsonPath = path.join(directory, "should-not-be-used.json");
  process.env.FAMILY_MEMORY_BACKEND = "json";
  process.env.FAMILY_MEMORY_DB_PATH = legacyDatabasePath;
  process.env.FAMILY_MEMORY_PATH = jsonPath;

  let stopMemoryService;
  t.after(async () => {
    try { await stopMemoryService?.(); } catch {}
    if (previous.backend === undefined) delete process.env.FAMILY_MEMORY_BACKEND;
    else process.env.FAMILY_MEMORY_BACKEND = previous.backend;
    if (previous.database === undefined) delete process.env.FAMILY_MEMORY_DB_PATH;
    else process.env.FAMILY_MEMORY_DB_PATH = previous.database;
    if (previous.json === undefined) delete process.env.FAMILY_MEMORY_PATH;
    else process.env.FAMILY_MEMORY_PATH = previous.json;
    await fs.rm(directory, { recursive: true, force: true });
  });

  const { default: plugin } = await import(`../src/openclaw-plugin.js?sqlite-plugin-config=${Date.now()}`);
  const registeredTools = new Map();
  const registeredServices = new Map();
  plugin.register({
    pluginConfig: { memoryBackend: "sqlite", memoryDatabasePath: databasePath },
    registerTool(tool) { registeredTools.set(tool.name, tool); },
    registerService(service) { registeredServices.set(service.id, service); },
  });
  const memoryService = registeredServices.get("device-manager-household-memory");
  assert.ok(memoryService);
  await memoryService.start({ logger: { info() {} } });
  stopMemoryService = () => memoryService.stop();

  const result = unpackToolResult(await registeredTools.get("remember_household_preference").execute("configured-sqlite", {
    memory_type: "comfort_temperature_c",
    value: 21.5,
    room_id: "bedroom",
    user_explicit_request: true,
  }));
  assert.equal(result.success, true);
  assert.equal(await fs.stat(databasePath).then(() => true), true);
  assert.equal(await fs.stat(legacyDatabasePath).then(() => true).catch(() => false), false);
  assert.equal(await fs.stat(jsonPath).then(() => true).catch(() => false), false);
});

test("OpenClaw 记忆工具完成候选展示、确认/拒绝、撤回授权；Mock 学习演示只用临时数据", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-openclaw-memory-interaction-"));
  const previousMemoryPath = process.env.FAMILY_MEMORY_PATH;
  const previousTimeZone = process.env.HOUSEHOLD_TIME_ZONE;
  const memoryPath = path.join(directory, "isolated-memory.json");
  process.env.FAMILY_MEMORY_PATH = memoryPath;
  process.env.HOUSEHOLD_TIME_ZONE = "Asia/Shanghai";
  t.after(async () => {
    if (previousMemoryPath === undefined) delete process.env.FAMILY_MEMORY_PATH;
    else process.env.FAMILY_MEMORY_PATH = previousMemoryPath;
    if (previousTimeZone === undefined) delete process.env.HOUSEHOLD_TIME_ZONE;
    else process.env.HOUSEHOLD_TIME_ZONE = previousTimeZone;
    await fs.rm(directory, { recursive: true, force: true });
  });

  const { default: plugin } = await import(`../src/openclaw-plugin.js?memory-interaction=${Date.now()}`);
  const registeredTools = new Map();
  plugin.register({
    pluginConfig: {},
    registerTool(tool) { registeredTools.set(tool.name, tool); },
  });
  async function invoke(name, params) {
    const tool = registeredTools.get(name);
    assert.ok(tool, `OpenClaw 插件未注册工具 ${name}`);
    return unpackToolResult(await tool.execute(`test-${name}`, params, undefined, undefined));
  }

  const enabled = await invoke("set_household_device_action_observation_consent", {
    enabled: true,
    user_explicit_confirmation: true,
  });
  assert.equal(enabled.enabled, true);

  const store = new PreferenceMemoryStore({ filePath: memoryPath });
  let seededCandidate;
  for (const [index, date] of ["2026-10-12", "2026-10-13", "2026-10-14"].entries()) {
    const result = await store.proposeInferredCandidate({
      memory_type: "comfort_brightness_pct",
      value: 65,
      room_id: "study",
      event_id: `synthetic-confirm-${index}`,
      observation_date: date,
      observation_scope: "device_action",
      confidence: 0.9,
      consent_to_observe: true,
    });
    assert.equal(result.success, true);
    seededCandidate = result.memory;
  }

  assert.equal((await invoke("get_household_preference", {
    memory_type: "comfort_brightness_pct",
    room_id: "study",
  })), null, "候选在确认前不能作为已确认偏好读取");
  const listed = await invoke("list_household_memories", { include_pending: true });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].memory_id, seededCandidate.memory_id);
  assert.equal(listed[0].status, "pending_confirmation");

  const denied = await invoke("confirm_household_memory_candidate", {
    memory_id: seededCandidate.memory_id,
    user_confirmed: false,
  });
  assert.equal(denied.success, false);
  assert.equal(denied.error.code, "USER_CONFIRMATION_REQUIRED");
  const confirmed = await invoke("confirm_household_memory_candidate", {
    memory_id: seededCandidate.memory_id,
    user_confirmed: true,
  });
  assert.equal(confirmed.success, true);
  assert.equal((await invoke("get_household_preference", {
    memory_type: "comfort_brightness_pct",
    room_id: "study",
  })).value, 65);

  const revoked = await invoke("set_household_device_action_observation_consent", {
    enabled: false,
    user_explicit_confirmation: true,
  });
  assert.equal(revoked.enabled, false);
  assert.equal(revoked.deleted_inferred_memory_count, 1);
  assert.equal(await invoke("get_household_preference", {
    memory_type: "comfort_brightness_pct",
    room_id: "study",
  }), null, "撤回设备观察授权会清理由该来源推断的正式偏好");

  await invoke("set_household_device_action_observation_consent", {
    enabled: true,
    user_explicit_confirmation: true,
  });
  for (const [index, date] of ["2026-10-12", "2026-10-13", "2026-10-14"].entries()) {
    await store.proposeInferredCandidate({
      memory_type: "comfort_brightness_pct",
      value: 60,
      room_id: "study",
      event_id: `synthetic-reject-${index}`,
      observation_date: date,
      observation_scope: "device_action",
      confidence: 0.9,
      consent_to_observe: true,
    });
  }
  const secondCandidate = (await invoke("list_household_memories", { include_pending: true }))[0];
  const rejected = await invoke("forget_household_memory", { memory_id: secondCandidate.memory_id });
  assert.equal(rejected.deleted, true, "删除待确认候选就是拒绝该次推测，不会变成偏好");
  assert.deepEqual(await invoke("list_household_memories", { include_pending: true }), []);

  const demo = await invoke("run_mock_household_memory_learning_demo", { scenario: "device_preferences" });
  assert.equal(demo.scenarios.length, 2);
  assert.equal(demo.real_home_assistant_connected, false);
  assert.equal(demo.real_event_source_verified, false);
  assert.equal(demo.storage, "临时测试目录；演示结束后删除，不写入家庭正式记忆");
  assert.equal(demo.post_confirmation_device_action_performed, false);
  assert.equal(await store.getPreference({ memory_type: "comfort_brightness_pct", room_id: "study" }), null,
    "Mock 演示不得写入插件正式家庭记忆文件");

  assert.equal(await fs.stat(memoryPath).then(() => true), true);
  const persisted = await fs.readFile(memoryPath, "utf8");
  assert.equal(persisted.includes("synthetic-confirm"), false);
  assert.equal(persisted.includes("synthetic-reject"), false);
});
