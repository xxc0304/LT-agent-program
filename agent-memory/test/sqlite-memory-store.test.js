import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  defaultMemoryDatabasePath,
  importJsonMemoryToSQLite,
  PreferenceMemoryStore,
} from "../src/memory-store.js";

async function temporaryDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), "lt-household-memory-sqlite-"));
}

test("SQLite backend persists explicit preferences and consent across store reopen", async () => {
  const directory = await temporaryDirectory();
  const databasePath = path.join(directory, "household.sqlite");
  const store = new PreferenceMemoryStore({ backend: "sqlite", databasePath });
  try {
    const saved = await store.saveExplicitPreference({
      memory_type: "comfort_temperature_c",
      value: 23,
      room_id: "living_room",
      user_explicit_request: true,
    });
    assert.equal(saved.success, true);
    assert.equal((await store.setObservationConsent({ enabled: true, user_explicit_confirmation: true })).success, true);
  } finally {
    store.close();
  }

  const reopened = new PreferenceMemoryStore({ backend: "sqlite", databasePath });
  try {
    const preference = await reopened.getPreference({ memory_type: "comfort_temperature_c", room_id: "living_room" });
    assert.equal(preference.value, 23);
    assert.equal((await reopened.getObservationConsent()).enabled, true);
    assert.equal(reopened.backend, "sqlite");
  } finally {
    reopened.close();
  }
});

test("SQLite backend uses the same candidate, conflict-safe confirmation, and delete behavior", async () => {
  const directory = await temporaryDirectory();
  const databasePath = path.join(directory, "household.sqlite");
  const store = new PreferenceMemoryStore({ backend: "sqlite", databasePath });
  try {
    await store.setObservationConsent({ enabled: true, user_explicit_confirmation: true });
    let candidate;
    for (const [date, eventId] of [["2026-10-20", "event-1"], ["2026-10-21", "event-2"], ["2026-10-22", "event-3"]]) {
      const result = await store.proposeInferredCandidate({
        memory_type: "comfort_temperature_c",
        value: 22,
        confidence: 0.9,
        event_id: eventId,
        observation_date: date,
        consent_to_observe: true,
      });
      candidate = result.memory;
    }
    assert.equal(candidate.status, "pending_confirmation");
    assert.equal((await store.confirmCandidate(candidate.memory_id, { user_confirmed: true })).success, true);
    assert.equal((await store.getPreference({ memory_type: "comfort_temperature_c" })).value, 22);
    assert.equal((await store.deleteMemory(candidate.memory_id)).success, true);
    assert.equal(await store.getPreference({ memory_type: "comfort_temperature_c" }), null);
  } finally {
    store.close();
  }
});

test("JSON import validates and migrates into a new SQLite database without changing the source", async () => {
  const directory = await temporaryDirectory();
  const sourcePath = path.join(directory, "existing-memory.json");
  const databasePath = path.join(directory, "imported.sqlite");
  const sourceStore = new PreferenceMemoryStore({ filePath: sourcePath });
  await sourceStore.saveExplicitPreference({
    memory_type: "comfort_brightness_pct",
    value: 65,
    room_id: "living_room",
    user_explicit_request: true,
  });
  const originalBytes = await fs.readFile(sourcePath);

  const imported = await importJsonMemoryToSQLite({ sourcePath, databasePath });
  assert.equal(imported.success, true);
  assert.equal(imported.imported_count, 1);
  assert.deepEqual(await fs.readFile(sourcePath), originalBytes);

  const databaseStore = new PreferenceMemoryStore({ backend: "sqlite", databasePath });
  try {
    const preference = await databaseStore.getPreference({ memory_type: "comfort_brightness_pct", room_id: "living_room" });
    assert.equal(preference.value, 65);
    await assert.rejects(
      importJsonMemoryToSQLite({ sourcePath, databasePath }),
      (error) => error.code === "MEMORY_DATABASE_NOT_EMPTY",
    );
    assert.deepEqual(await fs.readFile(sourcePath), originalBytes);
  } finally {
    databaseStore.close();
  }
});

test("SQLite database is isolated per deployment and invalid JSON import creates no target database", async () => {
  const directory = await temporaryDirectory();
  const firstPath = path.join(directory, "household-one.sqlite");
  const secondPath = path.join(directory, "household-two.sqlite");
  const first = new PreferenceMemoryStore({ backend: "sqlite", databasePath: firstPath });
  const second = new PreferenceMemoryStore({ backend: "sqlite", databasePath: secondPath });
  try {
    await first.saveExplicitPreference({ memory_type: "sleep_time", value: "22:30", time_zone: "Asia/Shanghai", user_explicit_request: true });
    assert.equal(await second.getPreference({ memory_type: "sleep_time", time_zone: "Asia/Shanghai" }), null);
  } finally {
    first.close();
    second.close();
  }

  const invalidSource = path.join(directory, "invalid.json");
  const invalidTarget = path.join(directory, "must-not-exist.sqlite");
  await fs.writeFile(invalidSource, "not a memory document", "utf8");
  await assert.rejects(
    importJsonMemoryToSQLite({ sourcePath: invalidSource, databasePath: invalidTarget }),
    (error) => error.code === "MEMORY_IMPORT_SOURCE_INVALID",
  );
  await assert.rejects(fs.stat(invalidTarget), (error) => error.code === "ENOENT");
});

test("SQLite path follows the OpenClaw persistent state directory unless explicitly overridden", () => {
  const openClawStateDir = path.resolve("synthetic-openclaw-state");
  const explicitDatabasePath = path.resolve("synthetic-household-data", "memory.sqlite");
  assert.equal(
    defaultMemoryDatabasePath({ OPENCLAW_STATE_DIR: openClawStateDir }),
    path.join(openClawStateDir, "device-manager", "family-memory.sqlite"),
  );
  assert.equal(
    defaultMemoryDatabasePath({ FAMILY_MEMORY_DB_PATH: explicitDatabasePath }),
    explicitDatabasePath,
  );
});
