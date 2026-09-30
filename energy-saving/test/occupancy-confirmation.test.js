import assert from "node:assert/strict";
import test from "node:test";

import { validateIndependentOccupancyConfirmation } from "../src/occupancy-confirmation.js";

const now = Date.parse("2026-09-30T12:00:00.000Z");
const trustedSourceAgents = ["ha-event-adapter"];

function learningEvent(overrides = {}) {
  return {
    event_id: "evt-learning-away",
    source_agent: "learning-companion",
    event_type: "learning_behavior",
    occurred_at: new Date(now).toISOString(),
    payload: { area: "living_room" },
    ...overrides,
  };
}

function confirmation(overrides = {}) {
  return {
    event_id: "evt-ha-unoccupied",
    source_agent: "ha-event-adapter",
    occupied: false,
    area: "living_room",
    occurred_at: new Date(now).toISOString(),
    ...overrides,
  };
}

function validate(candidate = confirmation(), event = learningEvent(), sources = trustedSourceAgents) {
  return validateIndependentOccupancyConfirmation({
    learningEvent: event,
    confirmation: candidate,
    now,
    trustedSourceAgents: sources,
  });
}

test("只接受近期、同区域且由运行时白名单信任的独立 HA 事件", () => {
  assert.deepEqual(validate(), { success: true });
  assert.deepEqual(validate(confirmation({ area: "客厅" })), { success: true });
  assert.equal(validate(confirmation(), learningEvent(), []).error.code, "UNTRUSTED_OCCUPANCY_SOURCE");
});

test("拒绝有人、区域不符、陈旧、未来或同源占用佐证", () => {
  const checks = [
    ["occupied", { occupied: true }, "OCCUPANCY_NOT_CONFIRMED_ABSENT"],
    ["wrong-area", { area: "bedroom" }, "OCCUPANCY_AREA_MISMATCH"],
    ["stale", { occurred_at: new Date(now - 60_001).toISOString() }, "STALE_OCCUPANCY_CONFIRMATION"],
    ["far-future", { occurred_at: new Date(now + 60_001).toISOString() }, "FUTURE_OCCUPANCY_CONFIRMATION"],
    ["same-source", { source_agent: "learning-companion" }, "INVALID_OCCUPANCY_CONFIRMATION"],
  ];
  for (const [id, changes, code] of checks) {
    assert.equal(validate(confirmation(changes)).error.code, code, id);
  }
});

test("拒绝课堂整体场景与不同时段产生的佐证", () => {
  assert.equal(validate(confirmation(), learningEvent({
    payload: { area: "living_room", annotation_scope: "classroom_scene" },
  })).error.code, "CLASSROOM_SCENE_NOT_TARGETED");
  assert.equal(validate(confirmation({ occurred_at: new Date(now - 60_001).toISOString() }), learningEvent({
    occurred_at: new Date(now).toISOString(),
  })).error.code, "STALE_OCCUPANCY_CONFIRMATION");
  assert.equal(validate(confirmation(), learningEvent({
    occurred_at: new Date(now - 61_000).toISOString(),
  })).error.code, "OCCUPANCY_CONFIRMATION_NOT_CONCURRENT");
});
