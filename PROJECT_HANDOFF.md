# LT-agent-program 项目交接摘要

> 给换设备后的 Codex/协作者：先阅读本文件和根目录 `AGENTS.md`，再开始工作。不要重新研究已经完成的内容，也不要要求用户重复粘贴 API Key。当前工作区的密钥和本地数据均不在 Git 中。

更新时间：2026-10-31

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
- 当前版本的设备管家测试已通过 84/84，包含温湿度、二值传感器、事件审计、真实 HA 故障回读、调度桥接、Task 契约字段校验、优先级保真、个性化场景确认执行、OpenClaw 记忆工具作息日期适配、视觉离位独立占用佐证和自然语言 Mock 多 Agent 演示测试；
- 新增 `src/acceptance.js` 和 `npm run acceptance`，一键验收设备发现、传感器读取、控制后状态验证、个性化场景确认执行、开锁拦截、诊断、事件审计和错误返回；当前 10/10 通过；
- Mock 设备扩展为 10 个：灯、空调、窗帘、门锁、温度、湿度、人体感应、门磁、烟雾传感器和智能插座；
- 新增只读 Skill：`agent-workspace/skills/device-status/SKILL.md`；
- 新增真实 Home Assistant REST API 适配层，可通过 `DEVICE_MANAGER_BACKEND=home-assistant` 切换；
- 真实适配层支持实体白名单、Bearer Token、六类实体状态归一化、service 控制映射、控制后回读、场景预检、开锁确认和审计；
- 新增 `npm run ha:check` 只读连通性检查；认证信息只从环境变量读取，不写入仓库；
- 新增 `common-contracts/` 公共契约 v0.1 草案，包含 Device、Event、Task、TaskReceipt、ResourceStatus 和 PolicyDecision Schema、示例与校验脚本；
- 新增设备管家标准任务运行时 `device-manager/src/task-runtime.js`，可用 Mock 任务模拟其他 Agent，返回 `SUCCEEDED`、`FAILED` 或 `CHALLENGE` 回执；
- 新增动作后状态验证和设备事件账本：控制结果必须回读达到目标，否则返回 `POST_ACTION_VERIFICATION_FAILED`；动作成功、动作失败、诊断告警分别记录标准事件，并通过 `get_device_events` 查询。默认内存实现最多保留 200 条；真实 HA 后端可显式配置 `DEVICE_MANAGER_EVENT_LEDGER_PATH` 启用本机脱敏 JSON 持久账本，Mock 仍为内存账本；
- 已加入真实 HA 的超时、认证失败、服务成功但状态未改变等故障测试；
- 新增 `plan_scene` 只读预览和 `execute_scene_plan` 一次性确认执行闭环：口令有效 10 分钟、执行前重读偏好与设备条件、计划变化时拒绝执行、个性化温度再次预检、执行后逐项回读；计划 ID 写入动作审计的 `task_id` / `trace_id`；
- OpenClaw 对话层拒绝模型直接调用旧 `run_scene`，用户场景需先展示预览，再等待后续独立消息中的明确自然语言肯定答复；内部以 `user_confirmed: true` 关联执行，用户不需要输入计划 ID/UUID。该 Agent 判定不等同 OpenClaw 原生人工审批；
- `device-manager/ACCEPTANCE_REPORT.md` 记录本地验收边界；在 `device-manager` 目录执行 `npm run verify` 可一键跑完 84 项测试、10 项 Mock 验收、插件校验和公共契约样例校验；
- 已按小组要求将本机全局 OpenClaw 对齐到 `2026.7.1-2`；该版本使用独立配置目录 `%USERPROFILE%\\.openclaw-2026.7.1-2`，旧版 Gateway 已成功加载 device-manager（9 个插件）；
- 2026-09-30 已只读核验本机 profile 的 `agents.list[1].tools.alsoAllow`，保留原有工具并补入 `preview_household_routine`；随后 `openclaw plugins inspect device-manager --runtime` 显示插件 `loaded`，记忆工具均出现在运行时工具清单。另通过 OpenClaw SDK 注册后的实际工具回调，在隔离临时记忆路径完成保存、作息观察、候选确认、预览和删除闭环测试；未读取真实家庭记忆，也未调用模型。Gateway 中真实用户对话验证尚未进行；
- 2026-10-07 重查 `openclaw plugins inspect device-manager --runtime`，插件仍为 `loaded`，运行时列出 16 个工具。另在隔离 session 通过 Gateway 调用一次只读设备清单：provider/model 为 DeepSeek `deepseek-v4-flash`，只调用 `list_devices` 一次、无工具失败/无控制调用，返回 Mock 客厅灯 `light.living_room` 在线且关闭；API 费用未核对。OpenClaw 自动向模型上下文注入了 agent workspace bootstrap 文件（包括 `USER.md` 和 Skill 描述）；本地人工检查 9 个上下文文件未发现凭据、联系方式、实际家庭作息/成员信息或真实 HA 数据，但其中项目技术说明仍会发送给模型；`USER.md` 只有模板，`IDENTITY.md` 的旧 V4 Pro 标签已改为“由本机配置决定”，防止未来换模型时过时。后续 API 调用仍暂停，等用户确认是否接受将这些项目说明发往 DeepSeek。`openclaw security audit --json` 返回 0 critical、4 warn、1 info：Gateway 当前 loopback 绑定；`allowInsecureAuth=true` 告警；DeepSeek provider 安装记录未固定精确版本；攻击面摘要显示 elevated tools enabled。没有运行 `--deep` 或 `--fix`。CLI 同时报告 iMessage/Telegram bundled channel setup 路径校验告警，但 device-manager 插件本身加载成功。详见 `docs/openclaw-runtime-verification-2026-10-07.md`；真实 HA/家电控制仍未验收；
- 2026-10-07 只读核对隔离 profile：没有显式设置全局/Agent `thinkingDefault`，DeepSeek 模型项无 `params.thinking`，最新会话元数据无 `thinkingLevel`；因此回执的 `thinking=high` 确切来源仍未查明，不再通过重复模型请求猜测。sandbox mode 未显式设置，OpenClaw `2026.7.1-2` 运行时代码默认值为 `off`；CLI 策略解释命令因 Windows 沙箱拦截其对 profile 状态文件的 chmod（EPERM）未能给出完整输出。未提权、未改配置。详情见 `docs/openclaw-runtime-verification-2026-10-07.md`；
- 2026-10-07 在本地运行 `pwsh -NoProfile -File .\Verify-Agent-Stack.ps1`，公共契约、设备管家、节能、学习行为、家庭记忆、多 Agent 编排测试及 Mock 演示合计 10/10 通过。设备管家 `npm run verify` 再次通过（82 项单测、10 项 Mock 验收、插件有效、17 个有效/4 个预期无效契约样例）；记忆模块 `npm test` 21/21 且 `npm run demo` 通过，演示只用临时数据，只生成提醒预览、不建定时器、不控制设备。修正了 `memory-store.js` 关于锁语义的过时注释。上述验证未调用模型 API、未连接 live HA。新增 `.github/workflows/agent-stack.yml` 计划在 Windows GitHub Actions 执行全栈验证，但本地变更尚未推送，所以远程 CI 尚未启用或验证；
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

### 能源管家 MVP

目录：`energy-saving/`

- 已建立独立的规则型 `energy-saving` 功能 Agent；
- 支持 `occupancy_changed`、`home_mode_changed`、`learning_behavior` 和 `user_device_override` 事件；
- 根据可信无人时长、离家模式，或“稳定多帧视觉离位 + 可信同区域 HA 无人事件”组合，生成 canonical `device_action` 任务；
- 只规划任务，不直接调用 Home Assistant，所有设备动作仍由 `device-manager` 执行并回读验证；
- 对门锁、传感器和安全设备做保护，不接受低置信度或需要人工复核的学习行为结果；
- 已加入幂等键、事件去重、用户手动保持期、设备冷却时间和 `trace_id`；
- 已提供 Mock 端到端演示：客厅无人 10 分钟 → 能源管家→ 设备管家 → 状态回读；
- `energy-saving` 测试通过 23/23，设备管家全套测试通过 84/84；
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
- `device-manager/src/device-monitor-tools.js`：HA/Mock 离线监测和诊断；普通设备短暂离线先宽限，3 台及以上同时持续离线时聚合为共同基础设施提示，不把每台普通设备都判成故障；显式配置的关键设备保留单独告警。最新修正为仅将宽限期复查确认仍离线的设备计入门槛，并在可能形成 3 台共同事件时暂缓普通单设备告警，防止先逐台报错再报共同风险。2026-10-11 Mock 回归通过，真实 HA 仍待设备联调。
- `docs/adaptive-device-management-v0.1.md`：设备能力发现、授权节能规划和只读离线监测边界；监测演示仅用 Mock，不代表实机。
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
2. 习惯记忆已有本地 Mock 闭环：授权结构化作息观察 → 三个不同本地日期候选 → 用户确认 → `routine_due`。当前设备管家 OpenClaw 工具可按已确认作息检查并写入持久提醒收件箱，用户可以列出和确认已读；默认不启动周期任务，只有用户明确启动、持久提醒授权、本机 `DEVICE_MANAGER_ROUTINE_SCHEDULE_ENABLED=true` 和有效 `HOUSEHOLD_TIME_ZONE` 均满足才运行。收件箱和 runner 使用临时数据完成端到端测试与隔离演示；没有系统通知推送、真实 HA 或设备动作。作息观察工具传入带时区事件时间，由代码计算本地日期和 15 分钟时间桶；设备操作偏好推断将温度归一到 0.5°C、亮度归一到 5% 档，再累计至少三个不同本地日期，原始观察值不落盘且候选仍需用户确认；真实家庭记忆和真实事件源仍未接入。
3. `2026.7.1-2` 随附文档已确认 `gateway.controlUi.allowInsecureAuth=true` 是 localhost 非安全 HTTP 的兼容开关：允许本机 Control UI 在缺少浏览器设备身份时继续认证，但不绕过 pairing，也不放宽远程（非 localhost）身份要求。优先用 HTTPS 或同机 `http://127.0.0.1:18789/`；未确认设备身份流程前不要直接改。2026-10-07 已在隔离 profile 完成 `openclaw security audit --json`（0 critical、4 warn、1 info），没有运行 `--deep` 或 `--fix`。Gateway 仅 loopback 绑定；`allowInsecureAuth=true` 与 DeepSeek provider npm 记录未固定精确版本需继续评估；CLI 报告 elevated tools enabled，需保持最小权限。iMessage/Telegram bundled channel setup 路径警告仍待独立诊断。`openclaw sandbox explain` 在受限环境因尝试 chmod profile 状态文件被 `EPERM` 拦截；只读源码确认 sandbox 未配置时默认 `off`，没有提权或修改配置。详见 `docs/openclaw-runtime-verification-2026-10-07.md`；Gateway 当前由新 profile 计划任务运行。
4. 学习行为：已完成 25 条 AI 初标的结构审计并补上可复用的多标注者一致率审计工具；24 条盲化复核模板仍为空，因此独立人工复核集尚未完成。下一阶段需要第二位标注者完成盲标后，运行 `audit-scene-annotations.js --agreement`，再据仲裁后的参考标签开展逐类指标、弃答率和误报评估。旧单标签约 48% 结果不支持自动控制。摄像头自动采集和真实儿童/台灯接口依赖其他组。
5. 设备离线监测策略已补齐 Mock 闭环：普通设备宽限期、瞬时恢复、持续单设备故障、多设备共同基础设施聚合、恢复/实体移除处理；关键实体仍单独高优先告警。共同故障只计入宽限期后确认离线的实体；已有至少三个离线候选时暂缓普通单台告警，若部分设备恢复，剩余设备再恢复单独告警。事件账本仍默认最多保留 200 条内存记录；新增真实 HA 可选的脱敏持久账本，跨 Node 进程恢复和失败关闭已用临时目录验证，不代表真实 HA 联调。获取真实传感器/HA 实体映射、接口样例和授权信息后，先认证占用事件来源、配置受信任适配器白名单，再接入只读或建议模式并做低风险联调；消息总线确定后再替换进程内调度器，保留 `trace_id`、幂等、安全门控和回读验证。
6. 公共契约 v0.1 是 Agent 组讨论稿，不是开发阻塞项。已补 UDM 映射草案并实现 Task 别名兼容、排队校验和设备管家适配；字段、优先级、数据级别在跨组联调时评审并冻结 v1。
7. 在其他电脑演示时，按 `openclaw-agents/README.md` 单独注册工作区，并分别验证 OpenClaw profile、Skill 发现与仓库内 Mock 编排链路。

## 6. 重要约束

- `deepseek-v4-flash-vision-exp` 是实验性视觉模型；V4.1-Flash 当时尚未上线，V4 Pro/普通 Flash 不能直接作为本实验的图片模型；
- 小红书帖子提到的 `cc-switch-model-catalog.json` 是 Codex 前端模型目录，不等于 OpenClaw 或 API 服务配置；本项目学习行为脚本使用环境变量；
- SCB-Dataset 官方说明限制为学术研究、个人学习和非商业使用；不要把原始数据提交仓库；
- 永远不要读取、打印、提交 `.env`、API Key 或其他认证材料；
- `AGENTS.md` 中的 CtxHop 规则优先。如果用户明确要求“同步/上传到另一台电脑/换电脑继续”，先按 CtxHop 流程检查和恢复，再使用本文件。

## 7. 给下一次会话的启动提示

**最新运行状态补充（2026-10-16）：**本机 `2026.7.1-2` Control UI 浏览器已配对；用户授权后已对隔离 Gateway 执行 safe restart。重启后，`device-manager → learning-companion → energy-saving` 三 Agent 合成联调通过：学习 Agent 的 Event 经本地 Schema 校验，能源管家对低置信度且需复核、缺少可信 HA 无人佐证的合成事件返回 `NO_ACTION / LEARNING_BEHAVIOR_WITHOUT_TRUSTED_OCCUPANCY_WINDOW`；设备动作数 0，未连接真实 HA。使用 DeepSeek V4 Flash、thinking off；API 用量已产生，费用未核对。CLI `gateway probe` 仍单独报告 `missing scope: operator.read`（本轮未复查），不影响浏览器与 Agent 调用。详见 `docs/openclaw-independent-agent-orchestration-v0.1.md`。不要升级 OpenClaw，不要 reset/delete Agent 会话，也不要连接真实 HA 或操作设备。

**同日补充：**独立 `energy-saving` Agent 通过 Gateway + DeepSeek V4 Flash 为合成“离家、客厅灯亮”事件生成了 `P3 turn_off light.living_room` 候选 Task。该 Task 回放到本地 Mock 设备管家后得到 `CHALLENGE`；模拟暂缓时待办保留，模拟拒绝后待办关闭并返回 `REJECTED`。另以临时状态文件模拟设备管家进程重建，旧确认恢复为 `RECOVERY_REQUIRED`，尝试批准仍不执行。补充覆盖候选 Task 伪造可信 HA 元数据仍要求确认，以及 Agent 调用失败时不进入执行。Mock 灯始终保持 `on`，设备动作增量为 0。相关用例已固化在 `device-manager/test/independent-energy-workflow.test.js`；定向测试 8/8、设备管家全量测试 221/221、跨模块/演示验证 10/10 通过。进程重建不是实际 Gateway 重启；不连接真实 HA、不操作真实设备。详见上方编排验证记录。

```text
请先阅读项目根目录的 AGENTS.md 和 PROJECT_HANDOFF.md。当前本机 OpenClaw `2026.7.1-2` profile 已注册 learning-companion、energy-saving 和 device-manager；Gateway 白名单已补齐作息预览工具，计划任务绑定当前 profile 且运行中；这些均为本机状态，不随仓库迁移。仓库内编排器仍为进程内 Mock，不等于独立 OpenClaw Agent 间远程通信。设备管家 OpenClaw TUI 新增自然语言入口 `run_mock_agent_chain_demo`：明确演示请求可触发合成 learning_departure 事件链，专用 Mock HA，不代表真实传感器/视觉或实设备控制；需在本机 TUI 复测。不要重新下载完整 SCB 数据集，不要索要或打印 API Key，不要访问家庭记忆文件。当前回归结果：设备管家 84/84、Mock 验收 10/10、调度器 28/28、能源管家23/23、学习行为 20/20、记忆模块 21/21（含 6 项临时数据加密备份/恢复测试）、公共兼容模块 5/5；插件验证与 18 个有效/4 个无效契约样例也通过。学习离位关灯必须先收到当前进程中可信 HA 无人事件；OpenClaw 插件默认没有可信来源白名单，真实 HA 来源认证待联调。学习行为 25 条 AI 初标仅做了结构审计，独立人工复核未完成。加密备份库未用于真实家庭记忆；活动记忆仍是明文 JSON。跨组契约评审不阻塞本组独立开发。
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

## 2026-10-18 维护周期本地提醒补充

在已接入 OpenClaw 的维护计划之上增加了本地提醒收件箱：支持按需检查，以及经过本机开关和用户明确启动后的周期检查；重复提醒按维护周期去重，升级为逾期时更新/重新打开提醒。只有本地收件箱，没有手机/外部推送；提醒已读不代表维护完成；Gateway 重启后周期检查不会自动恢复。相关代码在 `device-manager/src/maintenance-reminder-{inbox,tools}.js`，说明见 `docs/maintenance-reminder-inbox-v0.1.md`。本地设备管家全量测试 248/248、Mock 验收 11/11、能源管家测试 43/43 通过，插件验证及契约样例验证通过。没有重启本机 Gateway、连接真实 HA 或操作物理设备。

2026-10-18 又增加 `npm --prefix device-manager run demo:maintenance-reminders`：用纯合成数据验证提醒跨独立 Node.js 进程持久化、同周期去重、已读不等于维护完成、逾期升级重新进入待处理列表；演示运行后清理临时数据。此项仍不是 Gateway 实际加载或真实 HA/设备验收。

2026-10-18 经用户授权重启隔离 `2026.7.1-2` Gateway 后，插件运行时检查为 `loaded`，维护提醒 6 个工具均已注册。safe restart 后 Gateway 未自动拉起，因为 Windows Scheduled Task 显示 missing；为恢复当前会话，按隔离 profile 的现有 `state/gateway.cmd` 临时隐藏启动，没有创建持久计划任务。Gateway 版本正确、loopback 端口恢复监听；CLI 仍显示 `connected-no-operator-scope`。本次未调用模型或提醒工具、未读写家庭计划/提醒数据；实际 OpenClaw 对话回调及自动启动问题待后续处理。

2026-10-18 新增维护提醒周期检查的显式重启恢复：`start_maintenance_reminders` 可由用户明确选择 `resume_after_gateway_restart: true`，仅当管理员开关持续开启时，OpenClaw 后台服务才会在 Gateway 启动时恢复计时器。默认仍关闭；用户显式 stop 会清除恢复意图；损坏状态 fail closed。状态仅记录是否恢复及更新时间。本地测试已验证进程重建、开关关闭、stop 清除及损坏状态保护。没有修改本机 Gateway 配置或执行重启；该改动不解决 Windows Scheduled Task missing，也未完成真实 Gateway 对话工具调用验收。

2026-10-18 完成维护提醒“暂缓”闭环：新增 `snooze_maintenance_reminder`（仅用户明确要求并提供时长时调用，5 分钟至 30 天）；默认列表隐藏暂缓项，可用 `list_maintenance_reminders(include_snoozed: true)` 查看；暂缓到期后下次检查/查看恢复为待处理，升级为 `OVERDUE` 时提前重新打开。暂缓不会标记已读或维护完成，也不发送外部通知。收件箱 schema 升至 0.2，兼容读取 0.1 记录；检查回执报告 `snoozed_reopened` 数量。隔离演示已覆盖暂缓及到期恢复。专项测试 17/17、设备管家全量测试 257/257、Mock 验收 11/11、插件校验及公共契约校验通过。未重启 Gateway、未调用 DeepSeek/其他模型 API、未连接真实 HA 或操作设备；当前通过的是代码与 Mock 验收，非运行时对话或真实设备验收。

2026-10-18 完成“登记维护完成后关闭对应提醒”的闭环：`record_device_maintenance_completed` 会按同一 `schedule_id` 和完成时间，关闭之前已创建的待处理、已读及暂缓提醒；记录保留为 `completed` 历史，默认隐藏，可显式查询。补录的过去完成时间不会关闭之后才创建的提醒。维护记录与提醒收件箱分属两个文件，无法原子提交；若提醒同步失败，完成记录仍为准，回执明确标出部分失败，幂等重试会再次尝试同步。收件箱 schema 升至 0.3，兼容读取 0.1/0.2。隔离演示覆盖逾期提醒→模拟完成登记→清空待办并保留历史；24 项专项测试、全量 260 项测试、Mock 验收 11/11、插件校验、公共契约测试 5/5 及 17 个有效/4 个预期无效契约示例均通过。未重启 Gateway、未调用模型 API、未连接真实 HA/设备，也没有实际执行维护；这证明的是本地代码和合成数据闭环，不是运行时对话或真实设备验收。

2026-10-18 补齐维护提醒的“下一周期再触发”验证：显式登记完成后，日期周期从完成时间重新计算，已有用量计数归零；下一次检查会按新到期日创建独立的新提醒 ID，旧周期提醒仍保留为完成历史。专项维护提醒/演示测试 18/18，全量设备管家测试 261/261，Mock 验收 11/11、插件校验及公共契约校验通过。演示只用合成计划、可控时钟和临时目录，不启动周期计时器、不发送外部通知、不调用模型、不访问 Gateway/HA/真实设备。

2026-10-18 给维护提醒列表补上分页：`list_maintenance_reminders` 继续默认返回最新 20 条待处理提醒，也支持 `limit`（1–50）和 `offset`（0–500）；回执提供筛选后的 `total_count`、`next_offset` 和按提醒 ID 锚定的 `next_cursor`。静态列表可用 offset；列表可能在翻页期间变化时，游标能避免较新的插入记录挤动后续页，也允许锚点状态变更后继续读取。已验证新提醒在翻页间插入、锚点转已读时不重复/漏掉旧记录，及无效/过期游标失败返回；默认最新优先行为不变。专项提醒/演示测试 19/19，全量设备管家测试 262/262，Mock 验收 11/11，插件及公共契约校验通过。未修改或读取本机提醒状态、未发送外部通知、未调用模型或连接真实设备。

2026-10-18 增加维护提醒收件箱容量治理：新增 `archive_completed_maintenance_reminders`，必须传用户明确确认和 `completed_before` 截止时间；只把 `completed_at` 不晚于截止时间的已完成提醒搬入同一个 JSON 文件的 `archived_notifications`，不删除历史，不触碰待处理/已读/暂缓提醒。归档历史可经 `list_maintenance_reminders(include_archived: true)` 查询，周期去重也检查归档区；活动收件箱仍最多 500 条，归档后可继续生成提醒。Schema 升至 0.4，兼容旧 0.1/0.2/0.3；无效归档数据 fail closed。临时数据测试覆盖确认门禁、截止条件、状态保护、容量释放、分页游标锚点被归档后仍可续读和旧版本升级；隔离演示也呈现“旧周期归档、下一周期待处理仍在”。专项提醒/演示测试 22/22，设备管家全量测试 265/265、Mock 验收 11/11、插件校验、公共契约测试 5/5 及样例校验均通过。未读取或改写本机正式提醒文件、未重启 Gateway、未调用模型 API、未连接真实 HA/设备。

2026-10-18 为维护完成历史补上筛选和分页：`get_device_maintenance_plan` 仍默认回传最近 20 条，但新增 `completion_schedule_id` 过滤和 `completion_limit`（1–50）、`completion_offset`（0–500）、`completion_cursor` 分页参数，并返回筛选后的 `completion_history_page.total_count/next_offset/next_cursor`。列表变化时游标锚定完成记录 ID，测试覆盖翻页间插入新记录后仍可继续读较旧历史、按单个计划筛选、以及无效参数/游标保护；原默认响应字段 `recent_completions` 保持兼容。针对性工具测试 6/6，设备管家全量测试 266/266、Mock 验收 11/11、插件校验、公共契约测试 5/5 和 17 有效/4 预期无效样例均通过。只使用临时合成记录，没有读取或改写正式维护记录、重启 Gateway、调用模型 API 或接入真实 HA/设备。

2026-10-18 继续补齐维护计划持久存储的并发保护：`MaintenanceScheduleStore` 在进程内串行化之外，对计划新增/更新和维护完成登记使用文件级独占锁，避免多个 Node/OpenClaw 写入者并发读改写互相覆盖。锁冲突返回 `MAINTENANCE_STORE_LOCKED` 且不改数据、不清理他方锁；进程异常退出导致的陈旧锁不会自动删除，需运维核对后人工处理。独立 Node 子进程创建竞争锁后，计划修改和完成登记均正确拒写，解锁后重试成功。设备管家全量测试 267/267、Mock 验收 11/11、插件校验、公共契约测试 5/5、17 个有效/4 个预期无效契约样例均通过；维护提醒隔离演示通过并清除临时数据。没有接触正式维护文件、Gateway、模型 API、真实 HA 或设备。

2026-10-18 增加只读维护存储锁诊断命令 `npm --prefix device-manager run maintenance:lock-status`，可用 `-- --path <schedule.json>` 检查临时/指定路径。只读取 `.lock` 元数据，区分无锁、PID 仍存在、PID 不存在和元数据损坏；不读取维护计划/完成正文、不显示 token、不修改/删除文件。PID 存在不证明仍是原进程（可能复用），所以不自动清理。OpenClaw 工具层也验证了保存计划和登记维护完成在锁冲突时均明确返回 `MAINTENANCE_STORE_LOCKED`，不会虚报成功。专项测试 18/18，设备管家全量测试 269/269、Mock 验收 11/11、插件/契约校验通过；能源管家43/43。只用临时数据和只读 CLI smoke；未访问正式维护文件、重启 Gateway、调用模型 API 或接入真实 HA/设备。

2026-10-18 将维护存储的跨进程锁扩展到读取路径：`listSchedules`、`listCompletions` 和 `readSnapshot` 现在也在锁内读取，避免 Windows 文件替换回退期间读取半成品；`get_device_maintenance_plan` 改为在一个 `readSnapshot()` 内同时获取计划与完成历史，避免分两次读取造成不同时点混合。发生冲突时查询也失败关闭并回传 `MAINTENANCE_STORE_LOCKED`，不产生部分/混合视图。专项维护测试 18/18、设备管家全量 269/269、Mock 验收 11/11、插件与契约校验通过；能源管家43/43；维护提醒 Mock 演示通过并清除临时数据。没有接触真实维护文件、Gateway、模型 API、HA 或设备。

2026-10-18 为维护计划存储增加有限时等待锁释放：跨进程锁冲突时默认最多等待 1000ms、每 25ms 重试；超时仍失败关闭并返回 `MAINTENANCE_STORE_LOCKED`，不覆盖或删除他方锁。`MaintenanceScheduleStore.lockWaitMs` 可设为 0–5000ms，非法值构造时拒绝。新增子进程测试覆盖短暂锁冲突等待后成功写入，并调整冲突失败测试为 10ms 等待以保持快速稳定。专项维护/工具测试 20/20、设备管家全量 271/271、Mock 验收 11/11、插件校验、公共契约测试 5/5、17 个有效/4 个预期无效契约样例通过；能源管家43/43；维护提醒合成演示通过并清除临时状态。没有接触正式维护数据、Gateway、模型 API、HA 或设备。

2026-10-18 增加多写进程并发验收：4 个独立 Node 进程同时向同一维护计划文件新增不同记录，全部成功退出，最终快照保留全部 4 条记录且没有残留锁。该测试使用临时目录和 5 秒最大等待参数，不修改运行中的 OpenClaw 或正式维护文件。专项维护/工具测试 21/21、设备管家全量 272/272、Mock 验收 11/11、插件校验、公共契约测试 5/5、17 个有效/4 个预期无效样例及能源管家43/43 均通过。未连接真实 HA/设备，未重启 Gateway 或调用模型 API。

2026-10-18 新增异常退出残留锁演练：模拟写入进程建立锁后退出，诊断器识别为 `LOCK_OWNER_PROCESS_NOT_FOUND`；维护存储和 CLI 均保持只读，后续写入明确返回 `MAINTENANCE_STORE_LOCKED`，锁文件及原始维护文件状态保持不变。测试没有实现自动清锁，人工确认仍是必要的安全边界。专项维护/工具测试 22/22、设备管家全量 273/273、Mock 验收 11/11、插件校验、公共契约测试 5/5、17 个有效/4 个预期无效样例及能源管家43/43 均通过。仅使用临时目录，未访问正式维护数据、重启 Gateway、调用模型 API 或连接 HA/设备。

## 2026-10-23 家庭记忆 SQLite 后端集成

为家庭记忆增加可部署的 SQLite 持久化后端，保留 JSON 兼容后端作为默认值；设备管家 OpenClaw 插件配置 `memoryBackend: "sqlite"` 后，通过原有记忆工具读写边缘 Gateway 状态目录中的数据库。安装器支持 `-EnableSQLiteMemory` 和可选 `-MemoryDatabasePath`；已有 JSON 数据必须通过显式导入命令迁移，源文件保持不变。实现和部署限制见 `docs/household-memory-sqlite-backend-v0.1.md`、`docs/household-memory-sqlite-backup-v0.1.md` 及 `agent-memory/README.md`。

本次复核 Node.js v24.19.0 下记忆模块测试 63/63、OpenClaw 插件记忆运行时测试 4/4 通过。SQLite 数据库文件当前不做应用层加密；在线备份/恢复为人工触发、仅新建目标，需 Node.js 22.16+。真实 Gateway 部署仍需由目标环境显式启用 SQLite、核对持久化路径与 ACL/磁盘加密，并按统一 Gateway 运维流程加载插件；本地测试未修改老师统一 Gateway，也未写入真实家庭记忆。

2026-10-23 完成 SQLite 交付包安全与重复安装硬化：交付包现在按扩展名统一排除 `.sqlite`、`.sqlite3`、`.db` 及 `-wal`/`-shm`/`-journal` 旁路文件，不再依赖 `family-memory` 文件名前缀；安装器不接受相对或位于解压包目录内的 SQLite 路径，并在未提供新路径时保留已配置的显式、隐式或兼容环境变量数据库路径。假设台账已补全数据库路径耦合校验、相对路径基准、重装语义、环境变量区分及安全重启提示行为。回归与包内验收 `Test-DeploymentPackage.ps1 -InstallerChecks -InstallFlow -ArchivePath ...v0.1.23.zip` 95 项通过；新包 `output/deployment/LT-agent-program-deployment-v0.1.23.zip` 共 305 个文件，ZIP 检查确认未包含 SQLite 数据库/旁路文件，旧版 0.1.22 未覆盖。复核来源为同模型家族的 provisional 扫描并已自行核验关键代码；未重启或修改实际 OpenClaw Gateway，也未读取真实家庭数据。

## 2026-10-30 门锁认证与审批恢复本地验证更新

- 门锁可信认证代码现有 HTTP 适配器和 Ed25519 校验器；本轮新增本机假认证服务端到端测试。正确签名授权可以通过 Mock 门锁写入并回读为 unlocked；授权绑定错误设备时写入被拒绝，状态保持 locked。
- Node 和 PowerShell 安装器在 Mock 验证时清除 HA 与门锁认证环境变量。部署手册记录了服务 HTTP 契约、Ed25519 声明和密钥注入边界。
- **审批重启恢复已经实现，不是待开发项。** 插件启动时创建 `AgentApprovalStateStore`，默认文件位于 `$OPENCLAW_STATE_DIR/device-manager/agent-approval-state.json`（未设置时为 `~/.openclaw/device-manager/agent-approval-state.json`）。待确认项重启后变为 `RECOVERY_REQUIRED`；执行窗口中断变为 `EXECUTION_UNCERTAIN`，都不会恢复旧批准或自动重放。持久化只保留最小计划/幂等摘要，不保存聊天原文、证据或凭据。
- 2026-10-30 回归：设备管家 293/293、锁具认证适配器 8/8、审批计划 27/27、安装器 13/13、部署包检查 76 项通过。未部署外部可信认证服务，未连接真实 HA 或设备，也未重启用户 Gateway。
- 本机此前生成 `output/deployment/LT-agent-program-deployment-v0.1.28.zip`（309 个文件）作为候选快照；它不是正式验收通过或发布版本，没有上传，也没有覆盖旧包。最初 Linux 检查虽为 11/11 阶段通过，但未安装目标 SDK，6 个 SDK 专属适配器测试被跳过。
- 2026-10-30 对该候选快照补验：从 ZIP 解压到 Debian 12 / Node.js 24.22.1 临时目录后，Linux 验证阶段 11/11 通过，582 项单元测试和 11 项设备管家 Mock 验收均通过，0 跳过；设备管家和平台编排插件在 OpenClaw `2026.7.1-2` 下通过 `plugins validate`。隔离临时 Profile 的 Gateway 健康检查通过（17 ms），10 个插件已加载、无插件错误；Linux 安装器 `--plan-only` 通过并识别 `main` 主 Agent。未连接模型、真实 HA 或设备。
- 该候选 ZIP 使用反斜杠路径。Debian `unzip 6.0` 能正确展开目录，候选代码从解压目录通过了上述测试，但 `unzip` 会发出路径警告并返回退出码 1；正式打包前应处理此兼容性问题。另对 OpenClaw `2026.7.1-2` 运行 `npm audit`，当前 registry 数据报告 15 个受影响依赖项（4 中危、10 高危、1 严重），包括严重级别的 `proxy-addr`；未运行自动修复，也未改变锁定的 OpenClaw 版本。运行时依赖安全处理仍待确认。
- 已修正打包器源码：新增 `deployment/Package-Archive.ps1`，让 ZIP 条目统一使用 `/`，并为路径格式加入回归检查。`Test-DeploymentPackage.ps1 -InstallerChecks -InstallFlow` 95 项通过，包含临时 ZIP 嵌套目录与 Linux 路径测试。没有生成新版本 ZIP，因此现有 `v0.1.28` 候选包仍有原警告；需在其余验收项关闭后再重建并复验。
- 2026-10-31 后续验收：更正 Docker Desktop 位于用户目录的安装路径后启动本机 Engine；已有 `lt-agent-program-linux-workspace` 容器显示为运行中，没有对该容器执行命令、复制文件或触碰 `/workspace`。通过无网络、自动移除的 Debian 12 / Node.js 24.22.1 容器，用只读挂载的临时 ZIP 验证 `Package-Archive.ps1` 输出：`unzip -t` 退出码 0，嵌套文件解压/读取成功；临时文件和容器已清理。这证明打包器路径修正，不是完整版本包验收。旧 `v0.1.28` 仍有 304 个反斜杠路径且缺少新打包器，仍不通过。
- 同日从 npm registry 重新审计精确版本 `openclaw@2026.7.1-2`：15 项（1 严重、10 高危、4 中危）。隔离容器内尝试不带 `--force` 的 lockfile-only 修复未改变数量；npm 表示 `--force` 会升级到 `2026.10.9`。单独审计 `2026.10.9` 仍有 6 项（0 严重、4 高危、2 中危），所以该升级也不能得到零漏洞结果。没有运行强制升级，也未修改项目/实际 Gateway。运行时依赖安全项仍需风险处理决定。
- 继续验收时对 `v0.1.28` 的 309 个文件与当前打包规则做了只读逐项比对：设备/能源/记忆/编排运行时代码和对应单元测试内容一致；差异是打包后加入的 ZIP 路径回归检查、验收记录更新、README 中构建时的命令路径替换及两个插件包的目标版本固定。旧包仅缺少新增的 `deployment/Package-Archive.ps1`，并且其 ZIP 条目仍使用反斜杠。当前工作区重新运行 `Test-DeploymentPackage.ps1 -InstallerChecks -InstallFlow`，95/95 通过。该结果确认既有 582 项 Debian 测试覆盖当前运行时代码，但不改变旧 ZIP 未通过 Linux 归档验收的结论。
- 只读检查当前 Linux/PowerShell 安装器和部署说明，没有发现项目安装器设置 Gateway 的 `trustedProxies`、bind 或代理参数；这避免由本项目写入 GHSA 所述的短前缀 IPv4 映射 IPv6 信任网段，但不会检查或覆盖目标 OpenClaw Profile 中已有的代理配置，也不修复受影响依赖。部署方若自行启用反向代理，仍需按上游公告核对信任网段。

## 2026-10-31 最终候选包验收

- 用户明确接受 OpenClaw `2026.7.1-2` 依赖树的 15 项审计告警（1 严重、10 高危、4 中危）作为本次交付的已知风险。没有升级 OpenClaw、运行 `npm audit fix --force` 或修改目标版本依赖；风险接受不代表修复。
- 最终包：`output/deployment/LT-agent-program-deployment-v0.1.31.zip`，310 个文件，SHA-256 `9C5A30EB038FDEF6DE7C07E1ADCEFAE08EAC6EDBB08CB3EB7B132278752766FD`。旧 `v0.1.28` 保留为历史候选，因 ZIP 反斜杠路径不再作为交付包使用。
- Windows 部署/安装/ZIP 检查 `Test-DeploymentPackage.ps1 -InstallerChecks -InstallFlow -ArchivePath ...v0.1.31.zip`：123/123 通过。
- Debian 12 / Node.js 24.22.1 整包验收：ZIP `unzip -tq` 通过；精确 CLI 为 OpenClaw `2026.7.1-2`；设备管家与平台编排插件均通过 `plugins validate`；`deployment/verify-agent-stack.mjs` 11/11 阶段通过，582 项单元测试、11 项设备管家 Mock 验收通过。依赖安装仍报告上述 15 项风险，按用户决定接受。
- 本次仅用隔离 Mock 环境，没有连接 HA、真实设备或调用模型 API。该结果完成本地交付包验收，不替代接收方 Profile 配置复核和真实设备联调。

## 2026-10-31 本地可完成项继续验收

- 在专用 Ubuntu 24.04 Docker 容器与持久卷中，以非特权 `ltagent` 账户完成家庭记忆 SQLite 路径测试：状态目录 `0700`，数据库文件 `0600`；新备份/恢复库均 `0600`。增加了备份文件权限回归断言，Ubuntu 专项测试 6/6 通过；恢复后从数据库读回合成偏好，容器重建后仍可读回。旧的 `0644` 备份文件仅作修复前对照。
- 当前代码与新交付包在 Ubuntu 隔离 OpenClaw Profile 中固定使用 `2026.7.1-2` 验证；仅启用 Mock 后端、loopback Gateway 和 SQLite 测试路径，不配置云模型、不连 HA/真实家电。记录插件加载、工具注册、SQLite 只读查询与正常停机结果。
- 纠正早先失败的审计尝试：当时缺 lockfile，`npm audit` 返回 `ENOLOCK`，不能据此统计。随后在隔离目录生成临时 lockfile 并成功审计 `openclaw@2026.7.1-2`；截至本次 registry 数据为 17 项（1 严重、10 高危、6 中危），比同日稍早的 15 项多 `glob`、`minimatch` 两项。保持团队指定版本，没有运行自动修复或升级。
- 最终候选交付包：`output/deployment/LT-agent-program-deployment-v0.1.33.zip`，310 个 ZIP 条目，SHA-256 `74368C9816718AEDEEE1D4DD5A69AAB00B5AE4497D94FD0F0526B35237B5E3F4`。Windows 部署包检查 123/123；Debian 12 / Node.js 24.22.1 和 Ubuntu 24.04 / Node.js 24.22.2 均通过 ZIP 检查、OpenClaw `2026.7.1-2` 固定 SDK 的两个插件 CLI 校验，以及 `deployment/verify-agent-stack.mjs` 11/11 阶段、582 项单元测试、11 项设备管家 Mock 验收。
- 在隔离 Ubuntu Profile 中，OpenClaw Gateway 健康检查通过，`device-manager` 与 `platform-orchestrator` 均加载，插件错误 0；通过 Gateway `tools.invoke` 写入并读回合成 `comfort_temperature_c=22` 偏好。容器重启后仍可读回，目录权限 `0700`、SQLite 数据库 `0600`。SQLite 备份专项测试 6/6 通过，新备份和恢复库权限均 `0600`。Gateway 未连模型、HA 或真实设备。
- 当前 registry 的精确版本审计结果为 17 项（1 严重、10 高危、6 中危）。固定版本按项目组要求保持 `2026.7.1-2`；没有运行 `npm audit fix` 或自动升级。此数值较早先同日 15 项的记录新增 `glob`、`minimatch`，是当前 registry 解析结果。
- 隔离验收 Gateway 已正常关闭，临时 token 已删除。容器 `lt-agent-local-ubuntu24-validation-20261031` 已停止但保留；专用数据卷 `lt-agent-local-ubuntu24-validation-data-20261031` 保留，供后续继续验收。卷内只含合成测试记忆与验收文件。

## 2026-10-31 交付收尾状态

- 更正交付验收矩阵、交付包说明和快速开始文档中的依赖审计数量为当前记录的 17 项（1 严重、10 高危、6 中危）；沿用用户此前对固定 `2026.7.1-2` 的风险接受，不升级 OpenClaw、不修改依赖树。
- 重新生成交付包 `output/deployment/LT-agent-program-deployment-v0.1.34.zip`，310 个 ZIP 条目，SHA-256 `4A71CA0BB13215AF09A4C52248F5A6CB1281DD36040123019944EE4529275BEC`。Windows 包归档静态验收 83/83 通过；功能代码沿用 v0.1.33 已通过的 Debian/Ubuntu 11 阶段、582 项单元测试与 11 项 Mock 验收。v0.1.34 更新了交付说明和风险记录。
- 根 `.gitignore` 增加本机交付输出、Node 编译缓存、OpenClaw 工作区状态、USER 模板和未审核标注草稿排除规则。提交前对拟提交内容做了凭据格式筛查（0 项命中）和 `git diff --check`（通过）。输出包、A/B/C 实验原始结果和 `implement-stage/` 草稿未进入代码提交；这些本机材料仍保留。
- 代码实现提交为 `f3aafa4`，交接状态提交为 `55c0938`；两项提交已推送到 `codex/linux-agent-stack-ci`。2026-10-31 已通过后台 API 创建 [PR #2](https://github.com/xxc0304/LT-agent-program/pull/2)，目标分支为 `main`，目前仍开放且未合并。PR 最新提交 `55c0938` 的 GitHub Actions Linux `verify` 检查通过（run `41201710600`；此前推送也通过 run `41201227758`）。本次仅更新交接记录，推送后会触发新一轮 CI；本地交付包、实验原始结果和 `implement-stage/` 草稿未提交。
