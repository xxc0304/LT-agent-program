# 家庭微脑公共契约（草案 v0.1）

这里定义各 Agent 之间交换的最小 JSON 格式。当前是讨论稿，不代表学长和其他小组已经最终确认；字段命名和枚举值经过联调会议后再发布 `v1`。

## 为什么现在就建立

其他 Agent 尚未完成时，可以先用示例 JSON 和 Mock 生产者/消费者验证设备管家。等真实 Agent 加入，只要遵守同一份契约，就不需要改设备管家的核心工具。

## 当前对象

- `Device`：设备的统一描述；
- `Event`：感知侧发布的事实，例如人体感应、学习行为或设备异常；
- `Task`：一个 Agent 请求另一个 Agent 执行的任务；
- `TaskReceipt`：任务执行后的标准回执；
- `PolicyDecision`：允许、拒绝或需要人工确认的策略结果；
- `ResourceStatus`：算力或执行节点的可用状态。

## 设备管家当前接入的任务类型

`control_device`、`get_state`、`run_scene`、`diagnose_device`。

设备管家的标准任务入口暂时以代码运行时形式提供，后续可由编排器、消息队列或 OpenClaw 工具调用。现阶段不把它误称为已经存在的其他 Agent。

## 字段约定

- 时间统一使用 ISO 8601 UTC 字符串；
- `confidence` 为 0 到 1 的数字；
- `privacy_level` 当前草案使用 `family`、`sensitive`、`restricted`；
- `resource_requirement.execution_mode` 当前使用 `local`、`edge`、`cloud`；
- 任务状态使用大写枚举：`SUCCEEDED`、`FAILED`、`DENIED`、`CHALLENGE`、`TIMEOUT`、`RETRYABLE`；
- 所有对象保留 `schema_version`，以后兼容升级时增加版本而不是悄悄改变字段含义。
- 设备管家事件目前使用 `schema_version: "0.1"`，在通用 Event 字段外补充 `source`、`subject`、
  `severity`、`data_level`、`received_at` 和 `dedup_key`；这些扩展已写入 `schemas/event.schema.json`。

## 如何验证

在项目根目录执行：

```powershell
node common-contracts/validate-examples.mjs
```

设备管家任务入口测试：

```powershell
Set-Location device-manager
npm test
```

当前示例校验还包含 `examples/device-action-event.json`，用于确认设备动作事件可以被其他 Agent 消费。

## 需要和其他小组确认的问题

1. `source_agent`、`target_agent` 的正式命名；
2. `task_type` 是否还需要增加通知、抓拍、算力调度等类型；
3. 优先级、隐私级别和超时字段的枚举；
4. PolicyDecision 由哪个 Agent 产生，以及 `CHALLENGE` 的确认回传方式；
5. 公共契约由谁维护、如何版本发布。
