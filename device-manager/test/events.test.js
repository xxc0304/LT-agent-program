import assert from "node:assert/strict";
import test from "node:test";

import { DeviceEventLedger } from "../src/events.js";

test("事件账本只保留最近配置数量，淘汰旧事件后 ID 仍单调且不重复", () => {
  const ledger = new DeviceEventLedger({ retentionLimit: 2 });
  const first = ledger.append({ event_type: "diagnostic_alert", device_id: "light.study" });
  const second = ledger.append({ event_type: "diagnostic_recovered", device_id: "light.study" });
  const third = ledger.append({ event_type: "diagnostic_alert", device_id: "switch.study" });

  assert.equal(ledger.length, 2);
  assert.equal(first.event_id, "evt_000001");
  assert.equal(second.event_id, "evt_000002");
  assert.equal(third.event_id, "evt_000003");
  assert.equal(third.dedup_key, "switch.study:diagnostic_alert:3");
  assert.deepEqual(ledger.list({ limit: 200 }).map((event) => event.event_id), ["evt_000003", "evt_000002"]);
  assert.deepEqual(ledger.list({ device_id: "light.study" }).map((event) => event.event_id), ["evt_000002"]);
});

test("事件账本保留数量必须在 1 到公开查询上限 200 之间", () => {
  assert.throws(() => new DeviceEventLedger({ retentionLimit: 0 }), /1 到 200/);
  assert.throws(() => new DeviceEventLedger({ retentionLimit: 201 }), /1 到 200/);
  assert.throws(() => new DeviceEventLedger({ retentionLimit: 1.5 }), /1 到 200/);
  assert.equal(new DeviceEventLedger({ retentionLimit: 200 }).length, 0);
});
