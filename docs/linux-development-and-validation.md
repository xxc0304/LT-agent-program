# Linux 开发与验证基线

## 目标环境

- 本地开发基线：Ubuntu 24.04 LTS。
- 自动化验证：GitHub Actions `ubuntu-24.04`。
- Node.js：24（SQLite 记忆需要 Gateway 使用 Node.js 22.5+；SQLite 在线备份需要 22.16+）。
- 目标 OpenClaw 版本：`2026.7.1-2`。

“Linux 支持”按层次验收：Node.js 单元测试通过、Mock 验收通过、插件可在目标 Linux Gateway 加载、SQLite 持久化可重启读取。2026-10-29，在 Debian 12 / Node.js 24.22.1 Linux 临时副本中用当前代码运行 `deployment/verify-agent-stack.mjs`：11/11 验证阶段通过，568 项测试通过、0 失败、0 跳过；目标 OpenClaw `2026.7.1-2` SDK 临时安装在副本的 `node_modules`。随后设备管家和平台编排插件分别通过目标版本 CLI 的 `plugins validate`。Linux 安装器的 `--plan-only` 也通过真实目标 CLI 读取临时 profile，并列出 `orchestrate_household_agents`；只读计划确认没有修改 profile。另在 `/tmp` 新建隔离 profile，以 Mock 后端和 loopback 绑定启动 Gateway：健康检查通过（19 ms），日志确认两个项目插件均加载；随后正常关闭。未调用模型，也未连接 HA 或真实设备。

同日还在隔离 Linux Profile 中配置 SQLite 家庭记忆：Gateway 启动时写入一条合成偏好，关闭后重新启动，再从新的 Node.js 进程读回 22℃，证明该临时 Profile 使用的 SQLite 数据可以跨 Gateway 重启保留。SQLite 单元与备份测试 11/11 通过。这不是对正式部署目录、权限归属、备份策略的验收。该验证没有调用模型 API，也没有连接 HA 或真实设备。

当前开发机没有可用的 Ubuntu/WSL 发行版。2026-10-26 已将项目工作区复制到持久 Docker Linux 卷 `lt-agent-program-linux`，由容器 `lt-agent-program-linux-workspace` 挂载在 `/workspace`；这是 Linux 文件系统中的独立工作副本，不是 Windows 目录挂载。它保留 Git 历史、跟踪文件和未提交代码；凭据、缓存、日志及本机 OpenClaw 运行上下文留在 Windows 原目录。Windows 原目录仍保留作回退副本，后续 Linux 开发应进入容器使用 `/workspace`。

GitHub Actions 在提交 `189e66d50e009fb82fddf3e6f9d0ce87f5e1be92` 上曾通过；当时工作流省略 OpenClaw peer，因此没有运行 6 个 SDK 适配器测试，且不覆盖当前未提交改动。当前工作树已更新 Ubuntu 工作流：临时安装目标 SDK、校验两个插件，再执行完整验证；这版工作流需推送后由 GitHub 重新运行。Debian 临时 Gateway 的工具目录已核验，包含项目编排工具；通过 Gateway RPC 实际调用只读 `get_household_preference` 和 Mock `list_devices` 均成功。A2A 下多 Agent 并发派发、依赖结果传递和澄清后停止后续步骤已用 loopback 假模型验证；真实模型对话已验证明确节能请求派发、含糊请求澄清、矛盾指令评估、门锁请求进入高风险确认，以及仅聊天确认时继续阻止门锁步骤；其他复杂场景质量仍需评估。正式部署数据目录的 SQLite 权限/备份验收、Ubuntu 主机或持久 WSL 部署，以及真实 HA/设备验收仍需后续完成。当前已通过安装器权限配置策略测试，未在共享 Gateway 上做权限调用试验。

2026-10-29 又在 Debian 临时 Gateway 上验证了平台编排入口：为临时 Profile 把前门设为 `main` 后，`tools.catalog` 可见 `orchestrate_household_agents`。通过 Gateway RPC 调用时，澄清计划返回 `NEEDS_CLARIFICATION`、未登记 Agent 返回 `UNSUPPORTED`、同一灯具的开/关冲突返回 `NEEDS_CLARIFICATION`；三种预派发分支都没有派发 Agent。对已登记能源管家提交步骤时，临时 Profile 的 A2A 默认关闭，适配器返回 `AGENT_CALL_FORBIDDEN`，在 `runtime.subagent.run` 前拒绝，没有调用模型。这一轮只记录了 A2A 关闭时的拒绝分支。

同日随后在独立 State Dir 中完成成功派发验证：临时 Gateway 仅登记 `main` 和 `energy-saving`，A2A allowlist 仅含这两个 Agent，会话可见性设为 `all`。从 `main` 调用 `orchestrate_household_agents` 提交一条合成“客厅无人”事件后，OpenClaw 通过 A2A 启动能源管家；本地 loopback 假模型成功返回 1 次能源任务的结构化 `PROPOSED` 结果，trace 校验通过，编排结果为 `COMPLETED`。该步骤是建议分析，`device_action_agent_invoked=false`、`device_write_performed=false`。Gateway 和假模型均已停止，临时 Profile 配置已恢复。此前一次试跑因假模型只声明 8K 上下文、小于能源管家注入提示的估算长度而在模型请求前溢出；调至 32K 后验证通过。该结果证明目标 Linux Gateway 的 A2A 调用与结构化回包链路可运行，不代表真实模型的理解质量。

同日又在隔离 Profile 中登记 `main`、`learning-companion` 和 `energy-saving`，A2A allowlist 只列出这三个 Agent，并通过 Gateway RPC 验证三种计划：两个无依赖分析步骤并行派发，学习伴学返回 `COMPLETED`、能源管家返回 `PROPOSED`，总结果为 `COMPLETED`；本地假模型记录到两路请求时间重叠，峰值并发为 2。第二个计划让能源管家依赖学习分析，能源管家的请求中实际收到前一步的 `learning-review-dependent` 结果。第三个计划中，学习伴学返回 `NEEDS_CLARIFICATION`，主工具生成澄清问题并将能源步骤保留为未执行的后续步骤；该 trace 只收到学习伴学的一次模型请求。三种路径均为合成输入，`device_action_agent_invoked=false`，未执行设备写操作；只使用容器内固定回包服务，没有调用 DeepSeek 或其他云模型。临时 Gateway 与假模型已停止，Profile 配置已恢复。

随后用 `openclaw agent --agent main` 从普通中文家庭请求完成一次端到端运行。Main Agent 的模型返回 `orchestrate_household_agents` 工具调用；Gateway 执行一份包含学习伴学和能源管家的计划，两步都返回有效结果，调度状态为 `COMPLETED`，随后 main Agent 生成面向用户的中文答复。假模型共收到 4 次请求：前台工具调用、两个子 Agent、前台总结。该测试证明对话入口、工具路由、A2A 派发和答复回传接通；由于前台规划与回复均由固定脚本生成，不能据此判断真实模型的意图理解质量。没有调用云模型、HA 或设备写工具。测试结束后 Gateway 与假模型已停止，临时 Profile 已恢复。

## 2026-10-31 Ubuntu 持久化与新包最终复验

- Ubuntu 24.04 / Node.js 24.22.2 容器使用独立数据卷，以非特权 `ltagent` 账户写入合成家庭偏好。状态目录权限为 `0700`，SQLite 数据库、在线备份及恢复库权限为 `0600`。新增备份文件权限回归断言；Ubuntu 专项备份测试 6/6 通过；恢复后可读回合成偏好，容器重建后仍可读回，证明专用卷持久化生效。此前遗留的旧测试备份 `0644` 仅作修复前对照，不作为新备份结果。
- 隔离 OpenClaw Profile 使用固定 `2026.7.1-2`，只启用项目 Mock 后端与 SQLite 记忆路径；Gateway 绑定 loopback，不配置云模型、不连接 HA/真实设备。记录插件加载状态、工具清单、SQLite 只读工具查询和 Gateway 关闭状态。
- 修正早先失败的审计尝试：当时没有 lockfile，`npm audit` 返回 `ENOLOCK`，不能作为审计统计。随后在隔离目录生成临时 lockfile 并成功审计 `openclaw@2026.7.1-2`；截至本次 registry 数据为 17 项（1 严重、10 高危、6 中危），新增的 `glob`、`minimatch` 是相较同日早先 15 项结果的差异。项目仍固定 `2026.7.1-2`；没有运行 `npm audit fix`、强制升级或修改目标版本依赖。
- 最终包 `LT-agent-program-deployment-v0.1.33.zip` 含 310 个 ZIP 条目，Linux `unzip -tq` 无错误；Windows 部署检查 123/123 通过；Ubuntu 24.04 / Node.js 24.22.2 上完整验证 11/11 阶段通过，582 项单元测试和 11 项设备管家 Mock 验收通过。固定 OpenClaw CLI 为 `2026.7.1-2`，隔离 Gateway 健康检查通过，设备管家和平台编排插件均加载，插件错误为 0；通过 Gateway `tools.invoke` 写入并读回合成温度偏好，容器重建后仍读回 `22℃`。数据库权限为 `0600`，状态目录为 `0700`。SHA-256 与 Windows 检查结果记录在 `PROJECT_HANDOFF.md`。

再以普通中文含糊请求“帮我把家里弄舒服点”验证前台澄清路径。Main Agent 调用编排工具后返回 `NEEDS_CLARIFICATION` 和温度/灯光等日常问题，`agent_calls_performed=false`；本机假模型只收到前台规划与主对话回复两次请求，未启动子 Agent。该验证证明澄清计划可以从用户对话经过 OpenClaw 工具链返回，固定响应不用于评价真实模型何时能正确识别含糊意图。临时服务已停止，Profile 配置已恢复。

随后验证设备确认闭环：主对话将“客厅没人了，帮我看看灯要不要关”交给能源管家分析，再将结果交给设备管家。设备管家返回 `NEEDS_CONFIRMATION` 和“客厅灯目前还开着，要我帮你关掉吗？”，编排顶层状态为 `NEEDS_CONFIRMATION`，`device_action_agent_invoked=true`；设备管家结果标明 `execution_performed=false`、`device_write_performed=false`。临时 Agent 配置中禁用了设备写工具，没有 HA 凭据；假模型记录到前台、能源管家、设备管家、前台汇总共 4 次本机请求，没有控制工具调用。该轮结束时两次自动权限审核超时；之后已停止两个临时进程、恢复测试前的隔离 Profile 配置，并确认 `19287`、`19288` 端口均已关闭。

临时 CLI RPC 使用仅绑定 loopback 的随机 Gateway token。OpenClaw CLI 在无认证配置下会要求客户端身份；这里使用受支持的 token 认证完成本机连接，不需要真实设备配对。

进入当前 Linux 工作区：

```bash
docker exec -it lt-agent-program-linux-workspace bash
cd /workspace
```

## 开发者命令

```bash
npm --prefix device-manager install --no-save --package-lock=false --omit=peer --legacy-peer-deps --ignore-scripts
npm --prefix device-manager install --no-save --package-lock=false --include=peer --ignore-scripts openclaw@2026.7.1-2
npm --prefix multi-agent-orchestrator install --no-save --package-lock=false --omit=peer --legacy-peer-deps --ignore-scripts
node deployment/verify-agent-stack.mjs
```

第二条只把目标 OpenClaw 包放进 `device-manager/node_modules`，供插件适配器测试及 CLI 检查使用；它不会配置或启动 Gateway。

只运行测试、不运行演示：

```bash
node deployment/verify-agent-stack.mjs --skip-demos
```

CI 和开发者使用同一 Node.js 验证入口，避免维护 PowerShell 与 Bash 两套测试清单；CI 还会用目标 CLI 校验两个插件。Windows 脚本目前保留为兼容工具，不作为 Linux 支持证据。

## 已知缺口

1. 已在 Debian Linux 容器验证当前代码、Linux 原生安装器、两个插件的 CLI 校验，并在临时 Linux Gateway Profile 中确认插件可加载、健康检查通过、工具已注册且只读设备/偏好查询可调用；Ubuntu 24.04 主机或持久 WSL 环境仍未部署验收。
2. 已通过容器内 loopback 假模型验证自然语言对话入口到编排工具、跨 Agent 并发派发、依赖结果传递及澄清后阻止依赖步骤；另以真实 DeepSeek 验证了能源管家派发、含糊请求澄清、矛盾指令评估、门锁高风险确认，以及单纯聊天确认不足时停止设备派发。门锁强身份验证和授权流程尚未接入；其他复杂场景仍需单独评估，详见[本次 DeepSeek/OpenClaw 验证](../experiments/orchestration-comparison-v1/results/direct-deepseek-openclaw-smoke-2026-10-29.md)。
3. 已验证隔离 Linux Profile 的 SQLite 偏好可跨 Gateway 重启读回；正式部署数据目录的所有权、访问权限、备份和恢复策略仍需结合目标部署环境验收。
4. Windows PowerShell 安装器仍保留为兼容入口；Linux 是推荐开发、验证和部署主流程，跨平台安装器行为一致性仍需结合各自目标环境验收。

## 2026-10-30 v0.1.28 候选快照补验（不是正式发布验收）

本机此前生成的 `output/deployment/LT-agent-program-deployment-v0.1.28.zip` 仅作为候选快照；在本轮验收完成前不将其视为正式交付版本，也不生成覆盖它的新包。

- 在 Debian 12 / Node.js 24.22.1 临时目录解压候选 ZIP，并按 CI 步骤安装 OpenClaw `2026.7.1-2` SDK 后运行 `deployment/verify-agent-stack.mjs`：11/11 阶段通过，582 项 Node.js 单元测试、11 项设备管家 Mock 验收通过，SDK 专属测试未跳过。
- 设备管家和平台编排插件均通过 `openclaw plugins validate`。在新的临时 OpenClaw Profile 中以 Mock 后端、loopback 和随机临时 Gateway token 启动目标 Gateway：健康检查 17 ms，设备管家与平台编排插件均加载，插件错误为 0；随后正常停止。
- 候选包安装器 `--plan-only` 在临时 Profile 上识别 `main` 主 Agent 和项目工具，计划文件写入 `/tmp`，未应用配置变更。
- 原候选 ZIP 的内部路径使用反斜杠。Debian Info-ZIP 6.0 能正确展开文件，但会打印路径警告并以退出码 1 结束；解压后的目录通过了上述测试。随后已修正打包器源码，新增 `deployment/Package-Archive.ps1` 并为正斜杠条目增加临时 ZIP 回归测试；相关安装器/打包脚本检查 95 项通过。没有生成新版本 ZIP，所以 `v0.1.28` 候选文件本身尚未包含修正，也尚未复验新归档。
- 对锁定的 OpenClaw `2026.7.1-2` 单独生成临时 lockfile 并运行 `npm audit`：当前 registry 数据匹配 15 个受影响包（4 中危、10 高危、1 严重），均属于 OpenClaw 依赖树，包含 `proxy-addr@2.0.7` 的严重级别公告。没有自动更新依赖或改变 OpenClaw 版本；需要在正式部署前确定兼容的上游修复版本和升级策略。

因此，本地代码、Mock、安装计划、插件静态校验及候选包 Gateway 加载已完成本轮补验；候选包归档路径告警和目标运行时依赖漏洞仍是未关闭项。Ubuntu 24.04 主机/持久 WSL、真实 HA 与设备验收仍未完成。

## 2026-10-30 后续验收复核

- 再次运行 `deployment/Test-DeploymentPackage.ps1 -InstallerChecks -InstallFlow`：95 项通过，包括临时 ZIP 嵌套目录与正斜杠路径、Linux 安装计划、安装流程、SQLite 路径保护和重复安装路径保留。此次仍未生成任何版本交付包。
- 对现有 `v0.1.28` ZIP 做只读内容核对：309 个文件与包内清单完全一致，无重复路径；常见凭据、SQLite 数据和 OpenClaw 本机状态文件名模式均未命中。但 304 个 ZIP 路径仍含反斜杠，且没有新增的 `deployment/Package-Archive.ps1`，所以它仍不包含路径修正。
- 当前 Windows 工作区的 `device-manager/node_modules/openclaw` 和源码 `package-lock.json` 实际解析为 `2026.9.3`，与项目部署目标 `2026.7.1-2` 不同。交付包构建器会排除该源码 lockfile，且此前 Debian 候选包验证使用的是目标版本；因此这不推翻此前 Debian 结果，但 Windows 本地 SDK 检查不能代替 `2026.7.1-2` 验收，后续本地验证必须显式使用目标版本。
- Debian 对新归档格式的实测未能启动：Docker CLI 找不到 Docker Engine named pipe；Docker Desktop 和 Podman 可执行文件均未安装；WSL 发行版查询返回 `E_ACCESSDENIED`。因此尚未用 Debian `unzip` 实际解压新格式临时 ZIP，旧 `v0.1.28` ZIP 的告警也尚未由新归档复验关闭。
- 复核 GitHub 官方公告 [GHSA-jqcg-44mw-7w3h / CVE-2026-90711](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)：`proxy-addr` `>=1.1.0, <2.0.8` 受影响，修复版本为 `2.0.8`。风险在于错误配置短前缀 IPv4 映射 IPv6 信任网段（例如 `::ffff:10.0.0.0/8`）会错误信任所有 IPv4 来源，进而信任伪造的 `X-Forwarded-For`；公告建议使用普通 IPv4 CIDR，或正确覆盖映射前缀的 IPv6 CIDR（例如 `/104`）。本次隔离 Gateway 仅绑定 loopback，测试没有配置反向代理/`trustedProxies`，因此该特定配置条件不在本次测试中；但锁定 OpenClaw `2026.7.1-2` 的依赖仍含受影响版本，不能据此宣布依赖审计通过。发布前仍需确定兼容修复策略，或由部署方明确接受该依赖风险并限制代理网段配置。

截至 2026-10-30，验收仍未完成：打包器源代码、临时 ZIP 的 Debian 解压和 Windows 安装器检查已通过；旧 `v0.1.28` 完整包仍未通过 Linux 解压检查，固定 OpenClaw 运行时依赖风险也尚待决定。

## 2026-10-31 验收继续

- 更正本机 Docker 环境诊断：Docker Desktop 安装在用户目录，不在系统级默认目录。启动后 Engine 可用；查询到既有 `lt-agent-program-linux-workspace` 容器处于 `Up` 状态。没有对该容器运行命令、复制文件或触碰 `/workspace`。提升权限查询 WSL 发行版只列出 `docker-desktop`，没有单独注册的 Debian 发行版。
- 使用本仓库 `deployment/Package-Archive.ps1` 生成一个嵌套路径临时 ZIP，在无网络的一次性 `node:24` 容器中确认系统为 Debian 12、Node.js `v24.22.1`。ZIP 通过 `unzip -t`（退出码 0），并成功解压、读取嵌套文件。宿主目录只读挂载；临时容器自动移除，宿主临时文件已清理。这关闭了**ZIP 条目路径格式**在 Debian 上的打包器级验收，但没有生成或复验完整版本包。
- 在隔离 Debian 12 容器中按公开 registry 当前数据重新解析精确版本 `openclaw@2026.7.1-2` 并运行 `npm audit`：仍为 15 项（1 严重、10 高危、4 中危），涉及 `proxy-addr`、OpenClaw 本体、MCP SDK、`@openclaw/fs-safe`、`body-parser`、`brace-expansion`、`fast-uri`、`hono`、`ip-address`、`protobufjs`、`qs`、`tar`、`undici`、`zod` 和 `@hono/node-server`。不带 `--force` 的临时 `npm audit fix --package-lock-only` 失败，审计数量不变；npm 提示 `--force` 会把 OpenClaw 升到 `2026.10.9`。没有运行 `--force`，也没有改变项目或目标版本。`proxy-addr@2.0.7` 的修复版为 `2.0.8`；短前缀 IPv4 映射 IPv6 的 `trustedProxies` 配置仍是该公告的特定触发条件。
- 为评估 npm 提示的版本升级，在另一个隔离容器中只审计 `openclaw@2026.10.9`：结果为 6 项（0 严重、4 高危、2 中危）。所以升级至该版本会降低当前告警数，但单靠这次版本升级仍不能得到零漏洞审计结果；没有把该版本安装到项目或 Gateway。
- 继续验收时对 `v0.1.28` 的 309 个文件与当前打包规则做了只读逐项比对：设备/能源/记忆/编排运行时代码和对应单元测试内容一致；差异是打包后加入的 ZIP 路径回归检查、验收记录更新、README 中构建时的命令路径替换及两个插件包的目标版本固定。旧包仅缺少新增的 `deployment/Package-Archive.ps1`，并且其 ZIP 条目仍使用反斜杠。当前工作区重新运行 `Test-DeploymentPackage.ps1 -InstallerChecks -InstallFlow`，95/95 通过。该结果确认既有 582 项 Debian 测试覆盖当前运行时代码，但不改变旧 ZIP 未通过 Linux 归档验收的结论。
- 只读检查当前 Linux/PowerShell 安装器和部署说明，没有发现项目安装器设置 Gateway 的 `trustedProxies`、bind 或代理参数；这避免由本项目写入 GHSA 所述的短前缀 IPv4 映射 IPv6 信任网段，但不会检查或覆盖目标 OpenClaw Profile 中已有的代理配置，也不修复受影响依赖。部署方若自行启用反向代理，仍需按上游公告核对信任网段。

- 用户于 2026-10-31 明确接受固定 OpenClaw `2026.7.1-2` 的依赖审计告警作为本次交付验收的已知风险。风险接受不代表漏洞已修复或审计归零；项目继续固定该版本，不运行 `npm audit fix --force`，且安装器不修改目标 OpenClaw 的依赖树。
- 随后生成完整候选包 `output/deployment/LT-agent-program-deployment-v0.1.29.zip`（310 个文件）。Windows 部署包检查 123/123 通过。Debian 12 / Node.js 24.22.1 上 `unzip -tq` 通过，按 CI 方式安装 `openclaw@2026.7.1-2` 后两个插件均通过 `plugins validate`，Linux 验证流程 11/11 阶段通过；共 582 项单元测试和 11 项设备管家 Mock 验收通过。npm 仍报告 15 项依赖告警，按上述决定接受为已知风险。测试未连接真实 HA 或家电。

当前结论：固定 OpenClaw 2026.7.1-2 的本地部署包验收已在 Windows 与 Debian 12 上完成。依赖告警按用户决定接受为已知风险，并非修复或审计归零；候选包的具体版本与校验信息见项目交接记录。旧 v0.1.28 因 ZIP 路径问题作废。
