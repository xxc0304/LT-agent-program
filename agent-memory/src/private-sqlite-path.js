import fs from "node:fs";
import path from "node:path";

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertPrivateDirectory(directoryPath) {
  const resolvedPath = path.resolve(directoryPath);
  if (process.platform === "win32") {
    fs.mkdirSync(resolvedPath, { recursive: true, mode: 0o700 });
    return;
  }

  const parsed = path.parse(resolvedPath);
  let currentPath = parsed.root;
  const segments = resolvedPath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    let stats;
    try {
      stats = fs.lstatSync(currentPath);
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw codedError("MEMORY_DATABASE_PATH_UNSAFE", "家庭记忆数据库目录不能经过符号链接或非目录路径。");
    }
  }

  fs.mkdirSync(resolvedPath, { recursive: true, mode: 0o700 });
  const stats = fs.lstatSync(resolvedPath);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (stats.isSymbolicLink()
    || !stats.isDirectory()
    || fs.realpathSync.native(resolvedPath) !== resolvedPath
    || (currentUid !== null && stats.uid !== currentUid)
    || (stats.mode & 0o700) !== 0o700
    || (stats.mode & 0o077) !== 0) {
    throw codedError(
      "MEMORY_DATABASE_DIRECTORY_NOT_PRIVATE",
      "家庭记忆数据库目录必须由当前用户拥有且权限为 0700。",
    );
  }
}

function statOrNull(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Create or validate a private SQLite path before SQLite opens the file. */
export function preparePrivateSQLitePath(databasePath) {
  if (typeof databasePath !== "string" || !databasePath.trim()) {
    throw new TypeError("databasePath must be a non-empty path");
  }
  const resolvedPath = path.resolve(databasePath);
  assertPrivateDirectory(path.dirname(resolvedPath));
  if (process.platform === "win32") return resolvedPath;

  let stats = statOrNull(resolvedPath);
  if (!stats) {
    let fileDescriptor;
    try {
      fileDescriptor = fs.openSync(resolvedPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
    stats = statOrNull(resolvedPath);
  }

  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stats || stats.isSymbolicLink() || !stats.isFile()
    || (currentUid !== null && stats.uid !== currentUid)
    || stats.nlink !== 1) {
    throw codedError(
      "MEMORY_DATABASE_PATH_UNSAFE",
      "家庭记忆数据库必须是当前用户拥有的普通文件，且不能是符号链接或硬链接。",
    );
  }

  if ((stats.mode & 0o777) !== 0o600) {
    fs.chmodSync(resolvedPath, 0o600);
    stats = fs.lstatSync(resolvedPath);
  }
  if (stats.isSymbolicLink() || !stats.isFile()
    || (currentUid !== null && stats.uid !== currentUid)
    || stats.nlink !== 1 || (stats.mode & 0o777) !== 0o600) {
    throw codedError("MEMORY_DATABASE_FILE_NOT_PRIVATE", "家庭记忆数据库文件权限无法收紧到 0600。");
  }
  return resolvedPath;
}