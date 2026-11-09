import fs from "node:fs/promises";
import path from "node:path";
import { ensurePrivatePosixDirectory } from "./private-directory.js";

function pathError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function statOrNull(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Prepare a Profile SQLite file outside the repository. On POSIX, its parent
 * directory must be owned by the current user and private (0700).
 * The database file is created/restricted to 0600 so SQLite WAL sidecars stay
 * protected by the private directory. Windows permissions remain governed by
 * the user's filesystem ACL.
 */
export async function preparePrivateProfileSyncSqlitePath(databasePath) {
  const resolvedPath = path.resolve(databasePath);
  const directoryPath = path.dirname(resolvedPath);
  await ensurePrivatePosixDirectory(directoryPath, {
    code: "PROFILE_SYNC_SQLITE_DIRECTORY_NOT_PRIVATE",
    unsafePathCode: "PROFILE_SYNC_SQLITE_PATH_UNSAFE",
    message: "Profile SQLite parent directory must be owned by the current user and have mode 0700.",
  });

  if (process.platform === "win32") {
    try {
      return await fs.stat(resolvedPath);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;

  let databaseStat = await statOrNull(resolvedPath);
  if (databaseStat && (databaseStat.isSymbolicLink()
    || !databaseStat.isFile()
    || (currentUid !== null && databaseStat.uid !== currentUid)
    || databaseStat.nlink !== 1)) {
    throw pathError(
      "PROFILE_SYNC_SQLITE_PATH_UNSAFE",
      "Profile SQLite path must be a regular file owned by the current user and must not be a symbolic or hard link.",
    );
  }

  if (!databaseStat) {
    let handle;
    try {
      handle = await fs.open(resolvedPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    await handle?.close();
    databaseStat = await statOrNull(resolvedPath);
  }

  if (!databaseStat || databaseStat.isSymbolicLink() || !databaseStat.isFile()
    || (currentUid !== null && databaseStat.uid !== currentUid)
    || databaseStat.nlink !== 1) {
    throw pathError("PROFILE_SYNC_SQLITE_PATH_UNSAFE", "Profile SQLite path could not be safely prepared.");
  }

  if ((databaseStat.mode & 0o777) !== 0o600) {
    await fs.chmod(resolvedPath, 0o600);
    databaseStat = await fs.lstat(resolvedPath);
  }
  if ((databaseStat.mode & 0o777) !== 0o600) {
    throw pathError("PROFILE_SYNC_SQLITE_FILE_NOT_PRIVATE", "Profile SQLite database must have mode 0600.");
  }
  return databaseStat;
}
