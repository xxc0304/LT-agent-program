# Profile 同步持久化契约（草案 v0.1）

状态：数据库无关的服务端实现草案；未选型、未部署、未处理真实用户数据。本文只把现有 Profile API 和内存原型的语义转换为持久化要求，不是可直接执行的数据库迁移。

## 1. 持久化边界

只持久化用户明确确认、获准同步的偏好当前状态、revision、幂等结果和同步状态。服务端必须从已验证身份与家庭成员关系解析 owner：

- `sharing_scope=personal` 时，owner 是服务端解析出的 profile；
- `sharing_scope=household` 时，owner 是服务端解析出的 home，并在每次读写时检查当前成员角色和授权；
- 请求体中的 `user_id`、`home_id`、`subject_id`、渠道发送者标识都不是 owner 来源。

服务端不保存 bearer token、API Key、原始对话、图像/视频、观察证据或本地候选。偏好字段继续受 [`user-preference-change.schema.json`](../common-contracts/schemas/user-preference-change.schema.json) 限制。

## 2. 逻辑记录

实现至少需要下列逻辑集合；实际可映射为关系表、文档集合或其他有事务能力的持久化结构。

| 集合 | 唯一键/字段 | 用途与约束 |
| --- | --- | --- |
| `preference_state` | `(owner_id, sharing_scope, preference_id)`；`revision`、`memory_type`、规范化 `scope`、`value`、`deleted`、`changed_at` | 每个偏好只保留当前状态。`revision` 从 1 单调递增；新建要求 `expected_revision=0`。活动值按 schema 校验。删除时清空 `memory_type/scope/value`，保留最小 tombstone（ID、revision、删除时间）。 |
| `owner_sync_state` | `(owner_id, sharing_scope)`；`last_cursor` | 为每个 owner 与范围分配单调递增游标。游标不能跨 owner 或 sharing scope 复用授权。 |
| `preference_sync_feed` | `(owner_id, sharing_scope, preference_id)`；唯一递增 `cursor`、`operation`、`revision`、upsert 快照或 delete tombstone | 供增量拉取。每个偏好仅保留最新状态事件；更新替换旧事件，删除事件不含旧偏好值。它是状态同步 feed，不是审计日志。 |
| `consent_state` | `(owner_id, permission, purpose, sharing_scope, preference_type_or_all)`；`active`、`revision`、`changed_at` | 授权状态唯一逻辑来源。`preference_sync` 对选定范围管理读/写同步权限；`agent_task` 只能为单一偏好类别授予 `profile:read`。撤回递增 revision，并在后续请求中立即拒绝。 |
| `idempotency_result` | `(owner_id, resource_type, sharing_scope, change_id)`；规范化请求摘要、原始结果状态/响应、创建与到期时间 | 对偏好或授权变更，相同 change ID 与相同请求返回原结果；同 key 不同请求返回 `IDEMPOTENCY_KEY_REUSED`。不得用客户端时间戳实现 last-write-wins。 |

`preference_state` 还需要自然键唯一约束：`(owner_id, sharing_scope, memory_type, canonical_scope)`。`canonical_scope` 必须将缺失范围规范化为 `{}`，并稳定规范 JSON 键顺序；这样同一房间/日期范围不能并存两个偏好 ID。删除时释放自然键，允许之后重新创建。

## 3. 原子写入流程

身份、当前同意和 scope 权限检查通过后，服务端在一个原子事务中执行偏好变更：

1. 锁定 `(owner_id, sharing_scope)` 的同步状态，避免并发写入分配重复游标。
2. 查找该 owner/scope 下的 `change_id`。相同请求摘要则返回已保存结果；摘要不同则返回 `409 IDEMPOTENCY_KEY_REUSED`。
3. 锁定对应 `preference_state`，检查其 revision 与 `expected_revision` 一致。不同则返回 `409 REVISION_CONFLICT`，不改状态、不发 feed 事件。
4. 校验偏好值和自然键唯一性；检查 household 写入角色仍有效。
5. 写入新状态并令 revision 加一；增加 owner/scope 游标；用当前状态替换该偏好的 feed 行；在幂等集合记录本次结果。
6. 一起提交状态、游标、feed 和幂等结果。任一步失败都整体回滚，客户端可用原 change ID 和原请求安全重试。

删除需要已有且未删除的记录。成功删除后，活动状态中的偏好值应清空，revision 和游标递增，feed 写最小 tombstone，幂等结果与删除原子提交。不得把删除当成普通空值 upsert。

授权变更契约见 [`profile-consent-change.schema.json`](../common-contracts/schemas/profile-consent-change.schema.json)，对应 `POST /v1/preferences/consents`。服务端按已验证主体及 permission/purpose/scope/category 定位 `consent_state`，校验 `expected_revision`，将 grant/revoke、新 revision 与幂等结果原子提交。授权检查必须与偏好读写具有可说明的一致性边界：撤回提交后发起的新请求应失败关闭；与撤回并发的在途读写须通过行锁、事务版本或等价机制界定顺序，不能仅依赖异步通知。授权端点和状态目前仅为契约草案，没有本地或生产授权服务实现。

增量拉取只查询已授权 owner/scope 的 `cursor > requested_cursor` 行，按 cursor 升序分页；返回 `next_cursor` 与 `has_more`。客户端只有在整页成功应用后才保存 next cursor。响应不可跨 owner/scope 缓存，HTTP 响应保持 `Cache-Control: no-store`。

## 4. 删除、保留与加密要求

- tombstone 至少保留到旧客户端不再可能持有活动值；当前没有客户端注册/游标确认协议，因此**不得先设定自动清理期限**。确定保留期前，删除 tombstone 会使离线旧客户端复活已删除偏好。
- 幂等结果保留时长必须覆盖客户端允许的最长离线重试窗口；该窗口、结果中是否含服务端当前偏好的值、以及删除账号时的清理方式都待负责人确定。若存储冲突响应快照，必须纳入 at-rest 加密和相同访问控制。
- 偏好状态、家庭关联和可能包含偏好值的幂等响应必须使用服务端受管密钥加密存储；密钥不入数据库、仓库或 Agent 工作区。传输使用 TLS；数据库备份按同等敏感级别加密和限权。
- 审计记录只记 actor 的内部审计 ID、操作类别、scope、结果码、时间和 trace ID，不复制 bearer token、原始偏好值或请求正文。
- 账号/家庭撤权必须即时阻止新读写；具体缓存失效、在途事务与跨服务撤权一致性需要与身份/同意提供方一起确定。

## 5. 并发与恢复

存储层必须提供 owner/scope 级串行化或等效事务隔离。唯一键冲突、事务超时和服务暂不可用应映射为明确可重试/不可重试响应；不得静默丢弃 revision 冲突。服务端重启后，偏好 revision、owner 游标、feed tombstone 与幂等结果必须仍可读。

发布/恢复前要验证数据库备份加密和恢复流程；不能把本地 `PreferenceMemoryStore` JSON/SQLite、`.lock` 文件或用户备份直接作为云端 Profile 数据源。旧本地 `subject_id` 迁移仍要求用户显式映射，不可按字符串猜 owner。

## 6. 当前与目标的差距

当前 `createInMemoryProfileSyncPrototype()` 只有进程内 Map。另有 `createSqliteProfileSyncPrototype()` 本地参考适配器，将整个原型状态序列化到一个 SQLite snapshot 行，并以 SQLite 事务跨服务实例重开恢复；其数据为明文，只用于合成数据演示，不是本文逻辑集合的规范化生产实现，也不构成数据库选型。`profile-consent-prototype.js` 提供进程内授权状态与 grant/revoke/revision/幂等演示，家庭授权默认失败关闭；它没有持久化或身份认证。`profile-sync-http-adapter.js` 仍是不监听端口的 `Request → Response` 原型，身份解析与当前授权由调用方注入，可选接入此内存授权账本完成本地合成请求。

另有 `/v1/preferences/current` 本地草案用于 Agent 任务的按类别读取：请求必须指定单一 `memory_type`，并在用途 `agent_task` 下对该类别与 scope 重查当前同意，响应只含匹配的当前偏好。它与全量变更 feed 分开，避免把设备同步缓存的整页内容直接提供给 Agent。`profile-sync-agent-reader.js` 将 OpenClaw 可信 sender context 映射到该接口，固定个人 scope 并去除不必要身份字段；目前仅在合成身份/授权演示中通过，未注册成真实 OpenClaw 工具，也未接真实身份、同意服务、bearer token provider 或网络。

本地 SQLite 服务端原型和内存原型都不自动清理 tombstone 或幂等记录，避免在没有客户端确认/重置协议时误删必要状态；其示例数据库仅在临时目录使用并于示例退出时移除。另有 `profile-sync-outbox.js` 客户端队列原型，以 AES-256-GCM 保存待发送偏好，要求外部密钥提供器、可信本地 principal binding 与逐次同意检查；`enqueueChangesAtomically()` 以单个 SQLite 事务保存迁移批次。`profile-sync-key-provider.js` 按平台选择 Windows 当前用户 DPAPI 或 Linux Secret Service，并按 principal 和用途分别派生 outbox 与客户端缓存密钥，可由二者共用同一回调；这不会让两类数据直接复用 AES 密钥。Linux provider 依赖用户登录会话中的 `secret-tool`/Secret Service；首次解锁可能触发系统提示，headless 服务可能无法访问，当前尚未在 Linux 验证。两者都没有明文文件或环境变量回退。密钥轮换/恢复流程未定义，且尚未连接真实身份/consent flow 或网络服务。生产 Profile 服务的加密存储、幂等期限、tombstone 保留/清理和账号删除还未实施。本文没有选择生产数据库或云厂商，也不代表服务端已实施。

Linux/POSIX 下，outbox、客户端缓存和 SQLite snapshot 共用 `profile-sync-sqlite-path.js`：父目录需归当前用户所有且为 `0700`，数据库文件为 `0600`；已有权限过宽的父目录、非当前用户文件、路径中的符号链接和数据库硬链接都会被拒绝。SQLite WAL/SHM sidecar 由私有父目录隔离。本实现尚未在 Linux/Docker 验证。

数据库/云服务选型、数据区域、责任人、保留期限、家庭角色策略、账号删除流程、离线客户端最长重试期与 tombstone 清理协议确定后，才能把本契约转成具体 migration 和部署方案。
