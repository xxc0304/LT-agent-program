# Home Assistant 开发环境进展

更新时间：2026-09-14

## 当前状态

已按项目手册完成 Home Assistant 源码开发环境的首次安装和启动验证：

- Docker Desktop 已使用 WSL 2 后端运行；BIOS 虚拟化已启用。
- Home Assistant Core 固定在 `2026.8.3`。
- Home Assistant Frontend 固定在 `20260729.7`，Yarn `4.17.1`，Node `24.18.0`。
- Core 与 Frontend 源码分别位于本机的 `HomeAssistantDev\core` 和 `HomeAssistantDev\frontend` 目录。
- Docker 开发容器名为 `homeassistant-dev`，Core 和 Frontend 目录以挂载方式提供给容器。
- `config/configuration.yaml` 已启用 Frontend `development_repo`，前端使用 `yarn dev` 自动构建。
- 本机 `http://127.0.0.1:8123` 已验证可访问，并返回首次设置页面；UDP 5683 也已映射。
- VS Code Dev Containers 扩展已安装，便于后续打开和调试这套开发环境。

## 安全边界

本次只上传环境状态和可复现的项目进展，不上传 API Key、管理员密码、`.env`、SCB 图片、模型结果、Docker 运行日志或本机依赖目录。首次使用 Home Assistant 时，应在本机首次设置页面自行创建管理员账号。

## 下一步

1. 在本机 `http://127.0.0.1:8123` 完成管理员创建和基础设置。
2. 在 VS Code 中打开 Core 源码的 Dev Container，继续修改和调试 Core/Frontend。
3. 真实设备接入前，继续沿用学习行为 Agent 输出结构化事件、设备管家 Agent 执行控制的安全边界。
