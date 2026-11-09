# 服务端与云端 Agent 同步及用户个性化设计

版本：v0.1（本地原型版；未部署、未跨组确认）

状态：截至 2026-11-08，设计、契约和本地合成数据原型已完成；HTTP 原型在单进程内串行化同意变更与受保护读写；真实身份/同意服务、生产 API、签名密钥与远程部署尚未接入

核对基线：GitHub main `6aebd5d`。Profile 同步、SQLite 权限与端到端合成原型曾在 Ubuntu 24.04 / Node.js 24 的 [workflow #26](./profile-sync-linux-validation-v0.1.md#4-本轮-ubuntu-ci-执行记录) 验证通过；这不覆盖真实 Secret Service 密钥库、云端身份/授权或生产部署。

## 1. 目标与结论

本设计解决两种不同的更新问题：

1. **Agent 发布更新**：如何把已审核的代码、Skill、提示模板和兼容配置部署到本地 Gateway、服务端和云端 Agent。
2. **用户个性化更新**：如何让用户在一端确认的偏好，在获授权的其他运行端及时可见，同时支持撤回、删除和并发冲突处理。

建议采用两个独立通道：Agent 软件走有版本、有校验、有回滚的发布通道；个人偏好走按用户身份授权、按记录修订号同步的 Profile API。不要把个人偏好打进发布包、Git、共享工作区或 Agent 启动提示中。

本设计起点是单机偏好存储、加密备份库和本地 Agent 模板。当前仓库已增加偏好变更 Schema/OpenAPI、身份映射与同步原型、SQLite snapshot、AES-GCM 离线 outbox、Windows DPAPI key-provider 与 Linux Secret Service key-provider 代码，以及 Agent 清单/打包/签名/验收工具；这些仅完成本地契约与合成数据原型，不代表真实跨设备同步或远程发布已经可用。Linux 基线为 Ubuntu 24.04 / Node.js 24。Profile/SQLite 合成测试已在 Ubuntu CI 验证。真实 Linux key-provider smoke 仍依赖用户登录会话中的 Secret Service 和 `secret-tool`；密钥库解锁可能触发系统提示，headless 服务可能无法访问。另加的合成 `secret-tool` 自动化测试会随下一轮 Ubuntu CI 验证，但它也不替代真实桌面密钥库 smoke。Linux 宿主不得改用明文文件或环境变量保存 outbox 密钥。

SQLite outbox、客户端加密缓存和本地服务端 snapshot 统一经过 POSIX 私有路径检查：数据库父目录需由当前用户拥有且权限为 `0700`，数据库文件设为 `0600`，WAL/SHM 文件受父目录权限保护。已有目录权限过宽、所有者不符、路径经过符号链接或数据库为硬链接时会失败关闭。密钥入口 `profile-sync-key-provider.js` 按平台选择 DPAPI/Secret Service，并按数据用途隔离 outbox 与客户端缓存密钥。Ubuntu CI 已验证 Profile 同步/SQLite 合成回归；Docker 部署和真实 Secret Service smoke 仍未验证。

## 2. 当前实现核对

| 范围 | 已有能力 | 尚缺内容 |
| --- | --- | --- |
| Agent 工作区 | `openclaw-agents/` 中模板随 Git 版本管理 | 更新模板不会自动修改每台机器的 OpenClaw 注册、配置或已安装 Skill |
| OpenClaw 运行状态 | 每个 Agent 有独立 workspace、`agentDir`、认证配置和会话数据库 | 多 Agent 或多台 Gateway 之间不会因此自动共享工作区/会话 |
| 个性化数据 | 主线 `PreferenceMemoryStore` 支持 JSON 兼容后端及 SQLite Schema 0.6，包含温度、亮度和作息偏好；支持确认、更新、删除 | 本机存储仍没有账户绑定或远端 Profile 服务 |
| 本地 Profile 同步原型 | 已有合成身份映射、变更协议、内存/SQLite 原型、HTTP 边界适配器和加密离线 outbox | 没有真实身份/同意服务、监听中的 Profile API、生产数据库或云端同步客户端 |
| Agent 发布工件 | 已有两 Agent 的清单、只读对比、打包、分离签名和验收工具；本机包已通过未签名内容验收 | 没有正式签名密钥、CI 发布服务、安装器、远程部署/灰度/回滚控制面 |
| 备份 | `encrypted-backup.js` 提供用户显式触发的加密备份/恢复 | 备份不是同步协议，活动文件仍为明文；不应把备份文件当在线共享数据源 |
| OpenClaw 记忆工具 | 插件暴露查询、保存、候选确认和删除等工具 | 输入中的 `subject_id` 由模型调用参数给出，不能作为身份凭据。精确版本 `2026.7.1-2` 的静态工具执行上下文没有发送者身份；工具工厂上下文另有可选 `requesterSenderId`，但它是渠道范围的发送者标识，不是 Profile API 的规范用户 ID，当前插件也没有使用它 |

本地偏好文件的 `.lock` 只用于本机文件并发保护，不能用于网络盘或多端写入。已有文档 [`agent-trigger-and-memory-policy.md`](./agent-trigger-and-memory-policy.md) 对本地数据和备份边界有完整说明。

## 3. 推荐总体架构

```text
Git / CI  ──签名版本化发布包──>  本地 Gateway / 服务端 Agent / 云端 Agent
                                      │
                                      │ 仅代码、Skills、非个人模板和兼容配置
                                      │
用户身份提供方 ──短期授权令牌──> Profile API（用户/家庭偏好唯一写入源）
                                      ▲  ▲
                           本地 Gateway  云端 Agent
                           加密本地缓存  按任务最小读取
```

Profile API 是偏好状态的唯一逻辑权威源。运行端只持有最小化、可过期的缓存；云端 Agent 不复制整份 OpenClaw workspace 或 `USER.md`，而是在每个获授权任务开始时按需读取所需字段。偏好被确认或修改后，写入 API 成功才算跨端更新成功；响应带服务端修订号。其他端通过轮询/游标拉取更新，后续可加通知加速，但通知不能替代可恢复的拉取流程。

在 Profile API、认证和本地缓存加密没有完成前，继续使用现有本地模式；不得暗中把本地 JSON 上传，也不得宣称其他 Agent 已看到本次修改。

## 4. Agent 软件与配置更新通道

### 纳入发布包

- 插件和 Agent 业务代码；
- Skills、`AGENTS.md`/`SOUL.md`/`IDENTITY.md` 等通用模板；
- 经审查的非个人默认配置与迁移脚本；
- 发布清单：项目版本、Git commit、OpenClaw 兼容版本、文件摘要和迁移版本。

### 排除发布包

- 用户/家庭的 `USER.md`、记忆 JSON、会话记录和个人目录；
- OpenClaw 的认证数据库、API Key、Token、渠道凭据；
- Home Assistant 凭据、真实设备快照及本地运行日志。

### 更新流程

1. CI 从受保护的 Git tag 构建不可变发布包，生成哈希并签名。
2. 目标端检查签名、哈希、当前 OpenClaw 版本和迁移前置条件；不满足则拒绝应用。
3. 在隔离副本/测试 Gateway 做插件加载与健康检查，再按开发端 → 单台服务端 → 小流量云端的顺序灰度。
4. 更新采用原子版本切换；失败时回到上一个已验证包。记录每个 Agent 的 `release_version`、`workspace_revision`、`openclaw_version`、`applied_at` 和健康状态。
5. 本机 OpenClaw roster、频道绑定和密钥仍由该主机的受控配置管理；安装包不得直接覆盖现有 profile。任何破坏性配置迁移必须单独备份、审查并确认。

仓库没有发布服务或远程部署代理，当前 Mock 编排器也不是远程消息总线。本地已有签名器和验签器，但仓库没有正式密钥；本节的 CI、目标端安装、灰度、原子切换和回滚仍是目标流程，不描述已完成能力。

本地已增加 [`tools/build-openclaw-agent-manifest.mjs`](../tools/build-openclaw-agent-manifest.mjs)、[`tools/compare-openclaw-agent-workspace.mjs`](../tools/compare-openclaw-agent-workspace.mjs)、[`tools/package-openclaw-agent-release.mjs`](../tools/package-openclaw-agent-release.mjs)、[`tools/sign-openclaw-agent-release.mjs`](../tools/sign-openclaw-agent-release.mjs)、[`tools/verify-openclaw-agent-release.mjs`](../tools/verify-openclaw-agent-release.mjs)、[`tools/plan-openclaw-agent-rollout.mjs`](../tools/plan-openclaw-agent-rollout.mjs)、[`tools/plan-openclaw-agent-upgrade.mjs`](../tools/plan-openclaw-agent-upgrade.mjs) 和 [`tools/stage-openclaw-agent-release.mjs`](../tools/stage-openclaw-agent-release.mjs)：分别生成工作区文件哈希清单、只读报告目标目录的缺失/变更/额外文件、复制清单中的已审核模板并核验哈希后生成本机发布目录、从外部受保护 Ed25519 私钥生成分离签名、复核包指纹/文件哈希/排除规则/文件集合、按目标 OpenClaw 版本给出只读新增/替换/不变计划、对比旧版/新版/目标工作区以识别本地编辑冲突，以及把已验签的版本包原子写入一个新的指纹目录。Stage 工具不会激活版本、改写 OpenClaw 配置或覆盖现有目录。仓库没有正式发布私钥或受信公钥，故本机当前产物仍未签名，生产密钥应由 CI/KMS 管理。

只读发布预览命令为：`node tools/plan-openclaw-agent-rollout.mjs --bundle <release-dir> --target-root <existing-root> --openclaw-version <version> [--public-key <trusted-key.pem>]`。目标根目录下按 `learning-companion/`、`energy-saving/` 映射；预览要求目标根已存在且不为符号链接。该工具永远不执行安装（`apply_permitted` 始终为 `false`）；即使签名和版本条件满足，也只输出可以交给独立安装流程的差异。合成测试覆盖版本不匹配、缺少可信签名、包篡改、用户文件与本地 OpenClaw 配置不被触碰。

已验签包可使用 `node tools/stage-openclaw-agent-release.mjs --bundle <release-dir> --staging-root <existing-directory> --openclaw-version <version> --public-key <trusted-key.pem>` 暂存。命令只接受受信公钥验签成功且精确匹配版本的包，并拒绝覆盖已有指纹目录；暂存结果仍不是活动工作区，也不提供 Gateway 激活或生产回滚。

升级前的三方预览命令为 `node tools/plan-openclaw-agent-upgrade.mjs --previous <old-release-dir> --next <new-release-dir> --target-root <existing-root> --openclaw-version <version> --public-key <trusted-key.pem>`。旧包和新包都必须由同一受信公钥验证；目标工作区中的文件若仍匹配旧包，可列为上游更新；若上游内容未变而目标已自定义，会建议保留本地修改；双方都改过的文件、目标删除项和上游废弃项会要求人工复核。该工具同样只生成计划，`apply_permitted` 始终为 `false`。

本轮对预览/暂存流程的隔离测试为 4/4 通过；测试临时生成并签名合成旧版/新版包，在系统临时目录演练文件差异、版本不匹配、未签名/篡改包拒绝、原子暂存和现有目录保护，以及本地编辑与上游变更的三方冲突识别。临时工作区内的用户文件及 OpenClaw 配置未变化；没有修改正式发布包、Agent 工作区或 Gateway 配置。

### OpenClaw 自更新与 Agent 发布的边界

核对结论与版本差异见 [`openclaw-update-agent-release-compatibility-v0.1.md`](./openclaw-update-agent-release-compatibility-v0.1.md)：两套更新器管理对象分开时没有直接文件冲突；组合风险在 Gateway 重启、Agent 激活并发与版本不兼容。OpenClaw 更新和 Agent 包应用须分开执行、分别验收和回滚。

### 选购服务与 OpenClaw 接入

2026-11-07 对当前仓库进行源码与接口清单检索，未发现选购/购物服务的实现、API/OpenAPI、SDK、测试环境配置或更新版本说明；`multi-agent-orchestrator` 也没有已登记的选购服务 Agent/能力。已新增 [`deployment/openclaw-service-integration.mjs`](../deployment/openclaw-service-integration.mjs) 通用 manifest 校验和只读升级预检，并补充 [`openclaw-service-integration-lifecycle-v0.1.md`](./openclaw-service-integration-lifecycle-v0.1.md)。它强制显式声明连接器/OpenClaw 版本、权限、能力影响、逐次确认、数据保留和密钥引用；权限/API/数据边界变化会要求人工复核。工具不联网、不读密钥、不安装插件、不改 Gateway 配置，且始终禁止激活。

真实连接器和服务升级兼容性仍不能凭现有仓库完成。下一步需取得选购服务的仓库/SDK 或 API 契约、版本更新说明、认证与授权范围，以及合成数据 sandbox；随后按独立 OpenClaw 适配器接入并做接口/版本兼容校验。Gateway 更新和服务适配器更新应分别发布与回滚。

## 5. 用户偏好同步协议

### 5.1 身份与授权

- 调用方先通过已选定的身份提供方登录；Profile API 校验短期令牌签名、受众、过期时间和授权范围。
- `user_id`、`home_id`、成员角色由服务端从已验证身份与家庭成员关系中解析；**禁止从模型参数、自然语言或客户端请求体信任这些身份字段**。
- OpenClaw 工具适配器要把可信请求主体作为执行上下文传给 Profile client。当前锁定版本的 tool factory context 有可选 `requesterSenderId`，但需同时取得渠道命名空间并由服务端身份映射绑定；它不是可直接信任的通用用户 ID。若运行时不能提供可靠主体，则只允许单用户本地模式，不开放跨用户/家庭读取。
- 用户授权按用途/偏好类别记录。云端 Agent 只可获得具体任务所需的已确认偏好；“同意保存本地记忆”不等于“同意上传云端”。撤回授权后立即拒绝新的读写，并停止待发送变更。
- 家庭成员不得默认互相读取个人偏好。家庭共享项与个人项必须有明确的数据范围和角色规则。

### 5.2 数据范围

v0.1 只同步用户明确保存或明确确认的四类结构化偏好：

- `comfort_temperature_c`：16–30℃ 数值，可按房间范围；
- `comfort_brightness_pct`：1–100% 数值，可按房间范围；
- `sleep_time` / `wake_time`：`HH:mm` 字符串，必须包含 IANA 时区，可按周内/周末和房间范围。

只同步当前已确认状态。`observing`、`pending_confirmation`、证据事件 ID、观察日期、原始聊天、图像/视频、儿童身份资料、设备实时状态、令牌和 API Key 均不上传。未确认候选继续留在本地；用户在某一端完成确认后，才产生偏好变更请求。

请求契约见 [`common-contracts/schemas/user-preference-change.schema.json`](../common-contracts/schemas/user-preference-change.schema.json)。请求体不含 `user_id`/`home_id`/`subject_id`；只携带用户明确选择的 `sharing_scope`（`personal` 或 `household`），服务器从已验证认证上下文解析记录所有者，并检查调用者是否有权写入家庭共享偏好。旧本地数据的 `subject_id`（例如 `household`、`adult_1`）不能自动等同于认证账号，导入时须由用户明确映射。

### 5.3 更新、去重和冲突

变更请求示例（用户确认后，将个人卧室舒适温度从 revision 3 更新为 revision 4）：

```json
{
  "schema_version": "0.1",
  "change_id": "3de93b82-4102-4617-9b35-5d83c2fa35d1",
  "preference_id": "457045ef-bdd0-4caf-bab1-b2baf4697119",
  "operation": "upsert",
  "sharing_scope": "personal",
  "expected_revision": 3,
  "changed_at": "2026-11-06T08:30:00Z",
  "preference": {
    "memory_type": "comfort_temperature_c",
    "value": 25,
    "scope": { "room_id": "bedroom" }
  }
}
```

成功响应至少返回 `{ "applied": true, "preference_id": "…", "revision": 4, "cursor": "…" }`；版本不匹配返回 `409 REVISION_CONFLICT` 和当前 revision，不回显其他用户数据。

- 每个逻辑偏好使用稳定 UUID `preference_id`，首次创建时由客户端生成并由服务端绑定到已认证 owner；服务端维护单调递增 `revision`。创建请求的 `expected_revision` 为 `0`；修改/删除时必须带客户端最后读到的 revision。
- 服务端按已认证的 owner、`sharing_scope`、偏好类型和规范化范围保持唯一记录；创建时若已有同范围记录，返回冲突并要求客户端读取后更新原记录，避免同一房间偏好分叉成多个 ID。
- `change_id` 是幂等键。相同 `change_id` 重试时返回第一次处理结果，不重复写入。
- 服务端只在当前 revision 等于 `expected_revision` 时接受更新；否则返回 `409 REVISION_CONFLICT` 和当前服务端值/revision。禁止用客户端时间戳做 Last-Write-Wins。
- 冲突时保留服务端版本和客户端待确认编辑，不自动拼接、不静默覆盖；向用户展示差异并由用户明确选择，再以最新 revision 重试。
- 成功写入后，服务端返回新 revision 和同步游标。其他 Agent 拉取后更新本地只读缓存，并记录 `last_synced_cursor`。
- 删除写入 tombstone（只含 `preference_id`、新 revision、删除时间和作用域索引），不能只在本机物理删除。已授权客户端拉取删除后才可清除缓存；服务端 tombstone 至少保留到不会再有旧客户端重放，并与账户删除/数据保留政策一致。不能为了设定短保留期而冒着旧副本复活数据的风险。

### 5.4 缓存、离线和失效

- 本地缓存必须先实现应用层加密和受限 ACL；密钥由平台安全存储管理，不写入配置文件、环境变量或发布包。
- v0.1 不做离线写入队列。断网时可在明确标记“可能过期”的情况下读取未过期缓存；修改/删除跨端偏好必须等待服务端确认，避免多个本地明文副本和不可控冲突。
- 高敏感或会影响设备动作的读取按任务实时拉取，并在动作执行前重新检查偏好授权、revision 与设备实时状态。缓存/记忆只提供建议，不能成为控制授权。
- Profile API 暂不可用、身份失效、授权撤回或数据版本不受支持时失败关闭：不猜测身份、不回退到其他成员数据、不从旧会话中拼出偏好。

### 5.5 建议 API 形态（供服务端评审）

```text
POST   /v1/profile/preference-changes       创建/修改/删除（契约请求体 + Authorization）
GET    /v1/profile/preferences?cursor=...   按已授权主体增量拉取变更/tombstone
GET    /v1/profile/preferences/{id}         读取单条、返回 revision 与缓存控制
POST   /v1/preferences/consents             记录或撤回授权
```

授权变更草案见 [`profile-consent-change.schema.json`](../common-contracts/schemas/profile-consent-change.schema.json) 和 OpenAPI `POST /v1/preferences/consents`：同步授权以明确选择的 `sharing_scope` 为单位；Agent 任务读取授权必须限定为一个偏好类别且只允许 `profile:read`。创建与撤回均带 `change_id`、`expected_revision`，由服务器以已验证主体定位授权记录；家庭成员资格/管理角色始终由服务端检查。撤回后新请求必须立即被拒绝，客户端还要停止该范围的待发队列并清除本地缓存。现有 [`profile-consent-prototype.js`](../agent-memory/src/profile-consent-prototype.js) 用于内存合成验证；新增 [`profile-consent-sqlite-prototype.js`](../agent-memory/src/profile-consent-sqlite-prototype.js) 将授权状态、revision 和幂等结果保存在本地 SQLite 快照中并可跨实例重开。两者都不认证真实用户，也没有生产撤权传播服务。

以上 API 路径和状态码为建议，不代表仓库已有 HTTP 服务。服务器必须以令牌主体为准做每条记录的授权；仅用随机 ID 隐藏用户并不足以形成访问控制。

## 6. OpenClaw 接入规则

OpenClaw 的 Agent workspace、`agentDir` 与会话状态是分开的；同一 Gateway 内多个 Agent 也不会自动共享全部插件数据。其 `USER.md` 是工作区引导文件，而不是具备身份校验、版本冲突和删除传播能力的 Profile 数据库。因此：

- 仓库中的 `USER.md` 只保留通用模板，不放真实个人偏好；
- 个人沟通习惯可在明确同意后写入目标 OpenClaw 版本实际支持的用户配置；项目锁定版本是否支持新版 per-profile `USER.md` 管理能力尚未确认。无论是否支持，都不得把家庭偏好 JSON 复制到 `USER.md`；
- 温度/作息通过 Profile tool 按已认证用户读取；Agent prompt 只接收当前任务必需字段、数据来源和 revision；
- 多用户 Gateway 必须先将渠道主体映射到独立、已验证的 OpenClaw profile，再由服务端校验该 profile 对应的服务端主体；共享 Owner 或群聊身份不能冒充个人授权；
- 项目已只读核对本地安装的 OpenClaw `2026.7.1-2` 类型定义：静态 `execute` context 只有运行 API、取消信号、tool-call ID 和进度回调；tool factory context 有可选 `requesterSenderId`、`deliveryContext` 和 owner 标记。前两项可作为后续身份映射的输入，但渠道 ID、身份验证与服务端账号绑定仍须设计并验证；`senderIsOwner` 仅是权限标记，不能代替用户 ID。当前插件没有做这条映射，因此跨用户/Profile API 接入仍未完成。

参考：[OpenClaw Multi-agent routing](https://docs.openclaw.ai/concepts/multi-agent)、[OpenClaw User model](https://docs.openclaw.ai/concepts/user-model)、[OpenClaw Agent workspace](https://docs.openclaw.ai/concepts/agent-workspace)。这些是当前官方在线文档；项目锁定的 `2026.7.1-2` 行为以本地包类型定义和随包文档为准，不能把在线文档中的新功能视为已部署能力。

## 7. 分阶段实施与验收门槛

| 阶段 | 工作 | 完成条件 |
| --- | --- | --- |
| 0. 本轮设计 | 固化 Agent 发布与 Profile 同步分层；提出 v0.1 变更 Schema | 文档、契约经项目/服务端/隐私负责人评审；没有真实数据传输 |
| 1. 运行时身份核验 | 核验 OpenClaw 目标版本是否提供可信请求上下文；建立仅使用合成 ID 的渠道身份映射原型 | 工具上下文证据和原型已记录；真实身份提供方、成员授权矩阵和云端接收方仍待确定；未使用真实 ID |
| 2. 服务端 Profile API | 实现身份校验、授权、字段校验、幂等、revision、冲突响应、增量游标、tombstone、审计和删除流程 | 使用合成数据验证跨用户隔离、重复请求、冲突、撤权与删除传播 |
| 3. 加密客户端与本地迁移 | 为缓存/待同步状态实现平台密钥存储和应用层加密；实现显式 opt-in 导入 | 默认不上传；迁移预览列出条目数量/类型而不展示值；用户逐项同意后才写入 |
| 4. Agent 集成 | Profile tool 按任务读取最少确认偏好，更新时写服务端后再确认成功 | 本地与云端 revision 最终一致；无跨用户读取；服务不可用时失败关闭 |
| 5. Agent 发布通道 | CI 签名、兼容性清单、灰度、原子切换、回滚和版本健康上报 | 测试 Gateway 验证签名与回滚；生产配置、凭据和个人数据未进入发布包 |

阶段 1 的 SDK 类型只读核验和合成身份映射原型已完成。原型见 [`agent-memory/src/profile-identity.js`](../agent-memory/src/profile-identity.js) 及 [`agent-memory/examples/profile-identity-prototype.js`](../agent-memory/examples/profile-identity-prototype.js)：它只从 OpenClaw tool-factory context 读取 `channel + account + requesterSenderId`，再交给注入的身份解析器，缺字段、无映射或解析器故障时拒绝访问。已用合成数据运行示例：两个不同发送者映射到不同 `profile_id`、同一个 `home_id`；缺少上下文和未知发送者分别以 `PROFILE_IDENTITY_CONTEXT_REQUIRED`、`PROFILE_PRINCIPAL_UNRESOLVED` 拒绝。

阶段进度按“本地可做”评估：阶段 1 已完成合成身份映射；阶段 2 已完成偏好变更与授权变更 Schema、OpenAPI、内存/SQLite 偏好原型、内存/SQLite 合成授权账本和 `Request → Response` HTTP 适配器，另增加按单一类别、用途授权的任务读取接口；这些都不是生产服务。现增加严格绑定 `127.0.0.1` 的本地 HTTP transport，只用于合成回归，不能对外网卡监听。阶段 3 已完成不含偏好值的只读迁移预览、逐项同意后的变更生成、加密 outbox 与 SQLite 原子批量入队。Windows DPAPI provider 仅适用于 Windows，Linux Secret Service provider 使用 `secret-tool` 且要求当前用户登录会话；两者均未在对应目标操作系统验证。阶段 4 已有本地下行 reducer、AES-GCM SQLite 缓存、宿主注入凭据的 HTTP client、基于 OpenClaw 可信 sender context 的只读 Agent bridge 原型，以及 [`profile-sync-engine.js`](../agent-memory/src/profile-sync-engine.js) 的一次性协调器。该协调器只在宿主显式调用时运行，不启动后台定时任务；先按当前同意逐项推送加密 outbox，再分页拉取变更并在缓存写入前复查授权，只返回状态/计数，不返回偏好值。合成端到端示例现经 loopback HTTP socket 串联 SQLite outbox、授权账本、HTTP client、适配器与加密缓存，并验证 grant/revoke、撤回后读写拒绝、类别授权读取、upsert/tombstone 和 SQLite 偏好及授权状态服务重开后的恢复。真实 Profile API、认证/同意服务、bearer token provider 与 OpenClaw 工具注册/用户授权界面尚未完成；阶段 5 已完成本机发布工件工具与未签名包，并在临时副本上通过临时密钥签名/验签及篡改拒绝检查；正式签名密钥、CI、安装/灰度/回滚尚未配置。

此前工作区曾记录合成回归通过；这些结果对应旧本地基线，不作为本隔离 worktree 的验证证据。本轮以 GitHub main `6aebd5d` 为基线，在 Windows Node.js 24.22.1 上运行仓库全量 `node --test`：649 项中 637 项通过、0 项失败、12 项 Linux/Secret Service 专属用例按平台跳过；其中 `agent-memory` 为 92 项中 82 项通过、10 项按平台跳过，设备管家为 293/293 通过。Task 1/3/4 专项配置、方案和发布集成用例为 51 项中 49 项通过、2 项 Linux 密钥库用例跳过。`deployment/verify-agent-stack.mjs` 已改为直接调用 Node.js 测试、acceptance 和 demo 脚本，不再依赖 `npm.cmd`；本机完整执行结果为 11/11 通过。Task 2 loopback HTTP/SQLite 端到端示例通过，并在重启后恢复偏好 tombstone 和授权状态。Windows 结果不覆盖 Linux 文件权限/链接和真实 Secret Service 行为。静态审查还补上 outbox 加解密与 HTTP 请求/响应读取路径的临时字节缓冲区清零。现有 `.github/workflows/agent-stack.yml` 已增加 Profile 同步合成回归、授权 SQLite 重启测试、按 principal/purpose 隔离密钥的单元用例、SQLite 路径用例与端到端示例；另备有 [`profile-sync-linux-validation-v0.1.md`](./profile-sync-linux-validation-v0.1.md) 和隔离测试密钥命名空间的 Linux smoke 脚本。新测试尚未有 Ubuntu CI 运行记录；Secret Service 适配还需在登录密钥库的 Linux 桌面会话验证，不在无交互 CI 中运行。

本地偏好记录转换器为 [`agent-memory/src/profile-sync-payload.js`](../agent-memory/src/profile-sync-payload.js)：只有显式确认远端同步且状态为 `confirmed` 的记录才生成 upsert；它只挑选允许的偏好字段，不带出本地 `subject_id`、证据和观察数据。删除请求需要显式删除动作。同步语义原型为 [`agent-memory/src/profile-sync-prototype.js`](../agent-memory/src/profile-sync-prototype.js)，示例为 [`agent-memory/examples/profile-sync-prototype.js`](../agent-memory/examples/profile-sync-prototype.js)。它模拟授权主体下的 revision 乐观并发、变更幂等、增量游标、范围隔离和 tombstone；同步流只保留每条偏好的最新状态，删除会移除该条旧值及相关幂等摘要并保留 tombstone，旧游标仍可收到删除事件。另有 [`agent-memory/src/profile-sync-sqlite-prototype.js`](../agent-memory/src/profile-sync-sqlite-prototype.js) 把原型状态存入 SQLite snapshot，用临时合成数据演示跨服务实例重开、幂等重试与删除 tombstone 恢复；[`agent-memory/src/profile-sync-outbox.js`](../agent-memory/src/profile-sync-outbox.js) 为客户端待发送变更提供 AES-GCM 本地加密、principal binding 隔离、同 change ID 退避重试、撤回清除和冲突人工复核原型。统一密钥入口 [`agent-memory/src/profile-sync-key-provider.js`](../agent-memory/src/profile-sync-key-provider.js) 按平台选择 Windows DPAPI 或 Linux Secret Service，按用途为 outbox 和客户端缓存派生独立密钥；真实 Linux Secret Service smoke 仍待已登录桌面密钥库验证；新加的合成命令/provider 测试待 Ubuntu CI 执行。Windows 当前用户 DPAPI key provider 见 [`agent-memory/src/windows-dpapi-outbox-key-provider.js`](../agent-memory/src/windows-dpapi-outbox-key-provider.js)。隔离临时目录 smoke check 在当前自动化执行环境返回 DPAPI `CryptographicException`，错误提示可能与 Windows 用户配置文件未加载或线程 impersonation 有关；临时目录已清理，真实 `%LOCALAPPDATA%` 下未创建密钥文件。以上仍未接真实身份/同意服务或网络，不是生产持久化实现。

服务端 HTTP 边界草案见 [`common-contracts/openapi/profile-api-v0.1.openapi.json`](../common-contracts/openapi/profile-api-v0.1.openapi.json)：定义 `POST /v1/preferences/changes` 和 `GET /v1/preferences/changes`，分别承载幂等写入/乐观并发和显式同步的状态增量/tombstone；另定义 `GET /v1/preferences/current`，要求调用方指定单一偏好类别，服务端按任务用途、类别和 scope 校验当前同意后才返回匹配值。它复用偏好变更 JSON Schema；Bearer JWT 仅是待选身份提供方的占位，真实 issuer/audience、同意与撤权服务及生产游标格式仍未确定。当前 loopback HTTP server 是测试 transport，不是生产服务。

`Request → Response` 适配器见 [`agent-memory/src/profile-sync-http-adapter.js`](../agent-memory/src/profile-sync-http-adapter.js)，可映射到内存或本地 SQLite 原型。它要求可信身份解析和当前同意检查函数由宿主显式注入，拒绝缺少认证/同意的请求，并对偏好响应设置 `Cache-Control: no-store`。本机合成 HTTP listener 见 [`agent-memory/src/profile-sync-local-http-server.js`](../agent-memory/src/profile-sync-local-http-server.js)，固定绑定 `127.0.0.1`，请求体限长且不记录 bearer token；它不替代真实 TLS、身份和授权服务。合成示例为 [`agent-memory/examples/profile-api-http-prototype.js`](../agent-memory/examples/profile-api-http-prototype.js)、[`agent-memory/examples/profile-api-sqlite-prototype.js`](../agent-memory/examples/profile-api-sqlite-prototype.js) 与 [`agent-memory/examples/profile-sync-local-e2e-prototype.js`](../agent-memory/examples/profile-sync-local-e2e-prototype.js)；这些都不构成生产服务或真实登录/授权验证。

面向 OpenClaw 任务读取的桥接原型见 [`agent-memory/src/profile-sync-agent-reader.js`](../agent-memory/src/profile-sync-agent-reader.js)：它只接受 `memory_type` 与结构化范围参数，身份只能来自可信工具上下文解析；默认固定 personal scope，调用类别授权的当前状态接口，并只返回所选类别的值/范围/revision。合成验证示例 [`agent-memory/examples/profile-sync-agent-reader-prototype.js`](../agent-memory/examples/profile-sync-agent-reader-prototype.js) 已通过 sender/profile 隔离、类别同意拒绝和缺少上下文失败关闭检查。它尚未注册进本机 OpenClaw 工具清单，原因是当前没有可注入的真实身份、令牌和 consent provider；不把本地合成桥接误当成可用的跨设备 Agent 功能。

数据库无关的落库模型与事务契约见 [`profile-sync-persistence-contract-v0.1.md`](./profile-sync-persistence-contract-v0.1.md)：定义 owner/scope 隔离、偏好当前状态、幂等结果、revision、增量 feed 和 tombstone 的逻辑键与原子写入顺序。数据库选型、同意/撤权一致性、客户端重试上限和 tombstone 保留/清理政策未定前，不生成具体数据库 migration，也不清理 tombstone。

Agent 发布侧本地现已具备清单生成器、打包器、签名器和只读验收器：[`tools/build-openclaw-agent-manifest.mjs`](../tools/build-openclaw-agent-manifest.mjs) 为 `learning-companion` 和 `energy-saving` 计算模板文件 SHA-256、工作区 revision 与总发布指纹；[`tools/package-openclaw-agent-release.mjs`](../tools/package-openclaw-agent-release.mjs) 只将清单文件复制到新目录，逐项复核哈希，并附带清单 Schema；[`tools/sign-openclaw-agent-release.mjs`](../tools/sign-openclaw-agent-release.mjs) 可从外部受保护的 Ed25519 私钥生成分离签名；[`tools/verify-openclaw-agent-release.mjs`](../tools/verify-openclaw-agent-release.mjs) 可在目标目录核验指纹、revision、文件哈希、排除路径和完整文件集合，并使用独立提供的可信公钥验签。个人文件和本机运行状态按排除规则跳过，`security-watch` 草案不进入清单。打包器拒绝覆盖已有输出目录；由于当前没有正式发布密钥，本地产物未签名，也未传输、安装或部署，不能替代远端发布服务。

本机已生成 [`deployment-package/openclaw-agent-release-2026-11-06/release-manifest.json`](../deployment-package/openclaw-agent-release-2026-11-06/release-manifest.json)，包含 2 个 Agent 的 10 个工作区文件；验收器报告 `verified`，12 个总文件（另含清单与 Schema），无缺失、额外或排除路径。对旧全项目包 [`deployment-package/LT-agent-program-deployment-2026-11-05.zip`](../deployment-package/LT-agent-program-deployment-2026-11-05.zip) 仅核对了 ZIP 目录项、读取完整性和校验和：其中有 6 个路径名为 `USER.md`；未读取这些文件内容，也未修改该包，因此不能据文件名断定其中包含个人信息，但不应未经内容审查就拿它当 Agent 发布包。

## 8. 尚需负责人决定的项

1. Profile API 的托管方、数据区域、运维责任人与账号/家庭身份提供方；
2. 谁可以把哪些偏好授权给哪些云端 Agent，按类别授权还是逐条授权；
3. 家庭偏好和个人偏好的成员可见性、账户删除和保留期限；
4. 平台密钥管理方式、加密缓存的设备丢失/换机恢复策略；
5. Agent 发布包由谁签名，服务端和云端的灰度/回滚责任人；
6. 选购服务的代码仓库/API 契约、认证方式、测试环境和版本发布责任人。

上述事项未确认前，只完成本地模式，不启动任何用户数据同步。
