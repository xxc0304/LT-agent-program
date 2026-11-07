# OpenClaw 自更新与项目 Agent 发布兼容性分析（v0.1）

核对日期：2026-11-07

项目基线：`LT-agent-program` GitHub `main`，提交 `6aebd5d`（GitHub 最新提交仍为此提交）

项目记录/发布清单目标版本：OpenClaw `2026.7.1-2`

## 结论

**两套更新机制在文件所有权分开的前提下没有直接冲突。** OpenClaw 更新其 CLI/Gateway 程序、服务和所管理的官方插件；项目 Agent 发布包更新经过审查的 Agent workspace 模板。当前设计的发布工具只验签、比较或写入独立暂存目录，`apply_permitted` 为 `false`，没有改写活动 Agent workspace，也不重启 Gateway。

真正需要控制的是**版本兼容和更新同时发生**：OpenClaw 更新可能运行 Doctor、同步插件并重启 Gateway；未来若 Agent 包开始写入活动 workspace，两者并发会带来加载新旧文件混杂或任务中断风险。因此应串行发布、分别回滚，并让 Agent 包对 OpenClaw 版本做兼容门禁。

## 两套更新器的所有权

| 项目 | OpenClaw 自更新 | LT Agent 发布通道 |
|---|---|---|
| 更新对象 | OpenClaw CLI/Gateway 程序、受管服务、官方插件及其所需迁移/修复 | Agent workspace 中经审查的模板文件 |
| 典型入口 | `openclaw update`、Gateway 控制面更新；具体取决于安装方式和服务管理器 | 受信签名包、manifest、版本兼容检查及独立暂存 |
| 数据边界 | OpenClaw 自己的程序、状态迁移和插件收敛流程 | 不应包含 `openclaw.json`、认证资料、用户记忆/会话、数据库、Token 或密钥 |
| Gateway 重启 | 受管服务更新通常会交接并重启/验证 Gateway；终端前台进程的行为与服务更新不同 | 暂存不重启；将来激活若需要重启，必须显式安排并单独验证 |
| 回滚责任 | OpenClaw updater/安装包管理器/容器或系统包管理器 | Agent 发布器只回退 Agent 版本，不恢复 OpenClaw 数据库或程序包 |

原始工作区 2026-11-06 的发布 manifest 把 `learning-companion` 和 `energy-saving` 各 5 个模板文件纳入包，排除 `security-watch`、个人数据和运行状态，并将 `required_openclaw_version` 固定为 `2026.7.1-2`。其暂存工具要求受信签名和精确版本匹配，只写入新指纹目录，不激活活动 workspace。

**工作树差异：** 本文当前隔离工作树基于 GitHub `6aebd5d`，其中没有原始工作区的 `tools/openclaw-agent-*.mjs` 发布工具；它们仍在原始 Windows 工作区。所以上述“仅暂存、不激活”的代码行为是对原始工作区源码的核对，不代表这些工具已进入当前 Git 分支或 CI。

**当前工作树另有 Agent 栈安装器：** `deployment/install-agent-stack.mjs` 与 `deployment/Install-Agent-Stack.ps1` 都在安装前读取 `openclaw --version`，只接受精确版本 `2026.7.1-2`，并明确拒绝自行升级 OpenClaw 或切换 profile。它们通过 `openclaw plugins install --link <repo-path>` 注册 `device-manager` 与 `platform-orchestrator`，OpenClaw 加载项目仓库的源目录，不将项目代码复制到 OpenClaw 的 managed plugin 安装树。OpenClaw v2026.7.1-2 的 `plugins update` 文档限定为 managed plugin index 中的 tracked installs；由此可确认项目这两个 link 源代码不由 OpenClaw 插件更新器覆盖。Agent workspace 模板仍由项目发布流程管理。安装器随后配置插件并询问是否安全重启 Gateway；它不会调用 `openclaw update`。两套安装器还增加了 `update.auto.enabled` 预检：计划会显示检测结果；若检测为开启，apply 会在确认、装包、改 profile、重启之前拒绝继续，并提示运维人员自行关闭自动应用、另择维护窗口。未设置该项时，仅在 OpenClaw 明确报告配置路径不存在后按官方默认关闭处理；其他读取失败/非布尔值会失败关闭。安装器不替用户修改该设置。此举阻断自动更新已开启时的 Agent 安装，但不检测人工并发执行的 `openclaw update`。

当前安装器与 OpenClaw 自更新器之间**没有共同维护锁或人工并发检测**。如果运维人员手动执行 `openclaw update`，仍须将核心更新和 Agent 安装安排在不同维护窗口。目标版本官方文档说自动更新默认关闭，但不能据此推定用户主机当前配置；本地新增预检用于读取实际配置并在开启时阻止安装，不会修改用户设置。[OpenClaw v2026.7.1-2 updating](https://github.com/openclaw/openclaw/blob/v2026.7.1-2/docs/install/updating.md)

本次验证：`node --test deployment/install-agent-stack.test.mjs` 为 **15/15 通过**，包括默认未设置显示 default-off、读取状态失败时拒绝计划、自动更新开启时在用户确认/备份/安装/配置修改前阻断，以及两个项目插件使用 `--link` 并指向预期仓库路径；PowerShell 脚本解析通过，Node 两个文件语法检查通过，`git diff --check` 通过。测试使用模拟 OpenClaw CLI 和临时 profile，没有访问真实 Gateway。`.github/workflows/agent-stack.yml` 现已增加 Ubuntu 24.04 / Node.js 24 步骤运行这组测试，但代码尚未推送，故该 Linux job 仍未实际执行；PowerShell 仍只做语法检查，当前设备的 Gateway 配置也未读取。

**GitHub 状态复核（2026-11-07）：** `main` 仍为 `6aebd5d`，最近一次成功的 Linux Agent stack workflow 是运行 #21，基于该旧提交；GitHub 上的 [workflow 文件](https://github.com/xxc0304/LT-agent-program/blob/main/.github/workflows/agent-stack.yml)尚无本地新增的安装器更新协调测试步骤。因此该成功记录不能证明本工作树的修改通过 Ubuntu 验证。当前工作树还包含 Task 2 的未提交改动，不能为触发 CI 而直接推送或合并；需先在受控分支审阅并纳入这些改动，再由 Ubuntu 24.04 / Node.js 24 workflow 验证。最近一次成功运行记录：[run #21](https://github.com/xxc0304/LT-agent-program/actions/runs/41656731003)。

## OpenClaw 更新行为与版本边界

仓库当前锁定/记录的目标是 `2026.7.1-2`。该版本对应的官方更新文档说明：自动更新默认关闭；若开启，stable 有默认 6 小时延迟和最多 12 小时的确定性抖动，beta 每小时检查并立即应用，dev 不自动应用；`OPENCLAW_NO_AUTO_UPDATE=1` 可阻止自动应用。普通 `openclaw update` 会执行更新维护并重启 Gateway；对受管服务有安全交接路径，`--no-restart` 会让运行中的 Gateway 暂时继续使用旧代码。

**本仓库的版本门槛需按部署组合解读：** `device-manager` 单独声明 `peerDependencies`/`minGatewayVersion >=2026.5.17`，但其构建 SDK 目标为 `2026.7.1-2`；`multi-agent-orchestrator` 声明 API 和 Gateway 最低版本 `>=2026.7.1-2`。所以两者组合部署时，有效最低 Gateway 版本是较严格的 `2026.7.1-2`；这不是更新器冲突。Linux workflow 也显式安装 `openclaw@2026.7.1-2` 并用它验证两个插件。该 workflow 在当前隔离工作树中尚未推送/运行，因此只是配置门槛，不构成 Ubuntu CI 已通过的证据。若未来只部署 `device-manager`，仍可按其单包最低声明评估，但必须在对应 Gateway 版本实际校验插件构建目标兼容性。

截至本次核对，OpenClaw 官方在线文档已描述更新后的 Gateway 自动更新调度、受管服务交接，以及独立的 headless node runtime 自动更新。它们不应倒推为 `2026.7.1-2` 的行为：项目目标机必须以实际安装版本、安装类型和服务管理方式为准。特别是：

- npm/git 受管 Gateway：由 `openclaw update` 管核心代码、Doctor/迁移、官方插件收敛和服务重启。不要由 Agent 包替换 OpenClaw 安装目录或官方插件目录。
- 前台终端 Gateway：不要假设它能安全自动替换自己正在运行的程序；按该版本的更新提示停机、更新、再启动。
- Docker/Podman/Kubernetes 或系统包/Nix：由镜像、包管理器或部署编排器拥有更新权；不要再让 Agent 发布器替换容器内 OpenClaw 程序。
- headless Node 更新（适用的新版本）：它是 Node runtime 的独立更新责任，不等于 Gateway/CLI 更新，也不应被项目 Agent bundle 管理。

## 冲突矩阵

| 同时发生的事情 | 当前是否冲突 | 控制措施 |
|---|---|---|
| OpenClaw 更新与 Agent 包仅做签名验证/暂存 | 否 | 暂存写入独立指纹目录；不接触活动 workspace |
| OpenClaw 更新与未来 Agent workspace 激活并发 | 有风险 | 通过主机级维护锁串行化；OpenClaw 更新期间禁止激活 Agent 包 |
| OpenClaw 官方插件同步与 Agent workspace 文件更新 | 目前无直接文件冲突 | 两套清单不得包含对方拥有的插件/程序文件；Agent 不得注册成 OpenClaw 官方插件更新的替代物 |
| Agent 包要求版本与 Gateway 当前版本不匹配 | 必须阻断 | 保持 manifest 的精确版本门禁；在目标版本完成兼容验证并重新签名后才发布 |
| OpenClaw 更新迁移状态、Agent 包随后失败 | 不可共用一个回滚 | OpenClaw 恢复走 OpenClaw 的备份/更新记录；Agent 回退只切回上一 Agent 版本，不回滚数据库 |

## 建议的联合更新顺序

在安装了目标 Gateway CLI、且项目仓库处于可用工作树时，先运行以下只读检查：

```text
openclaw --version
openclaw config get update.auto.enabled --json
openclaw update status --json
openclaw plugins list --verbose --json
openclaw plugins inspect device-manager --runtime --json
openclaw plugins inspect platform-orchestrator --runtime --json
node deployment/install-agent-stack.mjs --plan-only
```

`config get` 若明确报告该项不存在，代表使用默认关闭；其他错误都需要先解决读取问题。若目标版本有待更新，先运行 `openclaw update --dry-run` 审阅计划；正式 OpenClaw 更新要独立安排在一次维护窗口。OpenClaw 更新后依次复核 `openclaw --version`、`openclaw health`、`openclaw doctor --lint --json` 和两个插件的 runtime inspect，再运行项目安装器 plan-only。项目安装器版本门禁要求 `2026.7.1-2`；版本不同必须先完成项目插件兼容验证并更新版本门槛，不能跳过门禁。

1. 记录目标机的安装类型（npm/git/容器/系统包）和 Gateway 服务管理器；按上面的只读命令确认当前版本、自动更新配置、可用更新和插件源路径。
2. 若要升级 OpenClaw，先单独升级；按 OpenClaw 自身的 Doctor、插件收敛和服务恢复流程完成，并确认版本、Gateway readiness 与插件 runtime。
3. 再检查 Agent bundle 签名、清单哈希、排除路径和 `required_openclaw_version`；只在隔离目标 workspace 做差异预览。
4. Agent 安装/发布与 OpenClaw 核心更新分开进行。未来若启用活动 workspace 激活，须先有 Agent 发布锁并按清单原子切换；该锁无法约束 OpenClaw updater，因此仍要串行安排维护窗口。
5. Agent 健康检查失败时，只回切 Agent 版本；Gateway/核心更新失败时，只走 OpenClaw 自带恢复。不要同时回滚两套状态。

如果用户手动计划同一维护窗口做两种升级，应临时关闭该 Gateway 的自动更新应用，先做 OpenClaw 升级和验证，再做 Agent 包应用。当前版本文档给出的 `OPENCLAW_NO_AUTO_UPDATE=1` 是自动应用保护开关；自动更新是否开启还应先检查该主机配置。不要为单次 Agent 发布修改或覆盖用户现有配置。

## 尚未实现/验证的部分

- 当前 Agent 发布工具没有活动 workspace 激活、主机级维护锁或自动回滚；它们只做计划与暂存。
- 发布工具当前不在本隔离工作树，也不在本分支 CI；需先把原始工作区中经过审查的工具带入受管分支，才能把此设计变成可重复的代码验证。
- 两套 Agent 安装器的自动更新门禁只读取状态并拒绝重叠安装，不会锁住 OpenClaw updater；手动触发核心更新仍需由运维排在不同维护窗口。
- 当前执行环境的 PATH 中没有 `openclaw` 命令，因此未在目标 Gateway 上读取实际 `update.auto.enabled` 配置，也未实测 OpenClaw 自动更新与 Agent 发布先后顺序。
- 未验证容器编排器、系统包或 Nix 环境的发布集成；这些安装方式的更新 owner 不同。

## 参考

- OpenClaw `v2026.7.1-2` [Updating](https://github.com/openclaw/openclaw/blob/v2026.7.1-2/docs/install/updating.md) 与 [`openclaw update` CLI](https://github.com/openclaw/openclaw/blob/v2026.7.1-2/docs/cli/update.md)
- OpenClaw `v2026.7.1-2` [Plugin install/update CLI](https://github.com/openclaw/openclaw/blob/v2026.7.1-2/docs/cli/plugins.md)：`--link` 指向本地源目录；`plugins update` 针对 managed plugin index 中的 tracked installs
- OpenClaw `v2026.7.1-2` [`config get` CLI implementation](https://github.com/openclaw/openclaw/blob/v2026.7.1-2/src/cli/config-cli.ts)；用于区分配置路径不存在与 CLI/读取故障
- 当前 OpenClaw [Automatic updates](https://docs.openclaw.ai/install/updating/automatic-updates) 与 [Other update methods](https://docs.openclaw.ai/install/updating/update-methods)；只用于说明新版本策略，不能代替目标机版本核对
- LT Agent 当前 GitHub 基线 [`6aebd5d`](https://github.com/xxc0304/LT-agent-program/commit/6aebd5d52b6d5cbd1972ab4acad0a938d15b0150)
