# Linux 开发与验证基线

## 目标环境

- 本地开发基线：Ubuntu 24.04 LTS。
- 自动化验证：GitHub Actions `ubuntu-latest`。
- Node.js：24（SQLite 记忆需要 Gateway 使用 Node.js 22.5+；SQLite 在线备份需要 22.16+）。
- 目标 OpenClaw 版本：`2026.7.1-2`。

“Linux 支持”按层次验收：Node.js 单元测试通过、Mock 验收通过、插件可在目标 Linux Gateway 加载、SQLite 持久化可重启读取。2026-10-23，交付包已在 Docker Desktop 的 Linux 容器（Debian 12、Node.js 24.22.1）完成本地/Mock 验证，11/11 检查组通过；其中 6 个必须有 OpenClaw SDK 的适配器测试因刻意不安装 Gateway peer 而跳过。这不等同于 Ubuntu 24.04 主机实测，也不代表目标 Gateway/HA 已验收。仓库已配置 Ubuntu GitHub Actions，首次 CI 结果仍待分支推送、PR 或手动触发。插件实际加载和 SQLite 在目标数据目录的重启读写，需要独立 Linux Gateway/Profile 验证。

## 开发者命令

```bash
npm --prefix device-manager install --no-save --package-lock=false --omit=peer --legacy-peer-deps --ignore-scripts
npm --prefix multi-agent-orchestrator install --no-save --package-lock=false --omit=peer --legacy-peer-deps --ignore-scripts
node deployment/verify-agent-stack.mjs
```

只运行测试、不运行演示：

```bash
node deployment/verify-agent-stack.mjs --skip-demos
```

CI 和开发者使用同一 Node.js 验证入口，避免维护 PowerShell 与 Bash 两套测试清单。Windows 脚本目前保留为兼容工具，不作为 Linux 支持证据。

## 已知缺口

1. `deployment/install-agent-stack.mjs` 已提供 Linux 原生安装入口，但当前开发机只能执行 Windows 上的注入式 CLI 测试；必须通过 Ubuntu CI 或 Linux 主机首次运行，不能把本机 Windows 测试记作 Linux 验收。
2. 目标 Linux Gateway 尚需在隔离 Profile 上验证插件实际加载、`orchestrate_household_agents` 工具可见和 Agent-to-Agent 权限；不应直接修改共享 Gateway。
3. SQLite 需要在目标 Linux 持久化数据目录上验证权限与重启后读写；CI 临时数据库测试不验证目标网关磁盘、用户或备份策略。
4. Windows PowerShell 安装器仍保留为兼容入口；Linux 安装器和 Windows 安装器的行为一致性需结合各自目标环境继续验收。
