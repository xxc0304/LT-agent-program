# LT-agent-program 项目交接摘要

> 给换设备后的 Codex/协作者：先阅读本文件和根目录 `AGENTS.md`，再开始工作。不要重新研究已经完成的内容，也不要要求用户重复粘贴 API Key。当前工作区的密钥和本地数据均不在 Git 中。

更新时间：2026-09-19

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
- `npm run plugin:validate` 已通过，当前插件清单与六个工具定义一致；
- 当前版本的设备管家测试已通过 50/50，包含温湿度、二值传感器、事件审计和真实 HA 故障回读测试；
- 新增 `src/acceptance.js` 和 `npm run acceptance`，一键验收设备发现、传感器读取、控制后状态验证、场景、开锁拦截、诊断、事件审计和错误返回；当前 9/9 通过；
- Mock 设备扩展为 10 个：灯、空调、窗帘、门锁、温度、湿度、人体感应、门磁、烟雾传感器和智能插座；
- 新增只读 Skill：`agent-workspace/skills/device-status/SKILL.md`；
- 新增真实 Home Assistant REST API 适配层，可通过 `DEVICE_MANAGER_BACKEND=home-assistant` 切换；
- 真实适配层支持实体白名单、Bearer Token、六类实体状态归一化、service 控制映射、控制后回读、场景预检、开锁确认和审计；
- 新增 `npm run ha:check` 只读连通性检查；认证信息只从环境变量读取，不写入仓库；
- 新增 `common-contracts/` 公共契约 v0.1 草案，包含 Device、Event、Task、TaskReceipt、ResourceStatus 和 PolicyDecision Schema、示例与校验脚本；
- 新增设备管家标准任务运行时 `device-manager/src/task-runtime.js`，可用 Mock 任务模拟其他 Agent，返回 `SUCCEEDED`、`FAILED` 或 `CHALLENGE` 回执；
- 新增动作后状态验证和内存事件账本：控制结果必须回读达到目标，否则返回 `POST_ACTION_VERIFICATION_FAILED`；动作成功、动作失败、诊断告警分别记录标准事件，并通过 `get_device_events` 查询；
- 已加入真实 HA 的超时、认证失败、服务成功但状态未改变等故障测试；
- `device-manager/ACCEPTANCE_REPORT.md` 记录本地验收边界；在 `device-manager` 目录执行 `npm run verify` 可一键跑完 50 项测试、9 项 Mock 验收、插件校验和 4 个契约示例校验；
- 已按小组要求将本机全局 OpenClaw 对齐到 `2026.7.1-2`；该版本使用独立配置目录 `%USERPROFILE%\\.openclaw-2026.7.1-2`，旧版 Gateway 已成功加载 device-manager（9 个插件）；
- 目前仍是 Mock HA，不连接真实家具。

### 学习行为分析实验

目录：`learning-behavior/`

- 已建立图片视觉识别脚本和 SCB 评估脚本；
- 视觉模型当前使用：`deepseek-v4-flash-vision-exp`；
- 请求采用 OpenAI 兼容的图片 `data URL`，模型输出被解析为 JSON；
- 支持的第一版行为标签：`reading`、`writing`、`listening`、`raising_hand`、`turning_around`、`standing`、`discussing`；
- 已成功完成单张 SCB 图片识别，模型返回行为、置信度和中文证据；
- 本地代码测试通过 3/3。

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

1. 制作 20～50 张人工复核的小型评估集，逐张修正 `manifest.jsonl` 的真实标签；
2. 扩展评估脚本，计算每类 precision、recall、F1 和平均延迟，不只看 accuracy；
3. 固定模型提示词和输出 JSON 格式，增加“不确定/需要人工复核”状态；
4. 将学习行为识别封装成 OpenClaw Skill/Agent，先输出结构化行为事件；
5. 再由 OpenClaw 编排学习行为 Agent 与设备管家 Agent；
6. 真实设备接入前，先只生成建议动作，不自动控制；确认误报率后再接入灯、音箱等设备。

## 6. 重要约束

- `deepseek-v4-flash-vision-exp` 是实验性视觉模型；V4.1-Flash 当时尚未上线，V4 Pro/普通 Flash 不能直接作为本实验的图片模型；
- 小红书帖子提到的 `cc-switch-model-catalog.json` 是 Codex 前端模型目录，不等于 OpenClaw 或 API 服务配置；本项目学习行为脚本使用环境变量；
- SCB-Dataset 官方说明限制为学术研究、个人学习和非商业使用；不要把原始数据提交仓库；
- 永远不要读取、打印、提交 `.env`、API Key 或其他认证材料；
- `AGENTS.md` 中的 CtxHop 规则优先。如果用户明确要求“同步/上传到另一台电脑/换电脑继续”，先按 CtxHop 流程检查和恢复，再使用本文件。

## 7. 给下一次会话的启动提示

```text
请先阅读项目根目录的 AGENTS.md 和 PROJECT_HANDOFF.md。当前学习行为分析模块已能用 deepseek-v4-flash-vision-exp 成功识别 SCB 图片，设备管家 Agent 已完成 Mock HA、六个 OpenClaw 工具、控制后状态验证和事件审计。不要重新下载完整 SCB 数据集，不要索要或打印 API Key。下一项工作是等待其他组提供真实 HA 联调信息，同时继续用 Mock 编排器验证跨 Agent 事件/Task 链路。
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
