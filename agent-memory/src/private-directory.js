import fs from "node:fs/promises";
import path from "node:path";

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function assertNoSymbolicDirectoryAncestors(directoryPath, errorCode) {
  const parsed = path.parse(directoryPath);
  let currentPath = parsed.root;
  const segments = directoryPath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    let stats;
    try {
      stats = await fs.lstat(currentPath);
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw codedError(errorCode, "Private application data paths must contain real directories, not symbolic links.");
    }
  }
}

export async function verifyPrivatePosixDirectory(directoryPath, {
  code = "PRIVATE_DIRECTORY_NOT_PRIVATE",
  unsafePathCode = "PRIVATE_DIRECTORY_PATH_UNSAFE",
  message = "Directory must be owned by the current user and have mode 0700.",
} = {}) {
  const resolvedPath = path.resolve(directoryPath);
  if (process.platform === "win32") return fs.stat(resolvedPath);

  await assertNoSymbolicDirectoryAncestors(resolvedPath, unsafePathCode);
  if (await fs.realpath(resolvedPath) !== resolvedPath) {
    throw codedError(unsafePathCode, "Private application data paths must not resolve through symbolic links.");
  }

  const stats = await fs.stat(resolvedPath);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stats.isDirectory()
    || (currentUid !== null && stats.uid !== currentUid)
    || (stats.mode & 0o700) !== 0o700
    || (stats.mode & 0o077) !== 0) {
    throw codedError(code, message);
  }
  return stats;
}

/** Create a private POSIX directory or fail closed when an existing path is unsafe. */
export async function ensurePrivatePosixDirectory(directoryPath, options = {}) {
  const resolvedPath = path.resolve(directoryPath);
  if (process.platform === "win32") {
    await fs.mkdir(resolvedPath, { recursive: true, mode: 0o700 });
    return fs.stat(resolvedPath);
  }

  const unsafePathCode = options.unsafePathCode ?? "PRIVATE_DIRECTORY_PATH_UNSAFE";
  await assertNoSymbolicDirectoryAncestors(resolvedPath, unsafePathCode);
  await fs.mkdir(resolvedPath, { recursive: true, mode: 0o700 });
  return verifyPrivatePosixDirectory(resolvedPath, options);
}

/** Return null for a missing file; otherwise ensure it is a private POSIX regular file. */
export async function verifyPrivatePosixFile(filePath, {
  directoryCode = "PRIVATE_DIRECTORY_NOT_PRIVATE",
  code = "PRIVATE_FILE_NOT_PRIVATE",
  unsafePathCode = "PRIVATE_DIRECTORY_PATH_UNSAFE",
  message = "File must be a regular file owned by the current user with no group/other permissions.",
} = {}) {
  const resolvedPath = path.resolve(filePath);
  if (process.platform === "win32") {
    try {
      return await fs.stat(resolvedPath);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  let stats;
  try {
    stats = await fs.lstat(resolvedPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  await verifyPrivatePosixDirectory(path.dirname(resolvedPath), {
    code: directoryCode,
    unsafePathCode,
    message: "File parent directory must be owned by the current user and have mode 0700.",
  });

  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (stats.isSymbolicLink()
    || !stats.isFile()
    || (currentUid !== null && stats.uid !== currentUid)
    || stats.nlink !== 1
    || (stats.mode & 0o077) !== 0
    || (stats.mode & 0o400) === 0) {
    throw codedError(code, message);
  }
  return stats;
}
