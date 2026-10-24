import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PersistentDeviceEventLedger, resolveDeviceEventLedgerPath } from "../src/events.js";

const moduleUrl = new URL("../src/events.js", import.meta.url).href;

function tempPath() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "lt-persistent-device-events-"));
  return { directory, filePath: path.join(directory, "events.json") };
}

function runNode(script) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: { ...process.env },
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("持久事件账本跨进程恢复事件序号，并只存安全白名单字段", () => {
  const { directory, filePath } = tempPath();
  try {
    const ledger = new PersistentDeviceEventLedger({ filePath });
    const first = ledger.append({
      event_type: "action_executed",
      device_id: "light.living_room",
      severity: "info",
      data_level: "L1",
      trace_id: "trace-safe-01",
      payload: {
        action: "turn_off",
        verified: true,
        old_state: "on",
        new_state: "off",
        task_id: "must-not-persist",
        idempotency_key: "must-not-persist-either",
        message: "PRIVATE_CHAT_TEXT_MUST_NOT_PERSIST",
        token: "PRIVATE_TOKEN_MUST_NOT_PERSIST",
        arbitrary: { household: "PRIVATE_DATA_MUST_NOT_PERSIST" },
      },
    });
    assert.equal(first.event_id, "evt_000001");
    assert.deepEqual(first.payload, {
      action: "turn_off",
      verified: true,
      old_state: "on",
      new_state: "off",
    });

    const saved = readFileSync(filePath, "utf8");
    for (const secret of ["must-not-persist", "PRIVATE_CHAT_TEXT_MUST_NOT_PERSIST", "PRIVATE_TOKEN_MUST_NOT_PERSIST", "PRIVATE_DATA_MUST_NOT_PERSIST"]) {
      assert.equal(saved.includes(secret), false);
    }
    assert.equal(saved.includes("ha.local"), false);

    const output = runNode(`
      import { PersistentDeviceEventLedger } from ${JSON.stringify(moduleUrl)};
      const ledger = new PersistentDeviceEventLedger({ filePath: ${JSON.stringify(filePath)} });
      const before = ledger.list({ trace_id: "trace-safe-01" });
      const next = ledger.append({ event_type: "diagnostic_alert", device_id: "light.living_room", payload: { code: "DEVICE_OFFLINE", summary: "private summary" } });
      console.log(JSON.stringify({ before_count: before.length, first_id: before[0]?.event_id, next_id: next.event_id, next_payload: next.payload }));
    `);
    assert.deepEqual(JSON.parse(output), {
      before_count: 1,
      first_id: "evt_000001",
      next_id: "evt_000002",
      next_payload: { code: "DEVICE_OFFLINE" },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("并存的进程实例重新读取磁盘快照，不覆盖另一实例刚写入的事件", () => {
  const { directory, filePath } = tempPath();
  try {
    const first = new PersistentDeviceEventLedger({ filePath });
    const second = new PersistentDeviceEventLedger({ filePath });
    first.append({ event_type: "diagnostic_alert", device_id: "light.study", payload: { code: "DEVICE_OFFLINE" } });
    second.append({ event_type: "diagnostic_recovered", device_id: "light.study", payload: { previous_code: "DEVICE_OFFLINE" } });
    assert.deepEqual(first.list().map((event) => event.event_id), ["evt_000002", "evt_000001"]);
    assert.equal(first.length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("账本容量有界、查询过滤有效，且淘汰旧事件不重用序号", () => {
  const { directory, filePath } = tempPath();
  try {
    const ledger = new PersistentDeviceEventLedger({ filePath, retentionLimit: 2 });
    ledger.append({ event_type: "diagnostic_alert", device_id: "light.study", payload: { code: "DEVICE_OFFLINE" } });
    ledger.append({ event_type: "diagnostic_recovered", device_id: "light.study", payload: { previous_code: "DEVICE_OFFLINE" } });
    const third = ledger.append({ event_type: "diagnostic_alert", device_id: "switch.study", payload: { code: "DEVICE_OFFLINE" } });
    assert.equal(third.event_id, "evt_000003");
    assert.equal(ledger.length, 2);
    assert.deepEqual(ledger.list({ device_id: "light.study" }).map((event) => event.event_type), ["diagnostic_recovered"]);
    assert.equal(new PersistentDeviceEventLedger({ filePath, retentionLimit: 2 }).list({ limit: 200 }).length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("锁冲突和损坏账本失败关闭；未知事件类型不写入", () => {
  const { directory, filePath } = tempPath();
  try {
    const ledger = new PersistentDeviceEventLedger({ filePath });
    writeFileSync(`${filePath}.lock`, "held by another process", "utf8");
    assert.throws(() => ledger.append({ event_type: "diagnostic_alert", payload: { code: "DEVICE_OFFLINE" } }), { code: "EVENT_LEDGER_LOCKED" });
    rmSync(`${filePath}.lock`);

    assert.throws(() => ledger.append({ event_type: "private_chat_message", payload: { text: "not allowed" } }), /不允许持久化事件类型/);
    assert.equal(ledger.length, 0);

    writeFileSync(filePath, "{broken", "utf8");
    assert.throws(() => new PersistentDeviceEventLedger({ filePath }), /无法解析/);
    assert.equal(readFileSync(filePath, "utf8"), "{broken");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("持久事件日志路径可由配置覆盖，默认落在 OpenClaw 本机状态目录", () => {
  assert.equal(resolveDeviceEventLedgerPath({ DEVICE_MANAGER_EVENT_LEDGER_PATH: "C:/private/events.json" }), path.resolve("C:/private/events.json"));
  assert.equal(resolveDeviceEventLedgerPath({ OPENCLAW_STATE_DIR: "C:/openclaw-state" }), path.join(path.resolve("C:/openclaw-state"), "device-manager", "device-events.json"));
});

