import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { createEncryptedMemoryBackup, restoreEncryptedMemoryBackup } from "./encrypted-backup.js";

function usage() {
  return [
    "家庭记忆加密备份工具（不会覆盖已有文件）",
    "创建备份：node src/backup-cli.js create <家庭记忆.json> <新建备份.enc.json>",
    "恢复备份：node src/backup-cli.js restore <备份.enc.json> <新建恢复文件.json>",
    "恢复文件是明文 JSON；确认目标目录有合适的 NTFS ACL 和磁盘加密。",
  ].join("\n");
}

function promptHidden(label) {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("口令必须在交互式终端中输入；不支持从参数、环境变量或管道读取口令。");
  }

  readline.emitKeypressEvents(input);
  return new Promise((resolve, reject) => {
    let value = "";
    let finished = false;
    const cleanup = () => {
      input.removeListener("keypress", onKeypress);
      input.setRawMode(false);
      input.pause();
      process.stdout.write("\n");
    };
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) reject(error);
      else resolve(result);
    };
    const onKeypress = (character, key = {}) => {
      if (key.ctrl && key.name === "c") {
        finish(new Error("用户取消了操作。"));
      } else if (key.name === "return" || key.name === "enter") {
        finish(null, value);
      } else if (key.name === "backspace") {
        value = [...value].slice(0, -1).join("");
      } else if (character && !key.ctrl && !key.meta) {
        value += character;
      }
    };

    input.setRawMode(true);
    input.resume();
    input.on("keypress", onKeypress);
    process.stdout.write(label);
  });
}

async function run(argv) {
  const [operation, firstPath, secondPath, ...extra] = argv;
  if (extra.length || !firstPath || !secondPath || !["create", "restore"].includes(operation)) {
    throw new Error(usage());
  }

  if (operation === "create") {
    let passphrase = "";
    try {
      passphrase = await promptHidden("输入备份口令（至少 12 字节，不会显示）：");
      const confirmation = await promptHidden("再次输入备份口令：");
      if (passphrase !== confirmation) throw new Error("两次输入的口令不一致；没有创建备份。");
      const result = await createEncryptedMemoryBackup({ sourcePath: firstPath, backupPath: secondPath, passphrase });
      process.stdout.write(`加密备份已创建：${result.backup_path}（${result.memory_count} 条记忆）\n`);
      process.stdout.write("请将备份保存在受限的本地/离线介质；口令需单独安全保管。\n");
    } finally {
      passphrase = "";
    }
    return;
  }

  process.stdout.write("注意：恢复目标会是明文家庭记忆 JSON，必须存放在受保护的本地目录。\n");
  let passphrase = "";
  try {
    passphrase = await promptHidden("输入备份口令（不会显示）：");
    const result = await restoreEncryptedMemoryBackup({ backupPath: firstPath, destinationPath: secondPath, passphrase });
    process.stdout.write(`已恢复到新文件：${result.destination_path}（${result.memory_count} 条记忆）；原有文件未覆盖。\n`);
  } finally {
    passphrase = "";
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.message.startsWith("家庭记忆加密备份工具") ? 2 : 1;
  });
}
