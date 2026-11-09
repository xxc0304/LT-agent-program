# Profile 同步 Linux 验证步骤（v0.1）

本清单用于改动推送后在 Ubuntu 24.04 / Node.js 24 上验证 Task 2 的本地原型。它不调用云端 API，不需要 DeepSeek API Key，也不代表生产环境验收。

## 1. 运行无密钥库的合成回归

从仓库根目录运行：

```bash
node --version
node --test \
  agent-memory/test/profile-consent-prototype.test.js \
  agent-memory/test/profile-consent-sqlite-prototype.test.js \
  agent-memory/test/profile-sync-engine.test.js \
  agent-memory/test/profile-sync-http.test.js \
  agent-memory/test/profile-sync-key-derivation.test.js \
  agent-memory/test/profile-sync-linux-secret-service-provider.test.js \
  agent-memory/test/profile-sync-sqlite-path.test.js
node agent-memory/examples/profile-sync-local-e2e-prototype.js
```

Node 版本应为 24.x。Linux 下 SQLite 权限/符号链接用例应执行而不是跳过；端到端示例应输出 `status: passed`，并标明仅使用临时 `127.0.0.1` loopback 监听器，没有使用外部网络、云 API 或真实家庭数据。

新增的 `profile-sync-linux-secret-service-provider.test.js` 在 Linux 上使用临时目录中的合成 `secret-tool` 可执行文件，验证 provider 的读取/存储命令、密钥派生隔离、文件权限和失败关闭行为。它不连接用户的 D-Bus/Secret Service 密钥库；Windows 上会跳过，Ubuntu CI 才能执行这些 Linux 专属用例。

## 2. 单独验证 Secret Service

只在已登录的 Ubuntu 桌面会话中运行，确保当前用户的 Secret Service 可用且密钥库已解锁：

```bash
command -v secret-tool
node agent-memory/examples/profile-sync-linux-key-provider-smoke.js
```

预期输出为 `status: passed`，且不包含密钥材料。该脚本只使用合成主体，检查同一用途/主体的密钥稳定、不同用途和主体的密钥隔离。它不联网，不需要也不会提示输入 API Key；若系统弹出密钥库解锁提示，应只在系统提示框中操作。

**密钥库副作用：** 首次执行会在当前用户 Secret Service 中创建一个独立的随机测试根密钥，属性命名空间为 `lt-agent-program-profile-sync-smoke`；它不会与正式应用使用的 `lt-agent-program` 根密钥混用。锁目录建在临时目录并在脚本结束时清除。测试根密钥会留在系统密钥库；如需清理，只清理这个专用测试命名空间：

```bash
secret-tool clear application lt-agent-program-profile-sync-smoke purpose profile-sync-outbox-key
```

不要清理正式应用命名空间 `lt-agent-program`，删除正式根密钥会使使用它加密的本地数据无法解密。

如果 `secret-tool` 不存在、没有可用的用户会话总线、密钥库无法解锁或超时，provider 应失败关闭，不应改用明文文件或环境变量回退。无桌面会话运行的后台服务仍需单独设计和验证密钥管理方式。

## 3. 结果边界

记录 Node 版本、上述测试通过/跳过数量、端到端状态、Secret Service smoke 状态及是否出现密钥库提示。不要记录或发送任何密钥值。测试全部通过也只证明 Ubuntu 本机的合成原型行为，不证明真实身份、同意服务、云端 API、部署或恢复流程已完成。

## 4. 本轮 Ubuntu CI 执行记录

2026-11-07，GitHub Actions 在 Ubuntu 24.04 / Node.js 24 上运行 [workflow #26](https://github.com/xxc0304/LT-agent-program/actions/runs/42375234591)，提交 `1988269`：当时 Profile 同步专项测试 **17/17 通过、0 跳过**；其中 POSIX SQLite 权限/链接用例在 Linux 上实际执行；当时的端到端原型未监听端口。完整 Linux 本地/Mock workflow **11/11 检查通过**，家庭记忆套件 **81/81 通过**。后续新增的 loopback HTTP transport、合成 `secret-tool` provider 测试尚无新的 Ubuntu CI 运行记录。

2026-11-08 本地 Windows / Node.js 24.22.1 回归：`agent-memory` 共 **95 项，85 通过、10 项 Linux/POSIX 专属用例跳过**。新增用例覆盖单个 HTTP 适配器实例内撤权与 Profile 读写的串行顺序，以及授权服务故障返回 503。该结果不算 Linux 验证；本轮代码尚未在 Ubuntu workflow 执行。生产多实例的撤权一致性仍必须由共享数据库事务保证。

初次运行 [workflow #22](https://github.com/xxc0304/LT-agent-program/actions/runs/42373469770) 曾因 SQLite 备份函数创建的输出目录受系统 `umask` 影响而失败。修复后，备份及恢复目标目录通过私有路径 helper 创建并验证为 `0700`；另外增加了拒绝群组/其他用户可访问的已有输出目录的 Linux 回归用例。GitHub Actions 不运行需要登录桌面密钥库的 Secret Service smoke，因此该项仍须在已登录且密钥库已解锁的 Ubuntu 桌面会话按上方步骤单独验证。
