# LT 智能家庭 Agent：Linux 开发与验证

当前以 **Ubuntu 24.04 LTS + Node.js 24** 作为本项目的 Linux 开发和持续集成基线。此说明聚焦代码安装、自动化测试和 Mock 演示，不代表已经在 Linux OpenClaw Gateway 或真实 HA 上完成部署验收。

## Linux 环境准备

在 Ubuntu 终端中安装 Git、Node.js 24 和 npm。确认版本：

```bash
node --version
npm --version
git --version
```

Mock 验证需要安装设备管家和编排器的直接依赖；这一步不会安装 OpenClaw Gateway。启用 SQLite 记忆时，Gateway 实际运行的 Node.js 必须为 22.5 或更高；SQLite 在线备份命令需要 Node.js 22.16 或更高。

## 获取代码并验证

```bash
git clone https://github.com/xxc0304/LT-agent-program.git
cd LT-agent-program
npm --prefix device-manager install --no-save --package-lock=false --omit=peer --legacy-peer-deps --ignore-scripts
npm --prefix multi-agent-orchestrator install --no-save --package-lock=false --omit=peer --legacy-peer-deps --ignore-scripts
node deployment/verify-agent-stack.mjs
```

验证入口会运行公共契约、设备管家及 Mock 验收、节能 Agent、记忆、编排器测试和两项端到端 Mock 演示。若暂时不需要演示，可运行：

```bash
node deployment/verify-agent-stack.mjs --skip-demos
```

GitHub Actions 已配置为在 `ubuntu-latest` 上运行同一验证入口；需在推送分支或创建 PR 后查看首轮实际结果。测试通过表示 Node.js 代码和 Mock 链路在该 Linux runner 上通过；它不代替目标 Gateway、Home Assistant 或真实设备验收。

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

安装器和 Mock 流程已有注入式 CLI 自动测试；Windows 上运行这些测试只能验证分支、命令参数、备份及写入顺序，**不能代表 Linux 实测**。实际 Linux 安装仍需在隔离的 Linux OpenClaw Profile 上完成首次验收，检查插件加载、工具可见、Agent-to-Agent 权限与 SQLite 重启读写。Windows `.cmd`/PowerShell 入口保留为兼容用途，不是 Linux 部署方式。

## 代码包结构

- `device-manager/`：设备管家插件、设备工具和 Mock 后端。
- `energy-saving/`：节能 Agent 逻辑。
- `multi-agent-orchestrator/`：Agent 登记、编排和 OpenClaw 插件入口。
- `agent-memory/`：家庭偏好学习与记忆存储。
- `openclaw-agents/`：业务 Agent 工作区模板。
- `deployment/`：跨平台 Mock 验证入口、Linux 原生 Node.js Profile 安装器和部署说明；首次目标 Linux Gateway/Profile 实机验收仍待完成。
