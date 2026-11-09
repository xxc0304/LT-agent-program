import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { preparePrivateProfileSyncSqlitePath } from "../src/profile-sync-sqlite-path.js";

const POSIX_ONLY = { skip: process.platform === "win32" };

async function createPrivateTempDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "profile-sync-path-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("POSIX SQLite path creates a private directory and mode-0600 database", POSIX_ONLY, async (t) => {
  const root = await createPrivateTempDirectory(t);
  const databasePath = path.join(root, "state", "profile.sqlite");

  await preparePrivateProfileSyncSqlitePath(databasePath);

  const directoryStat = await fs.stat(path.dirname(databasePath));
  const databaseStat = await fs.stat(databasePath);
  assert.equal(directoryStat.mode & 0o777, 0o700);
  assert.equal(databaseStat.mode & 0o777, 0o600);
  if (typeof process.getuid === "function") {
    assert.equal(directoryStat.uid, process.getuid());
    assert.equal(databaseStat.uid, process.getuid());
  }
});

test("POSIX SQLite path repairs a group-readable database file to mode 0600", POSIX_ONLY, async (t) => {
  const root = await createPrivateTempDirectory(t);
  const databasePath = path.join(root, "profile.sqlite");
  await fs.writeFile(databasePath, "synthetic placeholder");
  await fs.chmod(databasePath, 0o644);

  await preparePrivateProfileSyncSqlitePath(databasePath);

  const databaseStat = await fs.stat(databasePath);
  assert.equal(databaseStat.mode & 0o777, 0o600);
});

test("POSIX SQLite path rejects a parent directory accessible by group or others", POSIX_ONLY, async (t) => {
  const root = await createPrivateTempDirectory(t);
  const sharedDirectory = path.join(root, "shared");
  await fs.mkdir(sharedDirectory, { mode: 0o700 });
  await fs.chmod(sharedDirectory, 0o755);

  await assert.rejects(
    preparePrivateProfileSyncSqlitePath(path.join(sharedDirectory, "profile.sqlite")),
    { code: "PROFILE_SYNC_SQLITE_DIRECTORY_NOT_PRIVATE" },
  );
});

test("POSIX SQLite path rejects symbolic and hard links", POSIX_ONLY, async (t) => {
  const root = await createPrivateTempDirectory(t);
  const databasePath = path.join(root, "profile.sqlite");
  const symbolicPath = path.join(root, "profile-symbolic.sqlite");
  const hardPath = path.join(root, "profile-hard.sqlite");
  await fs.writeFile(databasePath, "synthetic placeholder", { mode: 0o600 });
  await fs.symlink(databasePath, symbolicPath);
  await fs.link(databasePath, hardPath);

  await assert.rejects(
    preparePrivateProfileSyncSqlitePath(symbolicPath),
    { code: "PROFILE_SYNC_SQLITE_PATH_UNSAFE" },
  );
  await assert.rejects(
    preparePrivateProfileSyncSqlitePath(hardPath),
    { code: "PROFILE_SYNC_SQLITE_PATH_UNSAFE" },
  );
});

test("POSIX SQLite path rejects a symbolic-link parent directory", POSIX_ONLY, async (t) => {
  const root = await createPrivateTempDirectory(t);
  const privateDirectory = path.join(root, "private");
  const linkedDirectory = path.join(root, "linked");
  await fs.mkdir(privateDirectory, { mode: 0o700 });
  await fs.symlink(privateDirectory, linkedDirectory, "dir");

  await assert.rejects(
    preparePrivateProfileSyncSqlitePath(path.join(linkedDirectory, "profile.sqlite")),
    { code: "PROFILE_SYNC_SQLITE_PATH_UNSAFE" },
  );
});
