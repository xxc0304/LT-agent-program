# Agent 组集成与交付包（内部联调版）

本代码包把设备管家、节能 Agent、编排器和公共契约整理成便于组内部署与联调的入口和文档。项目当前以 Ubuntu Linux 作为开发与 CI 验证基线，使用 `node deployment/verify-agent-stack.mjs` 运行本地 Mock 验证，并提供 Linux 原生 Node.js OpenClaw 安装入口 `deployment/install-agent-stack.mjs`。Windows PowerShell 安装器保留为兼容用途。

## 快速验证

在解压后的代码包根目录运行：

    npm --prefix device-manager install --no-save --package-lock=false --omit=peer --legacy-peer-deps --ignore-scripts
    npm --prefix multi-agent-orchestrator install --no-save --package-lock=false --omit=peer --legacy-peer-deps --ignore-scripts
    node deployment/verify-agent-stack.mjs

验证后可单独运行：

    node deployment/verify-agent-stack.mjs --skip-demos
    npm --prefix multi-agent-orchestrator run demo:energy-event

前两条只安装设备管家与编排器的直接依赖，不安装 OpenClaw Gateway；其后运行公共契约、相关模块测试和 Mock 验收。单独演示命令展示“占用事件 → 节能 Agent → 设备管家 → Mock HA → 状态回读”。

OpenClaw 集成前可先检查安装计划：

    node deployment/install-agent-stack.mjs

确认当前 OpenClaw Profile 后再安装：

    node deployment/install-agent-stack.mjs --apply

它会在任何修改前要求输入 `INSTALL` 并创建配置备份；是否安全重启 Gateway 会在配置完成后单独询问。首次 Linux 验收应使用隔离 Profile。

## 文档导航

- 架构和安全边界：架构与集成说明.md
- 其他小组如何对接：接口联调指南.md
- 演示人员如何操作：使用与操作手册.md
- 安装和故障处理：部署与运维手册.md
- 测试证据如何解释：验收矩阵.md
- Linux 开发、安装与首次验证：README-快速开始.md

## 当前边界

公共契约当前为本组 v0.1 讨论稿，优先级、数据级别、隐私级别、事件来源认证和 PolicyDecision 回传仍须与其他组确认。正式企业交付前，仍需完成真实 HA/目标设备联调、安全配置评审、目标环境部署和运维验收。

Linux 安装器要求 OpenClaw `2026.7.1-2` 和 Node.js 20+ 已经可用，并会复用当前 CLI 指向的 Profile。它不会安装/升级 OpenClaw、配置模型/API 凭据或覆盖冲突的 Agent 工作区；会在修改配置前创建配置备份，Gateway 重启另行确认。首次 Linux Gateway 部署仍需在隔离 Profile 上实测插件加载和权限链路。

Windows 安装仅接受 OpenClaw `.ps1` 或 `.exe` CLI 入口；若只检测到 `.cmd`/`.bat`，会在访问 Profile 前停止。若需扩大全局会话可见性，安装器要求其他现有 Agent 先明确 deny 会话工具，否则停止并保留现状。

Mock 或单元测试通过，表示代码链路在本地模拟环境中通过，不代表模型自然语言效果或真实家庭设备已经验收。

## 交付安全

构建包时不得包含 API Key、HA Token、OpenClaw 本机状态、家庭记忆 JSON、原始隐私数据、私有图片/标注文件或项目内部会议/分工材料。不要把这些内容加入仓库或交付 ZIP。
