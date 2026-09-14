# LT-agent-program 项目交接摘要

> 给换设备后的 Codex/协作者：先阅读本文件和根目录 `AGENTS.md`，再开始工作。不要重新研究已经完成的内容，也不要要求用户重复粘贴 API Key。当前工作区的密钥和本地数据均不在 Git 中。

更新时间：2026-09-14

## 1. 项目目标

本项目是“家庭微脑”多 Agent 实验。当前已经完成设备管家 Agent 的第一阶段，正在开发学习行为分析 Agent。最终形态是由 OpenClaw 编排多个 Agent：学习行为 Agent 识别孩子的学习状态，设备管家 Agent 负责调用 Home Assistant 设备；两者通过结构化事件连接，不要让视觉识别 Agent 直接控制设备。

## 2. 已完成内容

### 设备管家 Agent

目录：`device-manager/`

- Mock Home Assistant 设备状态与控制；
- `list_devices`、`get_state`、`control_device`、`run_scene`、`diagnose_device`；
- 控制前检查、开锁确认、结果验证和审计日志；
- OpenClaw 插件适配文件 `src/openclaw-plugin.js`；
- 独立 Agent 工作区和启动脚本；
- 当前版本的设备管家测试已通过 19/19，Gateway 端到端验证已完成；
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
请先阅读项目根目录的 AGENTS.md 和 PROJECT_HANDOFF.md。当前学习行为分析模块已能用 deepseek-v4-flash-vision-exp 成功识别 SCB 图片，设备管家 Agent 已完成 Mock HA 和 OpenClaw 工具。不要重新下载完整 SCB 数据集，不要索要或打印 API Key。下一项工作是建立人工复核的 20～50 张评估集并计算可靠指标，然后再设计学习行为 Agent 与设备管家 Agent 的结构化事件接口。
```
