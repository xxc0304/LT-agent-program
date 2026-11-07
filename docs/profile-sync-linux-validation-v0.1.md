# Profile 同步 Linux 验证步骤（v0.1）

本清单用于改动推送后在 Ubuntu 24.04 / Node.js 24 上验证 Task 2 的本地原型。它不调用云端 API，不需要 DeepSeek API Key，也不代表生产环境验收。

## 1. 运行无密钥库的合成回归

从仓库根目录运行：

```bash
node --version
node --test \
  agent-memory/test/profile-consent-prototype.test.js \
  agent-memory/test/profile-sync-engine.test.js \
  agent-memory/test/profile-sync-http.test.js \
  agent-memory/test/profile-sync-key-derivation.test.js \
  agent-memory/test/profile-sync-sqlite-path.test.js
node agent-memory/examples/profile-sync-local-e2e-prototype.js
```

Node 版本应为 24.x。Linux 下 SQLite 权限/符号链接用例应执行而不是跳过；端到端示例应输出 `status: passed`，并标明没有使用真实网络或监听端口。

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
