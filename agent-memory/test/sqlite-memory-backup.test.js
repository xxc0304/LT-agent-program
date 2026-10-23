import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { PreferenceMemoryStore } from "../src/memory-store.js";
import {
  createSQLiteMemoryBackup,
  restoreSQLiteMemoryBackup,
} from "../src/sqlite-backup.js";

async function temporaryDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), "lt-household-memory-backup-"));
}

test("online backup and restore preserve a consistent SQLite memory snapshot", async () => {
  const directory = await temporaryDirectory();
  const databasePath = path.join(directory, "active.sqlite");
  const backupPath = path.join(directory, "backups", "memory.sqlite");
  const restoredPath = path.join(directory, "restored", "memory.sqlite");
  const store = new PreferenceMemoryStore({ backend: "sqlite", databasePath });

  try {
    await store.saveExplicitPreference({
      memory_type: "comfort_temperature_c",
      value: 22,
      room_id: "living_room",
      user_explicit_request: true,
    });
    await store.setObservationConsent({ enabled: true, user_explicit_confirmation: true });

    const sourceBeforeBackup = await fs.readFile(databasePath);
    const backup = await createSQLiteMemoryBackup({ sourcePath: databasePath, backupPath });
    assert.equal(backup.success, true);
    assert.equal(backup.encrypted, false);
    assert.equal(backup.memory_count, 1);
    assert.deepEqual(await fs.readFile(databasePath), sourceBeforeBackup);

    await store.saveExplicitPreference({
      memory_type: "comfort_temperature_c",
      value: 25,
      room_id: "living_room",
      user_explicit_request: true,
    });

    const restored = await restoreSQLiteMemoryBackup({ backupPath, databasePath: restoredPath });
    assert.equal(restored.success, true);
    assert.equal(restored.encrypted, false);
    assert.equal(restored.memory_count, 1);

    const recoveredStore = new PreferenceMemoryStore({ backend: "sqlite", databasePath: restoredPath });
    try {
      const preference = await recoveredStore.getPreference({
        memory_type: "comfort_temperature_c",
        room_id: "living_room",
      });
      assert.equal(preference.value, 22);
      assert.equal((await recoveredStore.getObservationConsent()).enabled, true);
    } finally {
      recoveredStore.close();
    }
  } finally {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("backup and restore refuse existing destinations without changing them", async () => {
  const directory = await temporaryDirectory();
  const databasePath = path.join(directory, "source.sqlite");
  const backupPath = path.join(directory, "backup.sqlite");
  const existingBackup = path.join(directory, "existing-backup.sqlite");
  const existingRestore = path.join(directory, "existing-restore.sqlite");
  const store = new PreferenceMemoryStore({ backend: "sqlite", databasePath });
  try {
    await store.saveExplicitPreference({
      memory_type: "comfort_brightness_pct",
      value: 60,
      user_explicit_request: true,
    });
    await createSQLiteMemoryBackup({ sourcePath: databasePath, backupPath });

    await fs.writeFile(existingBackup, "keep-backup-target", "utf8");
    await assert.rejects(
      createSQLiteMemoryBackup({ sourcePath: databasePath, backupPath: existingBackup }),
      (error) => error.code === "MEMORY_BACKUP_DESTINATION_EXISTS",
    );
    assert.equal(await fs.readFile(existingBackup, "utf8"), "keep-backup-target");

    await fs.writeFile(existingRestore, "keep-restore-target", "utf8");
    await assert.rejects(
      restoreSQLiteMemoryBackup({ backupPath, databasePath: existingRestore }),
      (error) => error.code === "MEMORY_RESTORE_DESTINATION_EXISTS",
    );
    assert.equal(await fs.readFile(existingRestore, "utf8"), "keep-restore-target");
  } finally {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("restore rejects a regular SQLite database that is not a household-memory backup", async () => {
  const directory = await temporaryDirectory();
  const invalidBackup = path.join(directory, "unrelated.sqlite");
  const destinationPath = path.join(directory, "must-not-exist.sqlite");
  const database = new DatabaseSync(invalidBackup);
  database.exec("CREATE TABLE unrelated (value TEXT);");
  database.close();

  try {
    await assert.rejects(
      restoreSQLiteMemoryBackup({ backupPath: invalidBackup, databasePath: destinationPath }),
      (error) => error.code === "MEMORY_RESTORE_BACKUP_INVALID",
    );
    await assert.rejects(fs.stat(destinationPath), (error) => error.code === "ENOENT");
    assert.deepEqual(
      (await fs.readdir(directory)).sort(),
      ["unrelated.sqlite"],
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("restore rejects corrupt memory records and leaves no partial destination", async () => {
  const directory = await temporaryDirectory();
  const backupPath = path.join(directory, "corrupt-memory.sqlite");
  const destinationPath = path.join(directory, "must-not-exist.sqlite");
  const store = new PreferenceMemoryStore({ backend: "sqlite", databasePath: backupPath });
  try {
    await store.saveExplicitPreference({
      memory_type: "comfort_brightness_pct",
      value: 70,
      user_explicit_request: true,
    });
    store.close();

    const database = new DatabaseSync(backupPath);
    database.prepare("UPDATE memories SET record_json = ?").run("not-json");
    database.close();

    await assert.rejects(
      restoreSQLiteMemoryBackup({ backupPath, databasePath: destinationPath }),
      (error) => error.code === "MEMORY_RESTORE_BACKUP_INVALID",
    );
    await assert.rejects(fs.stat(destinationPath), (error) => error.code === "ENOENT");
    assert.deepEqual((await fs.readdir(directory)).sort(), ["corrupt-memory.sqlite"]);
  } finally {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("backup and restore reject identical source and destination paths", async () => {
  const directory = await temporaryDirectory();
  const databasePath = path.join(directory, "memory.sqlite");
  const store = new PreferenceMemoryStore({ backend: "sqlite", databasePath });
  try {
    await store.saveExplicitPreference({
      memory_type: "comfort_brightness_pct",
      value: 55,
      user_explicit_request: true,
    });
    await assert.rejects(
      createSQLiteMemoryBackup({ sourcePath: databasePath, backupPath: databasePath }),
      (error) => error.code === "MEMORY_BACKUP_PATH_CONFLICT",
    );
    await assert.rejects(
      restoreSQLiteMemoryBackup({ backupPath: databasePath, databasePath }),
      (error) => error.code === "MEMORY_RESTORE_PATH_CONFLICT",
    );
  } finally {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("SQLite backup CLI can create and restore a synthetic database", async () => {
  const directory = await temporaryDirectory();
  const databasePath = path.join(directory, "source.sqlite");
  const backupPath = path.join(directory, "backup.sqlite");
  const restoredPath = path.join(directory, "restored.sqlite");
  const store = new PreferenceMemoryStore({ backend: "sqlite", databasePath });
  const cliPath = fileURLToPath(new URL("../src/sqlite-backup-cli.js", import.meta.url));
  try {
    await store.saveExplicitPreference({
      memory_type: "comfort_temperature_c",
      value: 22,
      room_id: "bedroom",
      user_explicit_request: true,
    });

    const backupResult = spawnSync(process.execPath, [cliPath, "create", databasePath, backupPath], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(backupResult.status, 0, backupResult.stderr);
    assert.match(backupResult.stdout, /未加密/);
    assert.match(backupResult.stdout, /记忆条数：1/);
    assert.doesNotMatch(backupResult.stdout, /22/);

    const restoreResult = spawnSync(process.execPath, [cliPath, "restore", backupPath, restoredPath], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(restoreResult.status, 0, restoreResult.stderr);
    assert.match(restoreResult.stdout, /未加密/);

    const recoveredStore = new PreferenceMemoryStore({ backend: "sqlite", databasePath: restoredPath });
    try {
      const preference = await recoveredStore.getPreference({
        memory_type: "comfort_temperature_c",
        room_id: "bedroom",
      });
      assert.equal(preference.value, 22);
    } finally {
      recoveredStore.close();
    }
  } finally {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
