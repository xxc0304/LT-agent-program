# 选购服务与 OpenClaw 接入/更新管理（v0.1）

日期：2026-11-07

状态：通用接入契约和更新预检已在本地实现；真实服务连接器尚未接入。

## 目标与边界

选购/购物服务作为独立 OpenClaw connector/plugin 接入，不由 OpenClaw 核心更新器管理，也不由项目安装器覆盖 Gateway 程序或用户 profile。OpenClaw 核心、连接器代码、服务端 API 契约各自有独立版本和回滚责任。

仓库目前没有具体选购服务的代码、API/OpenAPI、SDK、认证授权说明、测试环境或更新记录。因此本契约不虚构 endpoint、订单字段、权限名或认证流程；只有在服务方材料到齐后，才可填充真实 manifest 和实现适配器。

## 本地完成：连接器清单与更新预检

`deployment/openclaw-service-integration.mjs` 提供两种只读操作：

```sh
node deployment/openclaw-service-integration.mjs --validate <manifest.json>
node deployment/openclaw-service-integration.mjs --current <installed.json> --candidate <candidate.json> --openclaw-version <exact-version>
```

连接器 manifest 必须声明服务身份及 API 契约版本、精确的 connector 包名/版本和已测试的 OpenClaw 精确版本、密钥引用（不能写密钥值）、权限集合、能力影响类型、个人数据类别/保留期，以及合成数据验证方式。未声明的字段会被拒绝。任何 `external_write` 能力（例如下单/改订单）必须要求每次用户确认，且其权限必须出现在认证权限声明中。

字段结构和格式约束有机器可读定义 [`deployment/openclaw-service-integration.schema.json`](../deployment/openclaw-service-integration.schema.json)，validator 直接从 Schema 读取允许字段，减少规则漂移。缺少资料的收集表见 [`selected-service-integration-inputs.md`](./selected-service-integration-inputs.md)。

仓库提供 [`deployment/fixtures/synthetic-openclaw-service-manifest.fixture.json`](../deployment/fixtures/synthetic-openclaw-service-manifest.fixture.json) 作为纯合成格式样例，可运行：

```sh
node deployment/openclaw-service-integration.mjs --validate deployment/fixtures/synthetic-openclaw-service-manifest.fixture.json
```

样例中的服务、包名、权限和环境变量名均为虚构值；该文件只用于检查 manifest 格式，不能用于安装或连接任何真实服务。

更新预检只允许同一服务、同一 npm 包和同一 OpenClaw plugin ID 的向前升级；目标 Gateway 版本必须列入候选版本的精确测试清单。新权限、新能力/API 契约/数据政策或密钥引用变化会要求人工复核。`verification.test_environment` 是清单自报字段，预检不会执行 sandbox 测试或核验测试证据；因此计划结果始终返回 `sandbox_validated: false`、`sandbox_validation_status: not_verified_by_preflight`，并把 sandbox 验证列为后续步骤。`metadata_preflight_passed` 只表示本地静态检查通过。`external_write` 能力还必须声明至少一个认证权限，并要求逐次用户确认。清单中的命令不会被执行，预检不会联网，也不会读取密钥值。

工具永远返回 `activation_permitted: false`、`gateway_config_modified: false`。它不安装插件、不改 OpenClaw profile、不重启 Gateway，也不代表真实服务兼容测试已通过。

本机 Node.js 24.22.1 验证：连接器校验/更新预检及 CLI/Schema 测试 **19/19 通过**；连同安装器回归测试共 **35/35 通过**。Ubuntu 24.04 workflow 已加入专项测试步骤，但本轮改动尚未推送，故没有覆盖本轮实现的 Linux CI 记录。

## GitHub 资料核对

2026-11-07 检查了仓库 GitHub 默认分支和已知 Task 3 分支：默认分支最近提交为 [`6aebd5d`](https://github.com/xxc0304/LT-agent-program/commit/6aebd5d52b6d5cbd1972ab4acad0a938d15b0150)；Task 3 分支的[选购服务记录](https://github.com/xxc0304/LT-agent-program/blob/codex/task3-openclaw-update-guard/docs/agent-sync-and-personalization-v0.1.md)也注明缺少服务 API/SDK、认证授权和测试端点。对 `选购服务`、`service integration` 的代码检索、相关 issue/PR 检索，以及 `task4` 分支检索均未找到新的服务资料或实现。当前任务 4 的本地改动尚未推送到 GitHub。

## 更新与回滚顺序

1. 固定服务 API 契约版本、连接器包版本、目标 OpenClaw 版本及最小权限。
2. 在合成数据 Mock 中跑连接器契约测试；再在服务方 sandbox 做 API 兼容验证。没有 sandbox 的情况下不得声称验证了真实 API。
3. 运行 manifest 更新预检；对权限、能力、数据保留或 API 契约变化单独人工审阅。
4. 将连接器与 OpenClaw 核心更新安排在不同维护操作中。先完成 OpenClaw 自身升级和插件健康检查，再进行 connector 激活。
5. 激活前备份 connector 版本及配置；失败只回滚 connector 版本，不回滚 OpenClaw 数据库/核心程序。

上述真正安装、灰度、激活锁和自动回滚尚未实现。它们须结合实际 OpenClaw 安装方式与 connector package 生命周期设计，不能由当前只读预检代替。

## 需要服务方/项目方补充

- 选购服务的正式名称、仓库或官方 SDK/API 文档，以及 API 契约/版本变更策略。
- 认证方式、权限或 scope 定义、密钥保管方式和撤销流程。
- 允许接入的调用范围、用户确认要求、个人数据类别与保留期。
- OpenClaw plugin/Agent 接入要求、测试用 Gateway 版本、sandbox 和合成测试账号。
- 发布包来源、签名/校验方式、维护责任人和可用回滚版本。

在这些信息提供前，任务 4 的本地通用准备已完成；真实连接器实现与服务更新兼容验证仍待外部输入。
