# 本地持久化设备事件账本 v0.1

## 目标

让真实 HA 适配器在 OpenClaw Gateway 重启后仍能查询最近的设备动作和诊断事件。默认行为不变：Mock 与未指定日志路径的后端继续使用有界内存账本；真实 HA 只有显式设置 `DEVICE_MANAGER_EVENT_LEDGER_PATH` 后才启用本地持久化。

持久层复用既有 `get_device_events` 接口，不改变设备工具契约和事件生产方式。开发阶段可通过 Fake HA HTTP 接口完成测试，不需要真实 HA。

## 持久化数据边界

- 每个文件最多保留最近 200 条，序号跨重启单调递增；筛选仍支持设备 ID、事件类型、`trace_id` 和数量。
- 只接受动作已执行/失败及设备诊断事件。持久化前构造白名单投影：动作名、简化前后状态、诊断代码、持续时间、受影响设备数量、实体 ID 和格式安全的 `trace_id`。
- 丢弃动作任意参数、任务 ID、幂等键、错误文本、诊断自由文本摘要、HA 地址和认证令牌；数据文件的 `source.id` 固定为 `home_assistant`。
- 文件位于管理员指定的本机路径。默认账本路径可由 `resolveDeviceEventLedgerPath()` 取得；生产 HA 后端只有在配置 `DEVICE_MANAGER_EVENT_LEDGER_PATH` 时才启用持久化。没有更改任何现有 Gateway 环境变量或本机 profile。
- 文件采用 JSON 和原子临时文件替换，不提供应用层加密。管理员需选受本机磁盘/访问控制保护的位置；不要写入 Git、普通云盘或跨设备同步目录。
- 写入持有独占锁。并发锁、损坏文件和无效 schema 均失败关闭；异常退出残留锁时需要管理员先确认没有活跃写入进程，再按部署手册人工处理，不自动删除锁。

## 启用方法

只在已完成真实 HA 配置和本机存储评估后，才为启动 OpenClaw Gateway 的本地环境设置 `DEVICE_MANAGER_EVENT_LEDGER_PATH`。例如 PowerShell 当前会话可采用：

```powershell
$env:DEVICE_MANAGER_EVENT_LEDGER_PATH = Join-Path $env:LOCALAPPDATA 'LT-agent-program\device-events.json'
```

该示例仅供用户在准备启用时执行；开发验证没有设置该变量，也没有创建真实日志文件。重新启动 Gateway 后，真实 HA 后端才会读取此路径。

## 验证

自动测试覆盖同路径跨 Node 进程重载、同进程多个实例追加不丢数据、事件序号/容量/筛选、白名单脱敏、锁冲突和损坏文件失败关闭，以及真实 HA 后端的显式接入。HTTP 调用使用 Fake HA 响应，不连接真实设备；自动化结果不等于真实部署文件 ACL、磁盘加密或物理设备验收。

