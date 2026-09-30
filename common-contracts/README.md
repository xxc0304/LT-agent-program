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

HA 设备统一视图到协议组 UDM 的字段映射草案见 [`UDM_MAPPING_DRAFT_v0.1.md`](./UDM_MAPPING_DRAFT_v0.1.md)。文档区分了当前可从 HA State 取得的内容与需要额外 Device/Area Registry、事件流或显式策略配置的内容；没有来源的数据不猜测、不伪造。

Task 旧字段别名、优先级和数据级别的本地兼容规则见 [`TASK_COMPATIBILITY_DRAFT_v0.1.md`](./TASK_COMPATIBILITY_DRAFT_v0.1.md)。此文档是 Agent 组讨论稿，不是跨组定稿；调度器入口会校验 `source_agent/source`、`target_agent/target` 一致后规范化为 canonical 字段，设备管家直连接口也会拒绝冲突值。设备管家会检查 canonical Task 的必填字段和关键枚举，按 `resource_requirement` 转换内部路由要求，不从 `compute_requirement` 推断执行位置；旧策略兼容类按显式 `privacy_level` 与本地 `data_level` 派生类中的更严格者处理。

别名转换由 [`task-compat.mjs`](./task-compat.mjs) 统一实现；两处 Agent 边界共用该模块，回归测试位于 `common-contracts/test/`。调度器在排队前还会验证 canonical Task 的版本、优先级、数据/隐私级别、设备 ID、执行模式和截止时间，非法任务不会进入队列。

## 当前任务形态

草案暂时兼容两种实现：

- 设备管家旧任务：`control_device`、`get_state`、`run_scene`、`diagnose_device`，通过 `payload` 携带参数；
- canonical 设备动作任务：`device_action`，通过 `target_ref`、`action`、`parameters`、`idempotency_key` 和 `trace_id` 表达。

设备管家的标准任务入口暂时以代码运行时形式提供，后续可由编排器、消息队列或 OpenClaw 工具调用。现阶段不把它误称为已经存在的其他 Agent。

旧任务保留 `low/normal/high/critical` 优先级；canonical Task 使用 `P0`–`P4`。这只是本地兼容，统一枚举仍须跨组确认。`Task.status`（任务生命周期）与 `TaskReceipt.status`（执行回执结果）是不同语义；回执中的 `CHALLENGE`、`TIMEOUT`、`RETRYABLE` 不应作为任务生命周期值使用。

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

当前校验覆盖 Device、ResourceStatus、PolicyDecision、旧/新版 Task、TaskReceipt、学习、安全及作息到期事件等 **18 个有效样例**，并确认 **4 个无效样例（缺字段或别名冲突）会被拒绝**。校验器无第三方依赖，仅实现本仓库 Schema 当前使用的 JSON Schema 关键字子集，并对 Task 别名一致性做额外语义校验；若 Schema 引入新关键字，需同步扩展校验器或换用完整 JSON Schema 实现。

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
6. Device 当前 HA 统一视图如何映射到协议组 UDM 字段（vendor、location、properties、events、services、constraints、securityLevel、version）；
7. 飞书计划中的数据级别 L1–L4 与当前代码草案 L0–L3 的映射。未确认前，两套编号不能宣称已统一。

本轮已将 `ResourceStatus`、`PolicyDecision` 草案 Schema/样例对齐到本组 Mock 编排器，并增加了 Mock canonical Task 的校验样例。Task 示例会带上与 canonical 字段相同的旧别名以覆盖兼容规则；跨边界时调度器会归一化为 canonical 字段。优先级和数据级别的跨组语义尚未确认。所有内容仍是本组可供评审的 v0.1 讨论稿，不代表已跨组联调或冻结；定稿前要由对应小组共同确认并同步修改 Schema、示例和代码适配器。

事件、设备和任务样例只用于本地 Mock/契约测试；`security-*-event.json` 均为模拟输入，不代表真实传感器、摄像头或识别模型结果。
