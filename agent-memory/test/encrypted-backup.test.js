import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEncryptedMemoryBackup, restoreEncryptedMemoryBackup } from "../src/encrypted-backup.js";

const PASSPHRASE = "test-only-passphrase-not-for-real-data";

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-memory-backup-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, "memory.json");
  const document = {
    schema_version: "0.2",
    memories: [{
      memory_id: "memory-test-1",
      memory_type: "comfort_temperature_c",
      value: 24,
      subject_id: "household",
      scope: {},
      status: "confirmed",
      source: "user_explicit",
      confidence: 1,
      consent: "explicit",
      evidence_event_ids: [],
      observation_count: 0,
      created_at: "2026-09-30T00:00:00.000Z",
      updated_at: "2026-09-30T00:00:00.000Z",
      expires_at: null,
    }],
  };
  await fs.writeFile(sourcePath, JSON.stringify(document), { encoding: "utf8", mode: 0o600 });
  return { directory, sourcePath, document };
}

test("加密备份可恢复到新文件，备份不包含可读的记忆值", async (t) => {
  const { directory, sourcePath, document } = await fixture(t);
  const backupPath = path.join(directory, "memory.enc.json");
  const destinationPath = path.join(directory, "restored.json");

  const backedUp = await createEncryptedMemoryBackup({ sourcePath, backupPath, passphrase: PASSPHRASE });
  const encrypted = await fs.readFile(backupPath, "utf8");
  assert.equal(backedUp.memory_count, 1);
  assert.match(encrypted, /lt-household-memory-backup/);
  assert.doesNotMatch(encrypted, /comfort_temperature_c|memory-test-1|"value": 24/);
  assert.equal(await fs.access(`${sourcePath}.lock`).then(() => true, () => false), false);

  const restored = await restoreEncryptedMemoryBackup({ backupPath, destinationPath, passphrase: PASSPHRASE });
  assert.equal(restored.memory_count, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(destinationPath, "utf8")), document);
  assert.equal(await fs.access(`${destinationPath}.lock`).then(() => true, () => false), false);
});

test("错误口令或认证标签篡改会失败，且不会创建恢复文件", async (t) => {
  const { directory, sourcePath } = await fixture(t);
  const backupPath = path.join(directory, "memory.enc.json");
  const destinationPath = path.join(directory, "must-not-exist.json");
  await createEncryptedMemoryBackup({ sourcePath, backupPath, passphrase: PASSPHRASE });

  await assert.rejects(
    restoreEncryptedMemoryBackup({ backupPath, destinationPath, passphrase: "different-test-passphrase" }),
    { code: "BACKUP_DECRYPT_FAILED" },
  );
  assert.equal(await fs.access(destinationPath).then(() => true, () => false), false);

  const envelope = JSON.parse(await fs.readFile(backupPath, "utf8"));
  envelope.auth_tag = Buffer.alloc(16, 7).toString("base64");
  await fs.writeFile(backupPath, JSON.stringify(envelope));
  await assert.rejects(
    restoreEncryptedMemoryBackup({ backupPath, destinationPath, passphrase: PASSPHRASE }),
    { code: "BACKUP_DECRYPT_FAILED" },
  );
  assert.equal(await fs.access(destinationPath).then(() => true, () => false), false);
});

test("拒绝覆盖已有备份或恢复文件，也拒绝持锁的记忆文件", async (t) => {
  const { directory, sourcePath } = await fixture(t);
  const backupPath = path.join(directory, "memory.enc.json");
  await fs.writeFile(backupPath, "keep-existing");
  await assert.rejects(
    createEncryptedMemoryBackup({ sourcePath, backupPath, passphrase: PASSPHRASE }),
    { code: "DESTINATION_ALREADY_EXISTS" },
  );
  assert.equal(await fs.readFile(backupPath, "utf8"), "keep-existing");

  await fs.rm(backupPath);
  await fs.writeFile(`${sourcePath}.lock`, JSON.stringify({ token: "other-writer" }));
  await assert.rejects(
    createEncryptedMemoryBackup({ sourcePath, backupPath, passphrase: PASSPHRASE }),
    { code: "MEMORY_STORE_LOCKED" },
  );
  assert.equal(await fs.access(backupPath).then(() => true, () => false), false);
});

test("拒绝不支持的记忆结构和过短口令", async (t) => {
  const { directory, sourcePath } = await fixture(t);
  const backupPath = path.join(directory, "memory.enc.json");
  await fs.writeFile(sourcePath, JSON.stringify({ schema_version: "9.9", memories: [] }));
  await assert.rejects(
    createEncryptedMemoryBackup({ sourcePath, backupPath, passphrase: PASSPHRASE }),
    { code: "MEMORY_DOCUMENT_INVALID" },
  );
  await assert.rejects(
    createEncryptedMemoryBackup({ sourcePath, backupPath, passphrase: "short" }),
    { code: "BACKUP_PASSPHRASE_TOO_SHORT" },
  );
  assert.equal(await fs.access(backupPath).then(() => true, () => false), false);
});

test("恢复必须使用新目标，已有目标内容不变", async (t) => {
  const { directory, sourcePath } = await fixture(t);
  const backupPath = path.join(directory, "memory.enc.json");
  const destinationPath = path.join(directory, "existing.json");
  await createEncryptedMemoryBackup({ sourcePath, backupPath, passphrase: PASSPHRASE });
  await fs.writeFile(destinationPath, "preserve-me");

  await assert.rejects(
    restoreEncryptedMemoryBackup({ backupPath, destinationPath, passphrase: PASSPHRASE }),
    { code: "DESTINATION_ALREADY_EXISTS" },
  );
  assert.equal(await fs.readFile(destinationPath, "utf8"), "preserve-me");
});

test("旧版 0.1 候选经加密恢复后按兼容规则标记为需重新观察", async (t) => {
  const { directory, sourcePath } = await fixture(t);
  const legacy = {
    schema_version: "0.1",
    memories: [{
      memory_id: "legacy-pending",
      memory_type: "sleep_time",
      value: "22:30",
      subject_id: "household",
      scope: { time_zone: "Asia/Shanghai" },
      status: "pending_confirmation",
      source: "repeated_observation_unconfirmed",
      evidence_event_ids: ["old-1", "old-2", "old-3"],
      observation_count: 3,
      confidence: 0.9,
      expires_at: null,
    }],
  };
  await fs.writeFile(sourcePath, JSON.stringify(legacy));
  const backupPath = path.join(directory, "nested", "memory.enc.json");
  const destinationPath = path.join(directory, "restore", "memory.json");

  await createEncryptedMemoryBackup({ sourcePath, backupPath, passphrase: PASSPHRASE });
  await restoreEncryptedMemoryBackup({ backupPath, destinationPath, passphrase: PASSPHRASE });
  const restored = JSON.parse(await fs.readFile(destinationPath, "utf8"));
  assert.equal(restored.schema_version, "0.2");
  assert.equal(restored.memories[0].legacy_requires_reobservation, true);
});
