import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt as scryptCallback } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeMemoryDocument } from "./memory-store.js";

const scrypt = promisify(scryptCallback);
const FORMAT = "lt-household-memory-backup";
const FORMAT_VERSION = 1;
const CIPHER = "aes-256-gcm";
const AAD = Buffer.from(`${FORMAT}:${FORMAT_VERSION}`, "utf8");
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SCRYPT_OPTIONS = Object.freeze({ N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validatePassphrase(passphrase) {
  if (typeof passphrase !== "string" || Buffer.byteLength(passphrase, "utf8") < 12) {
    throw codedError("BACKUP_PASSPHRASE_TOO_SHORT", "备份口令至少需要 12 个 UTF-8 字节。请勿把口令写入代码、文件或聊天记录。");
  }
}

async function deriveKey(passphrase, salt) {
  validatePassphrase(passphrase);
  return scrypt(passphrase, salt, 32, SCRYPT_OPTIONS);
}

function parseAndNormalizeMemoryDocument(plaintext) {
  let parsed;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw codedError("MEMORY_DOCUMENT_INVALID", "解密内容不是有效的家庭记忆 JSON；未写入目标文件。");
  }

  try {
    return normalizeMemoryDocument(parsed);
  } catch {
    throw codedError("MEMORY_DOCUMENT_INVALID", "家庭记忆结构或版本不受支持；未写入目标文件。");
  }
}

async function encryptDocument(document, passphrase) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt);
  try {
    const cipher = createCipheriv(CIPHER, key, iv);
    cipher.setAAD(AAD);
    const plaintext = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.from(`${JSON.stringify({
      format: FORMAT,
      format_version: FORMAT_VERSION,
      cipher: CIPHER,
      kdf: "scrypt-n32768-r8-p1",
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      auth_tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    })}\n`, "utf8");
  } finally {
    key.fill(0);
  }
}

function decodeBase64(value, length, name) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw codedError("BACKUP_FORMAT_INVALID", `加密备份的 ${name} 字段无效。`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || (length !== undefined && decoded.length !== length)) {
    throw codedError("BACKUP_FORMAT_INVALID", `加密备份的 ${name} 字段长度无效。`);
  }
  return decoded;
}

async function decryptDocument(envelopeText, passphrase) {
  let envelope;
  try {
    envelope = JSON.parse(envelopeText);
  } catch {
    throw codedError("BACKUP_FORMAT_INVALID", "加密备份格式无效；未写入目标文件。");
  }
  if (envelope?.format !== FORMAT || envelope?.format_version !== FORMAT_VERSION
    || envelope?.cipher !== CIPHER || envelope?.kdf !== "scrypt-n32768-r8-p1") {
    throw codedError("BACKUP_FORMAT_UNSUPPORTED", "加密备份版本或算法不受支持；未写入目标文件。");
  }

  const salt = decodeBase64(envelope.salt, 16, "salt");
  const iv = decodeBase64(envelope.iv, 12, "iv");
  const authTag = decodeBase64(envelope.auth_tag, 16, "auth_tag");
  const ciphertext = decodeBase64(envelope.ciphertext, undefined, "ciphertext");
  const key = await deriveKey(passphrase, salt);

  let plaintext;
  try {
    const decipher = createDecipheriv(CIPHER, key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw codedError("BACKUP_DECRYPT_FAILED", "口令错误或备份完整性校验失败；未写入目标文件。");
  } finally {
    key.fill(0);
  }
  return parseAndNormalizeMemoryDocument(plaintext);
}

async function acquireMemoryLock(filePath) {
  const lockPath = `${filePath}.lock`;
  const token = randomUUID();
  let handle;
  try {
    handle = await fs.open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw codedError("MEMORY_STORE_LOCKED", "家庭记忆文件正被使用，或存在上次异常退出留下的锁；没有创建备份/恢复文件。");
    }
    throw error;
  }

  try {
    await handle.writeFile(JSON.stringify({ token, pid: process.pid, created_at: new Date().toISOString() }), "utf8");
  } catch (error) {
    await handle.close();
    await fs.rm(lockPath, { force: true });
    throw error;
  }

  return async () => {
    await handle.close();
    try {
      const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
      if (lock.token === token) await fs.rm(lockPath, { force: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  };
}

async function writeExclusive(filePath, bytes) {
  let handle;
  try {
    handle = await fs.open(filePath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw codedError("DESTINATION_ALREADY_EXISTS", "目标文件已存在；为避免覆盖，没有修改它。");
    }
    throw error;
  }

  let written = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    written = true;
  } finally {
    await handle.close();
    if (!written) await fs.rm(filePath, { force: true });
  }
}

async function readBoundedFile(filePath) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
    throw codedError("BACKUP_FILE_TOO_LARGE", "文件不是受支持的普通文件或超过 10 MiB 上限。");
  }
  return fs.readFile(filePath);
}

/** Create a password-encrypted, exclusive backup without exposing plaintext in the backup file. */
export async function createEncryptedMemoryBackup({ sourcePath, backupPath, passphrase } = {}) {
  validatePassphrase(passphrase);
  const source = path.resolve(sourcePath ?? "");
  const destination = path.resolve(backupPath ?? "");
  if (!sourcePath || !backupPath || source === destination) {
    throw codedError("BACKUP_PATH_INVALID", "必须指定不同的源文件和备份文件路径。");
  }

  const releaseLock = await acquireMemoryLock(source);
  try {
    const bytes = await readBoundedFile(source);
    const document = parseAndNormalizeMemoryDocument(bytes.toString("utf8"));
    const encrypted = await encryptDocument(document, passphrase);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await writeExclusive(destination, encrypted);
    return { success: true, backup_path: destination, memory_count: document.memories.length, encrypted_bytes: encrypted.length };
  } finally {
    await releaseLock();
  }
}

/** Restore only into a new file. Existing memory is never overwritten. */
export async function restoreEncryptedMemoryBackup({ backupPath, destinationPath, passphrase } = {}) {
  validatePassphrase(passphrase);
  if (!backupPath || !destinationPath) {
    throw codedError("BACKUP_PATH_INVALID", "必须指定加密备份文件和恢复目标路径。");
  }
  const backup = path.resolve(backupPath);
  const destination = path.resolve(destinationPath);
  if (backup === destination) throw codedError("BACKUP_PATH_INVALID", "恢复目标不能与加密备份文件相同。");

  const envelope = await readBoundedFile(backup);
  const document = await decryptDocument(envelope.toString("utf8"), passphrase);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const releaseLock = await acquireMemoryLock(destination);
  try {
    const plaintext = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    await writeExclusive(destination, plaintext);
    return { success: true, destination_path: destination, memory_count: document.memories.length };
  } finally {
    await releaseLock();
  }
}
