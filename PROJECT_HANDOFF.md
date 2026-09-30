# LT-agent-program 项目交接摘要

> 给换设备后的 Codex/协作者：先阅读本文件和根目录 `AGENTS.md`，再开始工作。不要重新研究已经完成的内容，也不要要求用户重复粘贴 API Key。当前工作区的密钥和本地数据均不在 Git 中。

更新时间：2026-09-30

## 1. 项目目标

本项目是“家庭微脑”多 Agent 实验。当前已经完成设备管家 Agent 的第一阶段，正在开发学习行为分析 Agent。最终形态是由 OpenClaw 编排多个 Agent：学习行为 Agent 识别孩子的学习状态，设备管家 Agent 负责调用 Home Assistant 设备；两者通过结构化事件连接，不要让视觉识别 Agent 直接控制设备。

## 2. 已完成内容

### 设备管家 Agent

目录：`device-manager/`

- Mock Home Assistant 设备状态与控制；
- `list_devices`、`get_state`、`control_device`、`run_scene`、`diagnose_device`、`get_device_events`；
- 控制前检查、开锁确认、结果验证和审计日志；
- OpenClaw 插件适配文件 `src/openclaw-plugin.js`；
- 独立 Agent 工作区和启动脚本；
- `npm run plugin:validate` 已通过，当前插件清单包括设备、调度、家庭记忆和场景规划/确认执行工具；
- 当前版本的设备管家测试已通过 82/82，包含温湿度、二值传感器、事件审计、真实 HA 故障回读、调度桥接、Task 契约字段校验、优先级保真、个性化场景确认执行、OpenClaw 记忆工具作息日期适配和视觉离位独立占用佐证测试；
- 新增 `src/acceptance.js` 和 `npm run acceptance`，一键验收设备发现、传感器读取、控制后状态验证、个性化场景确认执行、开锁拦截、诊断、事件审计和错误返回；当前 10/10 通过；
- Mock 设备扩展为 10 个：灯、空调、窗帘、门锁、温度、湿度、人体感应、门磁、烟雾传感器和智能插座；
- 新增只读 Skill：`agent-workspace/skills/device-status/SKILL.md`；
- 新增真实 Home Assistant REST API 适配层，可通过 `DEVICE_MANAGER_BACKEND=home-assistant` 切换；
- 真实适配层支持实体白名单、Bearer Token、六类实体状态归一化、service 控制映射、控制后回读、场景预检、开锁确认和审计；
- 新增 `npm run ha:check` 只读连通性检查；认证信息只从环境变量读取，不写入仓库；
- 新增 `common-contracts/` 公共契约 v0.1 草案，包含 Device、Event、Task、TaskReceipt、ResourceStatus 和 PolicyDecision Schema、示例与校验脚本；
- 新增设备管家标准任务运行时 `device-manager/src/task-runtime.js`，可用 Mock 任务模拟其他 Agent，返回 `SUCCEEDED`、`FAILED` 或 `CHALLENGE` 回执；
- 新增动作后状态验证和内存事件账本：控制结果必须回读达到目标，否则返回 `POST_ACTION_VERIFICATION_FAILED`；动作成功、动作失败、诊断告警分别记录标准事件，并通过 `get_device_events` 查询；
- 已加入真实 HA 的超时、认证失败、服务成功但状态未改变等故障测试；
- 新增 `plan_scene` 只读预览和 `execute_scene_plan` 一次性确认执行闭环：口令有效 10 分钟、执行前重读偏好与设备条件、计划变化时拒绝执行、个性化温度再次预检、执行后逐项回读；计划 ID 写入动作审计的 `task_id` / `trace_id`；
- OpenClaw 对话层拒绝模型直接调用旧 `run_scene`，用户场景需先展示预览，再等待后续消息中的原样口令；确认口令仍是 Agent 流程中的防误触措施，不等同 OpenClaw 原生人工审批；
- `device-manager/ACCEPTANCE_REPORT.md` 记录本地验收边界；在 `device-manager` 目录执行 `npm run verify` 可一键跑完 82 项测试、10 项 Mock 验收、插件校验和公共契约样例校验；
- 已按小组要求将本机全局 OpenClaw 对齐到 `2026.7.1-2`；该版本使用独立配置目录 `%USERPROFILE%\\.openclaw-2026.7.1-2`，旧版 Gateway 已成功加载 device-manager（9 个插件）；
- 2026-09-30 已只读核验本机 profile 的 `agents.list[1].tools.alsoAllow`，保留原有工具并补入 `preview_household_routine`；随后 `openclaw plugins inspect device-manager --runtime` 显示插件 `loaded`，记忆工具均出现在运行时工具清单。另通过 OpenClaw SDK 注册后的实际工具回调，在隔离临时记忆路径完成保存、作息观察、候选确认、预览和删除闭环测试；未读取真实家庭记忆，也未调用模型。Gateway 中真实用户对话验证尚未进行；
- 本机 Gateway 计划任务原先指向旧 `~/.openclaw/gateway.vbs` 并退出码 78。旧脚本已备份为 `gateway.vbs.pre-profile-fix-20260930.bak`，计划任务已用当前 profile 重建，启动命令与 `state/gateway.cmd` 绑定；状态检查显示 Gateway 正在运行、端口 `127.0.0.1:18789` 探测通过。启动过程中有内置 iMessage/Telegram 插件路径警告，以及 `gateway.controlUi.allowInsecureAuth=true` 安全警告；未擅自修改。启动时 5 秒模型 warmup 超时，是否产生 API 用量未核实；
- 目前仍是 Mock HA，不连接真实家具。

本机 OpenClaw 进展（2026-09-30）：`2026.7.1-2` profile 中有 `learning-companion`、`energy-saving` 和 `device-manager`；记忆工具白名单已核验并补齐作息预览工具。`device-manager` 运行时插件检查成功，但用户数据上的实际偏好查询/写入未执行。插件和 Agent 注册只保存在本机 OpenClaw 配置，不会随 Git 仓库迁移。注册成功不等于 Agent 间已有远程独立通信：仓库里的编排器仍是进程内实现。

### 学习行为分析实验

目录：`learning-behavior/`

- 已建立图片视觉识别脚本和 SCB 评估脚本；
- 视觉模型当前使用：`deepseek-v4-flash-vision-exp`；
- 请求采用 OpenAI 兼容的图片 `data URL`，模型输出被解析为 JSON；
- 支持的第一版行为标签：`reading`、`writing`、`listening`、`raising_hand`、`turning_around`、`standing`、`discussing`；
- 已成功完成单张 SCB 图片识别，模型返回行为、置信度和中文证据；
- 当前学习行为模块测试通过 20/20。
- 场景标注审计区分人工复核置信度和 AI 初标置信度，允许审计未完成模板；已新增多标注者逐对一致率审计模式（活动集合、姿态、朝向）。25 条 AI 初标的结构审计见 `learning-behavior/ANNOTATION_FIRST_PASS_AUDIT_2026-09-30.md`；第二位人工标注者的独立复核仍未完成，不能计算人工标注一致率或将 AI 初标称为真值。

### 节能 Agent MVP

目录：`energy-saving/`

- 已建立独立的规则型 `energy-saving` 功能 Agent；
- 支持 `occupancy_changed`、`home_mode_changed`、`learning_behavior` 和 `user_device_override` 事件；
- 根据可信无人时长、离家模式，或“稳定多帧视觉离位 + 可信同区域 HA 无人事件”组合，生成 canonical `device_action` 任务；
- 只规划任务，不直接调用 Home Assistant，所有设备动作仍由 `device-manager` 执行并回读验证；
- 对门锁、传感器和安全设备做保护，不接受低置信度或需要人工复核的学习行为结果；
- 已加入幂等键、事件去重、用户手动保持期、设备冷却时间和 `trace_id`；
- 已提供 Mock 端到端演示：客厅无人 10 分钟 → 节能 Agent → 设备管家 → 状态回读；
- `energy-saving` 测试通过 23/23，设备管家全套测试通过 82/82；
- 已通过 `multi-agent-orchestrator` 接入调度器，当前仍是规则型 Mock MVP，真实传感器事件待其他组提供。

### 多 Agent 调度器 MVP

目录：`multi-agent-orchestrator/`

- 已建立最小任务调度器，可注册 Agent、按事件类型路由、按优先级和截止时间排序任务；
- 支持幂等键去重、`RETRYABLE`/`TIMEOUT` 重试、目标 Agent 不可用回执和统一 `trace_id`；
- Task 的 `source`/`target` 兼容转换已抽到 `common-contracts/task-compat.mjs`，调度器与设备管家共用；公共模块测试 5/5，通过一致性检查后只向下游传 canonical 字段；
- 设备管家 canonical Task 入口校验 Schema 必需字段与关键枚举；适配器保留 `resource_requirement` 与 `compute_requirement` 的语义区分，并按显式 `privacy_level` 与本地 `data_level` 派生类中更严格者生成旧策略字段；动作回执保留 `task_priority`，避免 `P3/P4` 降级为 `low` 后失去原值；
- 已加入学习伴学结果到 `learning_behavior` Event 的适配器；
- 已跑通“学习伴学 → 节能 → 设备管家 → Mock HA”的端到端链路；学习离位信号必须先在当前进程收到同区域、60 秒内的可信 HA 无人事件，佐证不从模型事件 payload 读取，Agent 重启会清空；任务审计记录佐证事件 ID；
- 调度器测试通过 28/28；排队前按 canonical Task 草案校验版本、优先级、数据/隐私级别、设备 ID、资源执行模式和时限，非法任务不会进入队列；本次 `npm run demo` 显示模拟的 HA 事件先到达、随后学习事件经节能规划、设备管家执行和 Mock HA 状态回读的完整 trace；
- `LearningCompanionAgent.analyzeImage()` 已可直接接入 `learning-behavior/src/vision.js` 的视觉客户端；图片不会进入跨 Agent Event，低置信度结果会标记人工复核；
- 学习行为结果新增独立的 `presence` 字段（`at_desk`、`away_from_desk`、`unknown`）；学习事件单独不触发关灯，须有先前实际路由的同区可信占用事件。OpenClaw 插件默认不配置可信占用来源，真实 HA 来源认证与白名单配置待接入组提供接口后完成；
- `multi-agent-orchestrator` 提供 `npm run run:image -- <图片路径> [区域] [持续时间毫秒]` 入口，可在临时设置 API Key 后用真实视觉模型跑一张图片；设备执行仍固定使用 Mock HA。
- `device-manager/src/orchestrator-bridge.js` 已把调度器接入 OpenClaw 插件，新增 `dispatch_agent_event`，可以在 OpenClaw 内跑“事件 → 节能 → 设备管家 → 状态回读”链路；
- `openclaw-agents/` 提供学习伴学和节能两个可迁移工作区模板；本机 `2026.7.1-2` profile 已注册二者，但其他电脑仍需单独注册；
- 当前调度器仍是进程内存实现，后续再替换为真实消息队列、ResourceStatus 和跨组 Agent 接口。

### SCB 数据

- 已从 SCB-Dataset 官方 Hugging Face 页面下载两个小规模子集；
- 当前本地共有 375 张图片：147 张 reading 子集图片、228 张 writing 子集图片；
- 清单：`learning-behavior/data/scb/manifest.jsonl`；
- 原始压缩包、图片和评估结果已加入 `.gitignore`，不会上传 GitHub；
- 当前批量试跑为 6 张，脚本显示准确率 50%。这个数字不能作为正式准确率：压缩包文件夹名称是子集/场景名，不保证每张图片的实际动作都一致。例如 reading 子集中有书写画面，writing 子集中有听讲画面。正式评估必须人工校正标签或使用逐帧行为标注。

### 人工复核评估集与最新结果

- 人工复核清单：`learning-behavior/data/scb/manifest-verified.jsonl`；
- 共25张，`reading`、`writing`、`listening`、`standing`、`discussing`各5张；
- 运行脚本：`learning-behavior/Run-VerifiedEvaluation.ps1`；
- 最新结果文件只保存在本机的 `data/scb/results/verified-v4-flash-vision-exp.json`，不会提交；
- 模型：`deepseek-v4-flash-vision-exp`；25/25成功解析，整体 accuracy 为48%；平均延迟约10.0秒，单次约2.0～65.1秒；
- 分类别 F1：reading 71.43%、listening 83.33%、writing 18.18%、standing 25.00%；discussing 当前没有正确命中；
- 主要混淆：书写被判为阅读，站立/讨论被判为书写或听讲；平均置信度约0.90但整体准确率只有48%，说明模型存在过度自信；
- 结论：接口和图片识别链路已经验证，但不能直接把当前模型用于自动设备控制。下一步应改进行为定义（区分“个人动作”和“课堂场景”），并采用多帧投票/低置信度人工复核。

## 3. 关键文件

### Home Assistant 开发环境（最新进展）

安装和验证记录见 `HOME_ASSISTANT_DEV_PROGRESS.md`。当前已完成 Docker Desktop/WSL 2、Home Assistant Core `2026.8.3`、Frontend `20260729.7` 和 VS Code Dev Containers 的开发环境配置；本机 `127.0.0.1:8123` 已能进入首次设置页面。凭据、运行日志和本地依赖均未上传。

- `learning-behavior/README.md`：学习行为实验说明；
- `learning-behavior/src/vision.js`：视觉请求、提示词、JSON 解析；
- `learning-behavior/src/evaluate-scb.js`：单图测试、批量评估、准确率和混淆矩阵；
- `learning-behavior/src/build-manifest.js`：从按类别分目录的数据自动生成 JSONL 清单；
- `learning-behavior/test/vision.test.js`：本地单元测试；
- `device-manager/README.md`：设备管家使用说明。
- `device-manager/src/agent-event-demo.js`：OpenClaw 调度桥接的本地 Mock 演示入口。
- `openclaw-agents/README.md`：两个业务 Agent 工作区模板和注册命令。
- 根目录 `Verify-Agent-Stack.ps1`：一键运行公共契约校验、五个模块测试、设备管家 Mock 验收和两条 Mock 演示；不调用模型 API 或真实 HA。运行命令：`powershell -NoProfile -ExecutionPolicy Bypass -File .\Verify-Agent-Stack.ps1`。

### 背景资料的高层结论（原始资料不随仓库同步）

项目讨论中曾参考过伴学台灯方案、产品调研和专利方向等资料。为保护项目内部信息，原始 Word、截图、专利题目和聊天/分工材料均不放入 GitHub；这里只保留对开发有用的高层结论：

- 伴学台灯需要提供灯光、在位、摄像头/抓拍、在线状态和故障等可观测数据，优先考虑 MQTT、RTSP 和局域网边缘处理。
- 学习行为 Agent 负责识别行为并输出结构化事件，不直接控制设备；设备控制由设备管家 Agent 执行。
- 事件至少应包含行为标签、时间戳、置信度、数据来源和是否需要人工复核，便于 OpenClaw 编排多个 Agent。
- 后续架构重点是服务发现、动态编排、异步通信、跨协议适配、云边端协同和隐私保护。

## 4. 换设备后的最短启动路径

```powershell
git clone https://github.com/xxc0304/LT-agent-program.git
cd LT-agent-program\learning-behavior
npm test
```

SCB 原始图片和结果不在 GitHub，需要在新设备重新下载或从本地安全位置复制。不要把 API Key 写进文件或发到聊天中，在当前 PowerShell 临时设置：

```powershell
$key = Read-Host "请输入 DeepSeek API Key"
$env:DEEPSEEK_API_KEY = $key
Remove-Variable key
$env:DEEPSEEK_MODEL = "deepseek-v4-flash-vision-exp"
$env:DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions"
```

单图验证：

```powershell
node src/evaluate-scb.js --image "data\scb\images\reading\朗读\0001052.jpg"
```

小样本验证：

```powershell
node src/evaluate-scb.js --manifest "data\scb\manifest.jsonl" --per-label 3 --out "data\scb\results\vision-exp.json"
```

如果出现 `model not found`，说明模型由中转平台提供，需要把 `DEEPSEEK_ENDPOINT` 改成该平台的兼容 API 地址；不要修改模型名称猜测。若出现图片格式不支持，先确认请求接口支持 `image_url` 和 base64 data URL。

## 5. 下一步工作顺序

1. 记忆 MVP 的本地存储、规则和 OpenClaw SDK 工具回调的隔离测试已完成；本轮新增 `agent-memory/src/encrypted-backup.js` 与显式终端入口 `src/backup-cli.js`，可创建 scrypt + AES-256-GCM 加密备份并仅恢复到新文件，6 项临时数据测试通过。未对实际家庭记忆执行操作。活动记忆仍为明文 JSON；2026-09-30 本机只读 BitLocker 查询因缺少管理员权限未能确认，默认记忆目录当前不存在，因此也没有真实目录 ACL 可核验。后续需在有权限的环境核验，再决定是否授权实际备份、恢复和目标介质。
2. 习惯记忆已有本地 Mock 闭环：授权结构化作息观察 → 三个不同本地日期候选 → 用户确认 → `routine_due` 提醒预览。另新增 `agent-memory/src/routine-trigger.js`：供外部调度器轮询，默认关闭；在可信配置单独授权后，按时区、周内/周末和到期窗口产生稳定、可幂等去重的 Event；仍不启动定时器、不发送通知、不控设备。模块测试当前 21/21 通过。作息观察工具传入带时区事件时间，由代码计算本地日期和 15 分钟时间桶；测试覆盖拒绝未授权事件、缺少时区、候选确认和只读预览。新增 `.lock` 仅适用于本机文件系统；异常退出可能留下锁，需确认写入进程已结束后人工核查。真实事件源、周期性时钟调用、通知渠道和经单独授权的实际提醒仍需开发/接入。
3. `2026.7.1-2` 随附文档已确认 `gateway.controlUi.allowInsecureAuth=true` 是 localhost 非安全 HTTP 的兼容开关：允许本机 Control UI 在缺少浏览器设备身份时继续认证，但不绕过 pairing，也不放宽远程（非 localhost）身份要求。优先用 HTTPS 或同机 `http://127.0.0.1:18789/`；确认原有入口可用后再考虑关闭，不能直接改。实际 CLI 安全审计尚未完成：默认配置指向校验失败的旧 `~/.openclaw/openclaw.json`；直接指定版本 profile 名因带点被 CLI 拒绝；按 `OpenClaw-Console.ps1` 设置正确配置/状态目录时，CLI 尝试写入工作区外 profile 状态并被沙箱以 `EPERM` 拒绝。没有运行 `--fix`，没有修改配置。后续需在本机正常 PowerShell 环境补做非 `--fix` 审计；内置 iMessage/Telegram 插件路径警告仍待独立诊断；Gateway 当前由新 profile 计划任务运行。
4. 学习行为：已完成 25 条 AI 初标的结构审计并补上可复用的多标注者一致率审计工具；24 条盲化复核模板仍为空，因此独立人工复核集尚未完成。下一阶段需要第二位标注者完成盲标后，运行 `audit-scene-annotations.js --agreement`，再据仲裁后的参考标签开展逐类指标、弃答率和误报评估。旧单标签约 48% 结果不支持自动控制。摄像头自动采集和真实儿童/台灯接口依赖其他组。
5. 获取真实传感器/HA 实体映射、接口样例和授权信息后，先认证占用事件来源、配置受信任适配器白名单，再接入只读或建议模式并做低风险联调；消息总线确定后再替换进程内调度器，保留 `trace_id`、幂等、安全门控和回读验证。
6. 公共契约 v0.1 是 Agent 组讨论稿，不是开发阻塞项。已补 UDM 映射草案并实现 Task 别名兼容、排队校验和设备管家适配；字段、优先级、数据级别在跨组联调时评审并冻结 v1。
7. 在其他电脑演示时，按 `openclaw-agents/README.md` 单独注册工作区，并分别验证 OpenClaw profile、Skill 发现与仓库内 Mock 编排链路。

## 6. 重要约束

- `deepseek-v4-flash-vision-exp` 是实验性视觉模型；V4.1-Flash 当时尚未上线，V4 Pro/普通 Flash 不能直接作为本实验的图片模型；
- 小红书帖子提到的 `cc-switch-model-catalog.json` 是 Codex 前端模型目录，不等于 OpenClaw 或 API 服务配置；本项目学习行为脚本使用环境变量；
- SCB-Dataset 官方说明限制为学术研究、个人学习和非商业使用；不要把原始数据提交仓库；
- 永远不要读取、打印、提交 `.env`、API Key 或其他认证材料；
- `AGENTS.md` 中的 CtxHop 规则优先。如果用户明确要求“同步/上传到另一台电脑/换电脑继续”，先按 CtxHop 流程检查和恢复，再使用本文件。

## 7. 给下一次会话的启动提示

```text
请先阅读项目根目录的 AGENTS.md 和 PROJECT_HANDOFF.md。当前本机 OpenClaw `2026.7.1-2` profile 已注册 learning-companion、energy-saving 和 device-manager；Gateway 白名单已补齐作息预览工具，计划任务绑定当前 profile 且运行中；这些均为本机状态，不随仓库迁移。仓库内编排器仍为进程内 Mock，不等于独立 OpenClaw Agent 间远程通信。不要重新下载完整 SCB 数据集，不要索要或打印 API Key，不要访问家庭记忆文件。当前回归结果：设备管家 82/82、Mock 验收 10/10、调度器 28/28、节能 Agent 23/23、学习行为 20/20、记忆模块 21/21（含 6 项临时数据加密备份/恢复测试）、公共兼容模块 5/5；插件验证与 18 个有效/4 个无效契约样例也通过。学习离位关灯必须先收到当前进程中可信 HA 无人事件；OpenClaw 插件默认没有可信来源白名单，真实 HA 来源认证待联调。学习行为 25 条 AI 初标仅做了结构审计，独立人工复核未完成。加密备份库未用于真实家庭记忆；活动记忆仍是明文 JSON。跨组契约评审不阻塞本组独立开发。
```

## 8. 2026-09-15 飞书任务安排更新（高层结论）

本节只记录对代码和协作有用的结论，不复制飞书原文、分工文件或内部资料。

### C 组的验收口径

飞书最新版本明确：Agent 不是几个通用大模型互相闲聊，而是事件驱动的“感知 → 状态 → 推理 → 工具 → 策略”系统。任意 Agent 按五元组实现：

`Agent = <Perception, State, Reasoning, Tools, Policy>`

对本项目的映射：

- Perception：学习行为识别、摄像头/传感器、Home Assistant 设备事件；
- State：家庭成员在离家、孩子学习状态、最近事件和当前场景；
- Reasoning：规则与轻量模型结合的任务拆解；
- Tools：设备管家工具、通知工具、抓拍/询问工具；
- Policy：优先级、权限、超时、重试和二次确认。

### 跨组公共契约

主仓库根目录应逐步建立 `common-contracts/`，由各组以公共包或子模块方式引用。首批对象为：

- `Device`：A 组定义，C/D 组消费；
- `Event`：A/C 组发布，C/D 组消费；
- `Task`：C 组生成，B/D 组消费；
- `ResourceStatus`：B 组发布，C 组消费；
- `PolicyDecision`：D 组发布，A/B/C 组消费，结果为 `ALLOW`、`DENY` 或 `CHALLENGE`。

其中 `Task` 是 C（决策）→ B（算力调度）→ D（风控）→ A（设备执行）的关键纽带，至少需要 `task_id`、`source_agent`、`task_type`、`priority`、`deadline_ms`、`resource_requirement` 和 `privacy_level`。

### 端到端基准场景

首个跨组联调场景是“老人疑似跌倒”：设备/摄像头上报异常 → A 组转成统一 `Event` → 看护 Agent 生成 `Task` → D 组根据隐私级别做本地分析权限裁决 → B 组选执行节点 → C 组编排灯光、询问和通知等工具。当前项目可先用 Mock 事件和 Mock HA 验证链路，不应把未经验证的视觉判断直接接到真实设备控制。

### 对当前开发顺序的调整

1. 先落地 `common-contracts/` 的 JSON Schema 和最小 SDK，再把学习行为事件、设备事件和设备管家任务映射进去；
2. 在现有 Mock HA 上增加事件发布/任务回执，保留审计和二次确认；
3. 开发第二个垂直 Agent（优先安防/看护 Agent），再实现最小 Task Orchestrator；
4. 编排层再逐步加入 Redis Streams、Consumer Groups、ACK/Pending 恢复、优先级冲突消解、超时/重试/补偿；
5. 最后用老人跌倒场景做端到端演示，并记录延迟、成功率、误报和安全拦截指标。

### 公共契约当前状态

- `common-contracts/` 是设备管家侧提出的 v0.1 讨论稿，尚未替代其他小组的最终接口约定；
- 当前用 `common-contracts/validate-examples.mjs` 校验示例，用 `device-manager/test/task-runtime.test.js` 模拟其他 Agent 发送任务；
- 需要在小组会议中确认 Agent 正式命名、任务类型、优先级/隐私级别、PolicyDecision 责任方和版本发布规则，再冻结 v1。

本更新不会改变当前结论：学习行为模型的 48% 小样本准确率只能证明识别链路可运行，不能作为自动控灯或其他高风险设备控制的依据。
