# LT 智能家庭 Agent：Linux 开发与验证

当前以 **Ubuntu 24.04 LTS + Node.js 24** 作为本项目的 Linux 开发和持续集成基线。Linux 命令是开发、验证和部署主流程；Windows `.cmd` / PowerShell 脚本仅作为兼容入口。

**最近一次 Linux 验证（2026-10-31）**：在 Debian 12 / Node.js 24.22.1 中检查完整 ZIP，安装 OpenClaw `2026.7.1-2` 后，设备管家与平台编排插件均通过 CLI 校验；`deployment/verify-agent-stack.mjs` 的 11 个阶段全部通过，共 582 项单元测试和 11 项设备管家 Mock 验收通过。Windows 部署包检查 123/123 通过。此前隔离 Gateway/Profile 已验证插件加载、工具注册、只读 RPC、SQLite 跨重启读回，以及指定的多 Agent 与自然语言交互场景。固定版本依赖审计当前记录为 17 项（1 严重、10 高危、6 中危）；项目组已接受为已知风险，未升级 OpenClaw 或修改其依赖。审计数量可能随 registry 数据变化。实际 HA、家电和 Ubuntu 持久主机不在本次验收范围。

进入 Linux 工作区：

```bash
docker exec -it lt-agent-program-linux-workspace bash
cd /workspace
```

**Gateway 编排分支复核（2026-10-29）**：隔离 Debian Gateway 已验证澄清、未登记 Agent、同设备相反动作和 A2A 权限门禁；指定合成对话也验证了能源管家派发、含糊请求澄清、矛盾指令处理与门锁确认。A2A 未授权时，调用会被 `AGENT_CALL_FORBIDDEN` 拦截。结果覆盖的是已列出的测试场景；接收方仍需在自己的 OpenClaw Profile 中配置 Agent、权限、模型并复核目标环境行为。

## Linux 环境准备

在 Ubuntu 终端中安装 Git、Node.js 24 和 npm。确认版本：

```bash
node --version
npm --version
git --version
```

完整适配器测试还需安装目标 OpenClaw 包到设备管家的 `node_modules`；这不会配置或启动 Gateway。启用 SQLite 记忆时，Gateway 实际运行的 Node.js 必须为 22.5 或更高；SQLite 在线备份命令需要 Node.js 22.16 或更高。

## 获取代码并验证

```bash
git clone https://github.com/xxc0304/LT-agent-program.git
cd LT-agent-program
npm --prefix device-manager install --no-save --package-lock=false --omit=peer --legacy-peer-deps --ignore-scripts
npm --prefix device-manager install --no-save --package-lock=false --include=peer --ignore-scripts openclaw@2026.7.1-2
npm --prefix multi-agent-orchestrator install --no-save --package-lock=false --omit=peer --legacy-peer-deps --ignore-scripts
node deployment/verify-agent-stack.mjs
```

第二条安装目标 OpenClaw 包供插件适配器测试和 CLI 校验使用，不会配置或启动 Gateway。验证入口会运行公共契约、设备管家及 Mock 验收、能源管家、记忆、编排器测试和两项端到端 Mock 演示。若暂时不需要演示，可运行：

```bash
node deployment/verify-agent-stack.mjs --skip-demos
```

GitHub Actions 工作流已加入目标 SDK 安装和两个插件 CLI 校验；推送后可由 Ubuntu runner 重跑完整适配器测试。容器验证通过表示 Node.js 代码和 Mock 链路在 Debian Linux 下通过；它不代替 Ubuntu 主机、目标 Gateway、Home Assistant 或真实设备验收。

## OpenClaw 部署状态

本仓库提供 Linux 原生 Node.js 安装入口 `deployment/install-agent-stack.mjs`，不依赖 PowerShell。安装前请先确保 OpenClaw CLI 已安装，且当前 CLI 指向准备使用的 Profile；安装器只操作 CLI 报告的活动 Profile，不创建或切换 Profile。

先查看只读计划（默认模式，不会写 OpenClaw 配置或安装依赖）：

```bash
node deployment/install-agent-stack.mjs
```

确认计划中的活动配置路径、Agent 和插件无误后，再执行安装：

```bash
node deployment/install-agent-stack.mjs --apply
```

安装器会要求输入完整的 `INSTALL`，才创建配置备份并开始安装；配置写入前会逐项运行 `openclaw config set ... --strict-json --dry-run`。遇到现有插件路径、Agent 工作区或全局权限冲突时会停止，不覆盖冲突项。操作失败时保留配置备份，不自动回滚可能已产生的插件/Agent CLI 副作用。

默认只有在 OpenClaw 能唯一识别默认 Agent、`dev`/`main` 或唯一候选时才会自动选择聊天入口；若提示候选不唯一，先运行 `openclaw agents list`，再通过 `--frontdoor-agent-id <ID>` 指定。

配置完成后，只有再次明确输入 `RESTART` 才会执行 `openclaw gateway restart --safe`；直接回车会保持 Gateway 不重启。需要跳过该询问时可加 `--skip-gateway-restart-prompt`，新工具要等之后安全重启才会加载。默认还会运行本地/Mock 验证；可加 `--skip-mock-verification` 跳过。

如果计划启用 SQLite 家庭记忆，需显式添加 `--enable-sqlite-memory`；可用 `--memory-database-path /绝对路径/household.sqlite` 指定位置。数据库必须位于解压代码包之外，Gateway 实际运行 Node.js 需为 22.5+。不指定 SQLite 时，现有记忆后端保持不变。

安装器和 Mock 流程已有注入式 CLI 自动测试。Linux 容器中的隔离 Profile 已确认插件加载、工具注册，并通过 Gateway RPC 调用只读偏好查询和 Mock 设备查询；临时 SQLite 偏好也已验证可跨 Gateway 重启读取。A2A 和模型对话已对指定合成场景做过定向验证；接收方的模型凭据、Agent 权限和正式数据目录需在目标 Profile 中单独配置与验收。Windows `.cmd`/PowerShell 入口保留为兼容用途，不是 Linux 部署方式。

## 代码包结构

- `device-manager/`：设备管家插件、设备工具和 Mock 后端。
- `energy-saving/`：能源管家逻辑。
- `multi-agent-orchestrator/`：Agent 登记、编排和 OpenClaw 插件入口。
- `agent-memory/`：家庭偏好学习与记忆存储。
- `openclaw-agents/`：业务 Agent 工作区模板。
- `deployment/`：跨平台 Mock 验证入口、Linux 原生 Node.js Profile 安装器和部署说明；目标 OpenClaw 版本下的插件校验、隔离 Gateway/Profile 和指定合成业务链路已完成本地验收。
