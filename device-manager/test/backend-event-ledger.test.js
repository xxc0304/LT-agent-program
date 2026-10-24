import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHomeAssistantBackend } from "../src/backend.js";
import { PersistentDeviceEventLedger } from "../src/events.js";

function makeBackend(eventLedgerPath, fetchImpl = async () => new Response("[]", { status: 200 })) {
  return createHomeAssistantBackend({
    env: {
      DEVICE_MANAGER_BACKEND: "home-assistant",
      HA_URL: "http://ha.local:8123",
      HA_TOKEN: "unit-test-token",
      HA_REGISTRY_ENRICHMENT: "false",
      ...(eventLedgerPath ? { DEVICE_MANAGER_EVENT_LEDGER_PATH: eventLedgerPath } : {}),
    },
    fetchImpl,
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function lightEntity(state) {
  return {
    entity_id: "light.study",
    state,
    attributes: { friendly_name: "书房灯", brightness: state === "on" ? 180 : 0 },
    last_changed: "2026-10-16T00:00:00Z",
    last_updated: "2026-10-16T00:00:00Z",
  };
}

test("真实 HA 后端仅在显式设置路径后使用持久事件账本", () => {
  const ephemeral = makeBackend(undefined);
  assert.equal(ephemeral.eventLedger instanceof PersistentDeviceEventLedger, false);

  const directory = mkdtempSync(path.join(os.tmpdir(), "lt-ha-event-ledger-backend-"));
  const filePath = path.join(directory, "events.json");
  try {
    const first = makeBackend(filePath);
    assert.equal(first.eventLedger instanceof PersistentDeviceEventLedger, true);
    first.eventLedger.append({
      event_type: "action_executed",
      device_id: "light.study",
      payload: { action: "turn_off", old_state: "on", new_state: "off", verified: true },
    });

    const second = makeBackend(filePath);
    const events = second.getEvents({ device_id: "light.study" });
    assert.equal(events.length, 1);
    assert.equal(events[0].event_id, "evt_000001");
    assert.equal(events[0].source.id, "home_assistant");
    const persisted = readFileSync(filePath, "utf8");
    assert.equal(persisted.includes("ha.local"), false);
    assert.equal(persisted.includes("unit-test-token"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("真实 HA 控制链路将脱敏事件写盘并可由新后端实例恢复", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "lt-ha-event-ledger-control-"));
  const filePath = path.join(directory, "events.json");
  let current = lightEntity("on");
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/states/light.study" && options.method === "GET") {
      return jsonResponse(current);
    }
    if (parsed.pathname === "/api/services/light/turn_off" && options.method === "POST") {
      current = lightEntity("off");
      return jsonResponse([]);
    }
    return jsonResponse({ message: "not found" }, 404);
  };

  try {
    const first = makeBackend(filePath, fetchImpl);
    const result = await first.controlDevice({
      device_id: "light.study",
      action: "turn_off",
      task_id: "private-task-id-must-not-persist",
      idempotency_key: "private-idempotency-key-must-not-persist",
      trace_id: "trace-control-ledger-001",
    });

    assert.equal(result.success, true);
    assert.equal(result.verified, true);
    assert.equal(result.old_state, "on");
    assert.equal(result.new_state, "off");

    const second = makeBackend(filePath, fetchImpl);
    const events = second.getEvents({ trace_id: "trace-control-ledger-001" });
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, "action_executed");
    assert.equal(events[0].subject.device_id, "light.study");
    assert.deepEqual(events[0].payload, {
      action: "turn_off",
      verified: true,
      old_state: "on",
      new_state: "off",
    });

    const persisted = readFileSync(filePath, "utf8");
    for (const privateValue of [
      "unit-test-token",
      "ha.local",
      "private-task-id-must-not-persist",
      "private-idempotency-key-must-not-persist",
    ]) {
      assert.equal(persisted.includes(privateValue), false, `账本不应包含 ${privateValue}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

