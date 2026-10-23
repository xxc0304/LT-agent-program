# 家庭记忆 SQLite 后端与 OpenClaw 集成说明

## 目标结构

```text
用户对话
   ↓
OpenClaw 主 Agent / 多 Agent 编排
   ↓ 调用记忆工具
设备管家插件中的 PreferenceMemoryStore
   ↓
SQLite 记忆库（每个家庭边缘部署独立一库）
   ↓
家庭平台的持久化数据区
```

OpenClaw 和业务 Agent 不直接读取数据库。写入时由记忆工具和存储代码校验类型、授权和候选确认；读取时只返回已确认且适用的偏好。候选观察写入仍只允许可信事件适配器调用，不能由模型随意编造证据。

## 当前代码状态

- 现有 `PreferenceMemoryStore` API 不变，新增 SQLite 持久化后端；记忆工具仍使用同一 API。
- SQLite 表保存必要的结构化记忆记录、可查询字段和授权设置，不保存原始聊天、图片/视频、设备快照或凭据。
- 数据库按 Gateway/家庭边缘部署配置选择。当前设计是一户一库；没有实现一个 Gateway 进程内通过模型传入 `household_id` 来切换多户数据库。
- 默认仍为 JSON 后端。这样已有 Gateway 不会因为更新代码而静默改用空数据库；SQLite 需由部署显式选择。
- SQLite 模式需要 Node.js 22.5+ 的内置 `node:sqlite`。不需要单独运行数据库服务或安装 npm 数据库依赖。

## Gateway 配置

推荐在目标 OpenClaw Profile 的设备管家插件配置中选择后端：

```json
{
  "plugins": {
    "entries": {
      "device-manager": {
        "config": {
          "memoryBackend": "sqlite",
          "memoryDatabasePath": "C:\\gateway-state\\device-manager\\family-memory.sqlite"
        }
      }
    }
  }
}
```

也可在本项目的一键安装器中显式启用：`Install-Agent-Stack.cmd -EnableSQLiteMemory`。首次启用时，默认数据库放在活动 OpenClaw 配置文件旁的 `device-manager/family-memory.sqlite`。需要换到其他持久化数据区时，可通过 `-MemoryDatabasePath` 指定**绝对路径**；自定义路径必须位于解压包目录之外，避免后续重新打包时带走家庭数据。若当前 Profile 已启用 SQLite，省略路径重新运行安装器会保留现有显式数据库路径；若此前使用隐式运行时默认路径，则继续保持隐式，不会改写为 Profile 默认路径。该路径是插件配置，不从用户对话或模型工具入参读取。

数据库路径只能和显式 `memoryBackend: "sqlite"` 一起配置，且必须是绝对路径；单独提供路径或选择 JSON 后端同时提供数据库路径会拒绝加载插件配置。若没有插件级后端设置，仍兼容旧版 `FAMILY_MEMORY_BACKEND=sqlite` 与 `FAMILY_MEMORY_DB_PATH` 后端/数据库路径回退。插件级后端和数据库路径优先于这两个环境变量；`FAMILY_MEMORY_PATH` 独立指定 JSON 文件位置，在 JSON 后端下仍可使用。未指定 SQLite 路径时，代码优先使用 `OPENCLAW_STATE_DIR/device-manager/family-memory.sqlite`；没有配置状态目录时使用系统应用数据目录。设备管家插件服务启动时打开数据库连接，停止时关闭连接；目标 Gateway **实际运行的 Node.js 必须为 22.5+**，安装脚本检查的是当前命令行 PATH 中的 Node 版本。

## JSON 数据导入

现有 JSON 数据不会自动搬迁。先为目标数据库选择一个**新建且专用**的路径，再运行：

```powershell
Set-Location agent-memory
npm run db:import-json -- <现有记忆.json> <新 SQLite 数据库路径>
```

导入前会验证源 JSON 的记忆结构；目标数据库必须尚未初始化且没有记忆行。目标不空或损坏时会取消导入。导入过程不删除、不改写源 JSON，也不会打印偏好具体值。演示和测试必须继续使用合成数据，不要指向真实家庭数据。

## 隐私、安全和待补项

- 标准 SQLite 与当前 JSON 后端都没有应用层加密。Windows Gateway 服务的 ACL、设备/卷加密和访问主体仍需在部署环境核验。
- 现有 `npm run backup` 只加密备份 JSON，不能用于 SQLite。SQLite 已新增人工触发的一致性备份/恢复命令 `npm run db:backup -- create/restore`；需要 Node.js 22.16+，输出未加密，只能写入受保护的新路径，且不会改动 Gateway 配置。自动化、保留/轮转、加密和密钥管理仍未实现。细节见 [`家庭记忆 SQLite 备份与恢复说明`](household-memory-sqlite-backup-v0.1.md)。
- 不要把家庭数据库放入 Git、CtxHop、普通网盘、同步盘、网络共享目录或临时容器层。
- 共享多家庭数据库、云端同步、端到端加密与密钥托管不在当前实现中。
- 只有完成上述持久化数据区保护与数据库备份设计后，才应开始写入真实家庭记忆。

## 验证结果

单元测试覆盖 SQLite 写入后关闭并重新打开、偏好/授权查询、候选确认与删除、JSON 显式导入、目标库非空保护、源 JSON 保留、不同数据库互相隔离，以及 OpenClaw 插件工具通过配置实际读写 SQLite。备份/恢复自动化测试使用合成数据，覆盖在线备份、恢复后重开读取、非家庭数据库拒绝和目标已存在时拒绝覆盖。此为本项目 Mock/自动化测试，不代表老师统一 Gateway 已部署验收。
