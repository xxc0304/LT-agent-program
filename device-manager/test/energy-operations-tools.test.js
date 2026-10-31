import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createEnergyOperationsTools,
  ENERGY_OPERATIONS_TOOL_DEFINITIONS,
  ENERGY_OPTIMIZATION_CALCULATOR_TOOL_DEFINITION,
} from "../src/energy-operations-tools.js";
import { MaintenanceScheduleStore } from "../src/maintenance-store.js";
import { MaintenanceReminderInbox } from "../src/maintenance-reminder-inbox.js";

function unpack(result) {
  const text = result?.content?.find((block) => block.type === "text")?.text;
  if (text) return JSON.parse(text);
  return result?.structuredContent ?? result;
}

test("节能分析与效果比较工具只处理调用者提供的数据", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-energy-tools-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tools = createEnergyOperationsTools({
    maintenanceStore: new MaintenanceScheduleStore({ filePath: path.join(directory, "maintenance.json") }),
  });

  const analysis = await tools.analyze_energy_usage({
    timezone: "Asia/Shanghai",
    readings: [{ device_id: "meter.room", recorded_at: "2026-10-17T00:00:00.000Z", interval_kwh: 0.4 }],
  });
  assert.equal(analysis.success, true);
  assert.equal(analysis.source, "CALLER_SUPPLIED_DATA_ONLY");
  assert.equal(analysis.report.analysis.summary.total_kwh, 0.4);
  assert.equal(analysis.report.side_effects.device_control_performed, false);

  const effect = await tools.evaluate_energy_effect({
    device_ids: ["meter.room"],
    interval_minutes: 60,
    baseline: {
      start_at: "2026-10-17T00:00:00.000Z",
      end_at: "2026-10-17T01:00:00.000Z",
      readings: [{ device_id: "meter.room", recorded_at: "2026-10-17T01:00:00.000Z", interval_kwh: 1 }],
    },
    follow_up: {
      start_at: "2026-10-18T00:00:00.000Z",
      end_at: "2026-10-18T01:00:00.000Z",
      readings: [{ device_id: "meter.room", recorded_at: "2026-10-18T01:00:00.000Z", interval_kwh: 0.7 }],
    },
  });
  assert.equal(effect.report.status, "COMPARABLE");
  assert.equal(effect.report.observed_change.baseline_minus_follow_up_kwh, 0.3);
  assert.equal(effect.report.causality, "NOT_ESTABLISHED_BY_BEFORE_AFTER_COMPARISON");
  assert.equal((await tools.analyze_energy_usage({ readings: [] })).report.analysis.status, "INSUFFICIENT_DATA");
});

test("OpenClaw 维护工具保存计划、生成提醒并在显式确认后记录完成", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-maintenance-tools-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "maintenance.json");
  const store = new MaintenanceScheduleStore({ filePath });
  const inbox = new MaintenanceReminderInbox({ filePath: path.join(directory, "reminders.json") });
  const tools = createEnergyOperationsTools({ maintenanceStore: store, reminderInbox: inbox });
  const nowMs = Date.now();

  const saved = await tools.save_maintenance_schedule({
    maintenance_schedule: {
      schedule_id: "filter-main",
      device_id: "air.purifier.main",
      device_name: "主卧空气净化器",
      maintenance_type: "filter_replacement",
      next_due_at: new Date(nowMs + 2 * 24 * 60 * 60 * 1000).toISOString(),
      interval_days: 30,
      usage_since_service: 88,
      usage_limit: 100,
      usage_unit: "hours",
    },
  });
  assert.equal(saved.success, true);
  const plan = await tools.get_device_maintenance_plan({ now: new Date(nowMs).toISOString() });
  assert.equal(plan.plan.summary.due_soon_count, 1);
  assert.equal(plan.plan.safety.device_control_performed, false);
  assert.equal(JSON.stringify(plan).includes(filePath), false, "工具响应不泄露本地存储绝对路径");
  const queued = await inbox.upsertDueReminders({
    plan_items: plan.plan.items,
    schedules: await store.listSchedules(),
    observed_at: new Date(nowMs).toISOString(),
  });
  assert.equal(queued.created, 1);

  const refused = await tools.record_device_maintenance_completed({ schedule_id: "filter-main", user_confirmed: false });
  assert.equal(refused.error.code, "EXPLICIT_CONFIRMATION_REQUIRED");
  const completed = await tools.record_device_maintenance_completed({ schedule_id: "filter-main", user_confirmed: true });
  assert.equal(completed.completion_recorded, true);
  assert.equal(completed.physical_maintenance_performed_by_agent, false);
  assert.equal(completed.schedule.usage_since_service, 0);
  assert.equal(completed.reminder_resolution.resolved_count, 1);
  assert.equal((await inbox.list()).notifications.length, 0);
  const resolved = await inbox.list({ include_completed: true });
  assert.equal(resolved.notifications.length, 1);
  assert.equal(resolved.notifications[0].status, "completed");
  assert.equal(resolved.notifications[0].completed_at, completed.completion.completed_at);
  const refreshed = await tools.get_device_maintenance_plan({ now: new Date().toISOString() });
  assert.equal(refreshed.plan.items[0].maintenance_status, "SCHEDULED");
  assert.equal(refreshed.recent_completions.length, 1);
  const retried = await tools.record_device_maintenance_completed({ schedule_id: "filter-main", user_confirmed: true });
  assert.equal(retried.duplicate, true);
  assert.equal(retried.reminder_resolution.resolved_count, 0);
  assert.equal((await store.listCompletions()).length, 1);
});

test("OpenClaw 维护工具把并发写锁冲突明确返回，不伪报保存或完成", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-maintenance-lock-tools-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "maintenance.json");
  const store = new MaintenanceScheduleStore({ filePath, lockWaitMs: 10 });
  const tools = createEnergyOperationsTools({ maintenanceStore: store });
  const original = {
    schedule_id: "filter-main",
    device_id: "air.purifier.main",
    device_name: "主卧空气净化器",
    maintenance_type: "filter_replacement",
    interval_days: 30,
    last_completed_at: "2026-09-18T00:00:00.000Z",
  };
  assert.equal((await tools.save_maintenance_schedule({ maintenance_schedule: original })).success, true);

  const lockPath = `${filePath}.lock`;
  const lockText = JSON.stringify({ token: "other-writer", pid: process.pid, created_at: new Date().toISOString() });
  await fs.writeFile(lockPath, lockText, { encoding: "utf8", flag: "wx" });
  const update = await tools.save_maintenance_schedule({
    maintenance_schedule: { ...original, device_name: "不应保存" },
  });
  assert.equal(update.success, false);
  assert.equal(update.error.code, "MAINTENANCE_STORE_LOCKED");
  const plan = await tools.get_device_maintenance_plan();
  assert.equal(plan.success, false);
  assert.equal(plan.error.code, "MAINTENANCE_STORE_LOCKED");

  const completion = await tools.record_device_maintenance_completed({
    schedule_id: "filter-main",
    user_confirmed: true,
  });
  assert.equal(completion.success, false);
  assert.equal(completion.error.code, "MAINTENANCE_STORE_LOCKED");
  const unchanged = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.equal(unchanged.schedules[0].device_name, "主卧空气净化器");
  assert.equal(unchanged.completions.length, 0);
  assert.equal(await fs.readFile(lockPath, "utf8"), lockText);
  await fs.rm(lockPath);
  assert.equal((await store.listSchedules())[0].device_name, "主卧空气净化器");
  assert.equal((await store.listCompletions()).length, 0);
});

test("完成记录成功但提醒收件箱同步失败时返回显式部分成功", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-maintenance-partial-sync-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new MaintenanceScheduleStore({ filePath: path.join(directory, "maintenance.json") });
  await store.upsertSchedule({
    schedule_id: "filter-main",
    device_id: "air.purifier.main",
    maintenance_type: "filter_replacement",
    interval_days: 30,
    last_completed_at: "2026-09-18T00:00:00.000Z",
  });
  const tools = createEnergyOperationsTools({
    maintenanceStore: store,
    reminderInbox: {
      async completeForSchedule() {
        return { success: false, error: { code: "INBOX_LOCKED", message: "inbox busy" } };
      },
    },
  });
  const completed = await tools.record_device_maintenance_completed({ schedule_id: "filter-main", user_confirmed: true });
  assert.equal(completed.completion_recorded, true);
  assert.equal(completed.reminder_resolution.success, false);
  assert.equal(completed.reminder_resolution.error.code, "INBOX_LOCKED");
  assert.equal((await store.listCompletions()).length, 1);
});

test("维护计划工具默认返回最新 20 条完成记录并回传分页元数据", async () => {
  const completions = Array.from({ length: 25 }, (_, index) => ({
    record_id: `record-${index}`,
    schedule_id: "filter-main",
    device_id: "air.purifier.main",
    completed_at: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
    recorded_at: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
  }));
  const tools = createEnergyOperationsTools({
    maintenanceStore: {
      async listSchedules() { return []; },
      async listCompletions() { return completions; },
      async upsertSchedule() { throw new Error("not used"); },
      async recordCompletion() { throw new Error("not used"); },
    },
  });
  const result = await tools.get_device_maintenance_plan();
  assert.equal(result.recent_completions.length, 20);
  assert.equal(result.recent_completions[0].record_id, "record-24");
  assert.equal(result.recent_completions.at(-1).record_id, "record-5");
  assert.equal(result.completion_history_page.total_count, 25);
  assert.equal(result.completion_history_page.next_offset, 20);
  assert.equal(result.completion_history_page.next_cursor, "record-5");
});

test("维护完成历史支持稳定游标分页，翻页期间新增记录不会挤掉较早历史", async () => {
  const makeCompletion = (index) => ({
    record_id: `history-${index}`,
    schedule_id: "filter-main",
    device_id: "air.purifier.main",
    completed_at: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    recorded_at: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
  });
  const completions = Array.from({ length: 5 }, (_, index) => makeCompletion(index));
  const tools = createEnergyOperationsTools({
    maintenanceStore: {
      async listSchedules() { return []; },
      async listCompletions() { return completions; },
      async upsertSchedule() { throw new Error("not used"); },
      async recordCompletion() { throw new Error("not used"); },
    },
  });

  const first = await tools.get_device_maintenance_plan({ completion_limit: 2 });
  assert.deepEqual(first.recent_completions.map((item) => item.record_id), ["history-4", "history-3"]);
  assert.equal(first.completion_history_page.total_count, 5);
  assert.equal(first.completion_history_page.next_offset, 2);
  assert.equal(first.completion_history_page.next_cursor, "history-3");

  completions.push({
    record_id: "history-newer",
    schedule_id: "filter-main",
    device_id: "air.purifier.main",
    completed_at: "2026-02-01T00:00:00.000Z",
    recorded_at: "2026-02-01T00:00:00.000Z",
  });
  const second = await tools.get_device_maintenance_plan({ completion_limit: 2, completion_cursor: first.completion_history_page.next_cursor });
  assert.deepEqual(second.recent_completions.map((item) => item.record_id), ["history-2", "history-1"]);
  assert.equal(second.completion_history_page.total_count, 6);
  assert.equal(second.completion_history_page.next_cursor, "history-1");
  const third = await tools.get_device_maintenance_plan({ completion_limit: 2, completion_cursor: second.completion_history_page.next_cursor });
  assert.deepEqual(third.recent_completions.map((item) => item.record_id), ["history-0"]);
  assert.equal(third.completion_history_page.next_cursor, null);
  completions.push({
    record_id: "other-schedule-entry",
    schedule_id: "water-filter",
    device_id: "water.filter.main",
    completed_at: "2026-02-02T00:00:00.000Z",
    recorded_at: "2026-02-02T00:00:00.000Z",
  });
  const filtered = await tools.get_device_maintenance_plan({ completion_schedule_id: "water-filter", completion_limit: 2 });
  assert.deepEqual(filtered.recent_completions.map((item) => item.record_id), ["other-schedule-entry"]);
  assert.equal(filtered.completion_history_page.total_count, 1);
  assert.equal(filtered.completion_history_page.schedule_id_filter, "water-filter");
  assert.equal((await tools.get_device_maintenance_plan({ completion_limit: 2, completion_offset: 1, completion_cursor: "history-3" })).error.code, "INVALID_COMPLETION_HISTORY_OPTIONS");
  assert.equal((await tools.get_device_maintenance_plan({ completion_limit: 2, completion_cursor: "missing" })).error.code, "INVALID_COMPLETION_HISTORY_CURSOR");
  assert.equal((await tools.get_device_maintenance_plan({ completion_limit: 51 })).error.code, "INVALID_COMPLETION_HISTORY_OPTIONS");
  assert.equal((await tools.get_device_maintenance_plan({ completion_schedule_id: " " })).error.code, "INVALID_COMPLETION_HISTORY_OPTIONS");
});

test("OpenClaw 插件注册能耗和维护工具，并将预算估算限制在能源管家会话", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-openclaw-energy-maintenance-"));
  const previous = {
    memory: process.env.FAMILY_MEMORY_PATH,
    maintenance: process.env.DEVICE_MANAGER_MAINTENANCE_SCHEDULE_PATH,
    inventory: process.env.DEVICE_MANAGER_INVENTORY_PATH,
    approval: process.env.DEVICE_MANAGER_APPROVAL_STATE_PATH,
  };
  process.env.FAMILY_MEMORY_PATH = path.join(directory, "memory.json");
  process.env.DEVICE_MANAGER_MAINTENANCE_SCHEDULE_PATH = path.join(directory, "maintenance.json");
  process.env.DEVICE_MANAGER_INVENTORY_PATH = path.join(directory, "inventory.json");
  process.env.DEVICE_MANAGER_APPROVAL_STATE_PATH = path.join(directory, "approval.json");
  t.after(async () => {
    for (const [name, value] of Object.entries(previous)) {
      const key = name === "memory" ? "FAMILY_MEMORY_PATH"
        : name === "maintenance" ? "DEVICE_MANAGER_MAINTENANCE_SCHEDULE_PATH"
          : name === "inventory" ? "DEVICE_MANAGER_INVENTORY_PATH" : "DEVICE_MANAGER_APPROVAL_STATE_PATH";
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  const { default: plugin } = await import(`../src/openclaw-plugin.js?energy-maintenance=${Date.now()}-${Math.random()}`);
  const registered = new Map();
  let calculatorFactory;
  let calculatorReply = "";
  let messageReadCount = 0;
  const subagentCalls = [];
  const runtimeConfig = {
    session: { mainKey: "main" },
    tools: {
      sessions: { visibility: "all" },
      agentToAgent: { enabled: true, allow: ["device-manager", "energy-saving"] },
    },
  };
  const subagent = {
    async getSessionMessages(params) {
      subagentCalls.push({ method: "getSessionMessages", params });
      messageReadCount += 1;
      return messageReadCount === 1
        ? { messages: [] }
        : { messages: [{ role: "assistant", content: [{ type: "text", text: calculatorReply }] }] };
    },
    async run(params) {
      subagentCalls.push({ method: "run", params });
      const envelope = JSON.parse(params.message);
      const calculatorTool = calculatorFactory({
        agentId: "energy-saving",
        sessionKey: "agent:energy-saving:main",
        getRuntimeConfig: () => runtimeConfig,
      });
      assert.ok(calculatorTool, "能源管家会话应能获得只读计算工具");
      const report = unpack(await calculatorTool.execute("calculator-tool-call", envelope.input));
      calculatorReply = JSON.stringify(report);
      return { runId: "run-energy-optimization-test" };
    },
    async waitForRun() { return { status: "ok" }; },
  };
  plugin.register({
    pluginConfig: {},
    config: runtimeConfig,
    runtime: { subagent },
    registerTool(tool, options) {
      const name = options?.name ?? tool.name;
      registered.set(name, tool);
      if (name === "calculate_energy_optimization") calculatorFactory = tool;
    },
  });
  const names = [
    ...ENERGY_OPERATIONS_TOOL_DEFINITIONS.map(({ name }) => name),
    ENERGY_OPTIMIZATION_CALCULATOR_TOOL_DEFINITION.name,
  ];
  for (const name of names) assert.ok(registered.has(name), `缺少 OpenClaw 工具 ${name}`);
  const optimizationSchema = ENERGY_OPERATIONS_TOOL_DEFINITIONS.find((tool) => tool.name === "plan_energy_optimization")?.inputSchema;
  const tariffSchema = optimizationSchema?.properties?.tariff;
  const tariffSegmentSchema = tariffSchema?.properties?.segments?.items;
  assert.equal(tariffSchema?.type, "object");
  assert.deepEqual(tariffSegmentSchema?.required?.slice().sort(), ["end", "name", "price_per_kwh", "start"]);
  assert.deepEqual(
    tariffSegmentSchema?.properties?.tier?.anyOf?.map((entry) => entry.const).sort(),
    ["off_peak", "peak", "shoulder"],
  );
  assert.match(tariffSegmentSchema?.properties?.end?.description ?? "", /午夜写 00:00/);
  assert.match(tariffSegmentSchema?.properties?.start?.pattern ?? "", /HH:mm|\\d/);
  assert.match(optimizationSchema?.properties?.flexible_loads?.items?.properties?.deadline_at?.description ?? "", /次日 00:00/);
  const planSchema = ENERGY_OPERATIONS_TOOL_DEFINITIONS.find((tool) => tool.name === "get_device_maintenance_plan")?.inputSchema;
  assert.deepEqual([planSchema?.properties?.completion_limit?.minimum, planSchema?.properties?.completion_limit?.maximum], [1, 50]);
  assert.equal(planSchema?.properties?.completion_cursor?.type, "string");
  assert.equal(planSchema?.properties?.completion_schedule_id?.type, "string");

  const energySessionContext = {
    agentId: "energy-saving",
    sessionKey: "agent:energy-saving:main",
    sandboxed: false,
    getRuntimeConfig: () => runtimeConfig,
  };
  const managerSessionContext = {
    agentId: "device-manager",
    sessionKey: "agent:device-manager:main",
    sandboxed: false,
    getRuntimeConfig: () => runtimeConfig,
  };
  const invoke = async (name, params, context) => {
    const registeredTool = registered.get(name);
    const tool = ["analyze_energy_usage", "evaluate_energy_effect", "forecast_energy_budget", "calculate_energy_optimization"].includes(name)
      ? registeredTool(context)
      : registeredTool;
    assert.ok(tool, `${name} 应在当前 Agent 会话中注册`);
    return unpack(await tool.execute(`test-${name}`, params, undefined, undefined));
  };
  for (const name of ["analyze_energy_usage", "evaluate_energy_effect"]) {
    assert.equal(registered.get(name)(managerSessionContext), null, `${name} 不得向设备管家会话暴露`);
    assert.ok(registered.get(name)(energySessionContext), `${name} 应开放给能源管家会话`);
  }
  const result = await invoke("analyze_energy_usage", {
    readings: [{ device_id: "meter.mock", recorded_at: "2026-10-17T00:00:00.000Z", interval_kwh: 0.2 }],
  }, energySessionContext);
  assert.equal(result.success, true);
  assert.equal(result.report.analysis.summary.total_kwh, 0.2);
  const effectResult = await invoke("evaluate_energy_effect", {
    device_ids: ["meter.mock"],
    interval_minutes: 60,
    baseline: {
      start_at: "2026-10-17T00:00:00.000Z",
      end_at: "2026-10-17T01:00:00.000Z",
      readings: [{ device_id: "meter.mock", recorded_at: "2026-10-17T01:00:00.000Z", interval_kwh: 1 }],
    },
    follow_up: {
      start_at: "2026-10-18T00:00:00.000Z",
      end_at: "2026-10-18T01:00:00.000Z",
      readings: [{ device_id: "meter.mock", recorded_at: "2026-10-18T01:00:00.000Z", interval_kwh: 0.7 }],
    },
  }, energySessionContext);
  assert.equal(effectResult.report.status, "COMPARABLE");
  const deviceManagerTool = registered.get("plan_energy_optimization")({
    ...managerSessionContext,
  });
  assert.ok(deviceManagerTool);
  assert.equal(registered.get("calculate_energy_optimization")({
    agentId: "device-manager",
    sessionKey: "agent:device-manager:main",
    sandboxed: false,
  }), null, "内部计算工具不得向设备管家会话暴露");
  const energyCalculatorTool = calculatorFactory({
    ...energySessionContext,
  });
  assert.ok(energyCalculatorTool);
  const forecastFactory = registered.get("forecast_energy_budget");
  assert.equal(forecastFactory({
    agentId: "device-manager",
    sessionKey: "agent:device-manager:main",
    sandboxed: false,
  }), null, "预算估算工具不得向设备管家会话暴露");
  const forecastTool = forecastFactory({
    ...energySessionContext,
  });
  assert.ok(forecastTool, "能源管家会话应能获得预算估算工具");
  const forecastResult = unpack(await forecastTool.execute("forecast-tool-call", {
    budget_kwh: 100,
    period_start: "2026-10-01",
    period_end: "2026-10-31",
    through_date: "2026-10-03",
    coverage_attested_complete: true,
    daily_totals: [
      { date: "2026-10-01", energy_kwh: 2 },
      { date: "2026-10-02", energy_kwh: 3 },
      { date: "2026-10-03", energy_kwh: 4 },
    ],
  }));
  assert.equal(forecastResult.success, true);
  assert.equal(forecastResult.report.estimate.projected_period_kwh, 93);
  const optimizationInput = {
    timezone: "Asia/Shanghai",
    readings: [],
    tariff: {
      currency: "CNY",
      segments: [
        { name: "low", tier: "off_peak", start: "00:00", end: "12:00", price_per_kwh: 0.3 },
        { name: "high", tier: "peak", start: "12:00", end: "00:00", price_per_kwh: 1.2 },
      ],
    },
    flexible_loads: [{
      load_id: "plugin-test-load",
      name: "测试负载",
      energy_kwh: 0.5,
      duration_minutes: 60,
      earliest_start: new Date().toISOString(),
      deadline_at: new Date(Date.now() + 5 * 60 * 60_000).toISOString(),
      user_marked_flexible: true,
    }],
  };
  const optimization = unpack(await deviceManagerTool.execute("energy-opt-tool-call", optimizationInput));
  assert.equal(optimization.success, true, JSON.stringify(optimization));
  assert.equal(optimization.source, "CALLER_SUPPLIED_DATA_ONLY");
  assert.equal(optimization.delegated_to, "energy-saving");
  const subagentRun = subagentCalls.find((call) => call.method === "run");
  assert.equal(subagentRun.params.sessionKey, "agent:energy-saving:main");
  const delegatedEnvelope = JSON.parse(subagentRun.params.message);
  assert.equal(delegatedEnvelope.operation, "plan_energy_optimization");
  assert.equal(delegatedEnvelope.contract, "energy_optimization");
  assert.equal(optimization.report.schedule_recommendations[0].status, "RECOMMENDATION_READY");
  assert.equal(optimization.report.execution.device_control_performed, false);
  assert.equal(optimization.device_action_workflow.status, "NO_ACTION_CANDIDATE");
  await invoke("save_maintenance_schedule", {
    maintenance_schedule: { schedule_id: "test-plan", device_id: "fan.mock", maintenance_type: "inspection" },
  });
  const plan = await invoke("get_device_maintenance_plan", {});
  assert.equal(plan.plan.summary.schedule_count, 1);
  assert.equal(plan.completion_history_page.total_count, 0);
  assert.equal(await fs.stat(path.join(directory, "maintenance.json")).then(() => true), true);
});
