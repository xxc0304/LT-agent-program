# 家庭记忆 SQLite 备份与恢复（v0.1）

## 做什么

为家庭记忆 SQLite 数据库提供人工触发的、一致性备份和恢复命令。程序使用 Node.js `node:sqlite` 在线备份接口，不直接复制运行中的数据库文件，因此可正确处理 SQLite 写入事务/WAL 状态。备份和恢复完成后都会检查 SQLite 完整性、数据库身份、schema 版本和记忆数据结构。

本版备份**不加密**。备份文件中包含可读的家庭偏好记忆，应放在具备访问控制的本地持久化介质中；不要放进 Git、CtxHop、普通网盘或网络共享目录。加密、密钥管理、自动计划和保留/轮转策略另行实现。

## 运行要求

- SQLite 记忆后端需要 Node.js 22.5+。
- SQLite 在线备份命令需要 Node.js 22.16+（提供 `node:sqlite backup()` API）。
- 不需要额外安装 SQLite 服务或 npm 驱动包。
- 当前 Gateway 仍默认使用 JSON；这些命令不会更改 Gateway 配置、切换当前存储或重启 Gateway。

## 创建备份

在项目 PowerShell 中执行，源路径替换为 Gateway 当前配置的 SQLite 数据库路径，目标路径选一个新建的受保护目录：

```powershell
Set-Location agent-memory
npm run db:backup -- create "C:\gateway-state\device-manager\family-memory.sqlite" "D:\protected-backups\family-memory-2026-10-23.sqlite"
```

命令拒绝覆盖已有目标；输出只报告路径和记忆条数，不显示偏好值。它会先在目标目录生成临时数据库，验证成功后再以独占方式发布成正式备份。

## 恢复到新数据库

恢复不会覆盖现有活动数据库。先选择一个新路径：

```powershell
Set-Location agent-memory
npm run db:backup -- restore "D:\protected-backups\family-memory-2026-10-23.sqlite" "C:\gateway-state\device-manager\family-memory-restored.sqlite"
```

恢复后，如需让 Gateway 使用恢复库，应由部署管理员在 Gateway 停止写入后检查文件和配置，再按统一 Gateway 运维流程调整 `FAMILY_MEMORY_DB_PATH` 并重启/重新加载。当前工具不会自动切换正在运行的服务，也不会删除源备份。

## 失败与安全行为

- 非家庭记忆 SQLite 文件、损坏文件、schema 不支持或记忆 JSON 记录无法解析时，备份/恢复会失败关闭。
- 源和目标路径相同、目标已存在时，会拒绝操作。
- 目标所在文件系统必须支持同卷硬链接（Windows 本机 NTFS 支持）；若不支持，命令会失败并保留源文件，不会退回到可能留下半成品的复制方式。
- 临时库在失败时清理；源文件保持不变。
- 如果 CLI 报 `MEMORY_SQLITE_BACKUP_UNAVAILABLE`，请在执行机器升级到支持 `node:sqlite backup()` 的 Node 22.16+，不要退回到复制 `.sqlite` / `-wal` / `-shm` 文件的方式。
- 备份中的家庭信息仍是明文。对真实家庭数据使用前，先确认本地目标盘和目录的访问权限与设备/磁盘加密符合团队安全要求。

## 与 JSON 加密备份的区别

原有 `npm run backup -- create/restore` 面向 JSON 文件并要求交互式口令；这里的 `npm run db:backup -- create/restore` 面向 SQLite 数据库且当前不加密。不要混用这两组命令。
