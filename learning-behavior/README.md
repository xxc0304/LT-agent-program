# 学习行为分析实验（第一阶段）

本目录先完成两个目标：

1. 用 `deepseek-v4-flash-vision-exp` 识别一张图片中的课堂学习行为；
2. 用 SCB-Dataset 的少量图片做批量评估，并和数据集标签比较。

当前只做视觉识别验证，不控制真实设备，也不要求训练模型。

## 支持的第一版标签

- `reading`：阅读
- `writing`：书写
- `listening`：听讲/面向讲解者
- `raising_hand`：举手
- `turning_around`：转身/注意力可能转移
- `standing`：站立
- `discussing`：讨论

`turning_around` 只表示画面中的动作，不直接等价于“走神”。

## 准备 API 配置

不要把 API Key 写入文件。PowerShell 中临时设置：

```powershell
$env:DEEPSEEK_API_KEY = "在这里由你自己输入"
$env:DEEPSEEK_MODEL = "deepseek-v4-flash-vision-exp"
$env:DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions"
```

这是帖子中提到的实验性视觉模型。如果平台给你的 endpoint 或模型 ID 不同，以平台控制台为准。脚本不会打印 Key。

## 单张图片测试

```powershell
cd C:\Users\QVQ\Documents\ChatGPT\LT-agent-program\learning-behavior
node src/evaluate-scb.js --image "C:\path\to\one-scb-image.jpg"
```

脚本会要求模型只返回 JSON，并显示识别标签、置信度和原始模型名。

## SCB 小样本批量评估

SCB-Dataset 的数据下载入口和授权说明见其项目页：
<https://github.com/Whiffe/SCB-dataset>。请只按数据集许可用于课程/科研实验，不要把原始数据提交到 Git 仓库。

先把 SCB 图片放在本地，并建立一个 JSONL 清单，每行一个样本：

```json
{"image":"images/example-001.jpg","label":"reading","id":"example-001"}
```

路径默认相对于清单文件所在目录。示例清单见
`data/scb/manifest.example.jsonl`。运行 20～50 张：

如果数据集目录按行为类别分文件夹，可以自动生成清单：

```powershell
node src/build-manifest.js --root "C:\path\to\SCB-Dataset" --out "C:\path\to\manifest.jsonl"
```

当前项目已经准备了一个本地小样本：`data/scb/manifest.jsonl`，包括阅读和书写两类共375张图片。原始压缩包和图片目录已加入 Git 忽略，不会提交到仓库。

注意：本地小样本来自 SCB 发布页中的“朗读”和“学生板书”压缩包，文件夹名称是数据子集/场景名称，并不保证每一帧都只有对应动作。例如“朗读”子集中可能出现学生书写，“学生板书”子集中也可能出现听讲。因此当前批量结果只能验证接口和定性识别，不能直接作为严格准确率；正式评估需要使用带逐帧行为标注的 SCB 子集，或人工复核后再修正 manifest 标签。

```powershell
node src/evaluate-scb.js --manifest "C:\path\to\manifest.jsonl" --limit 20 --out results\scb-v41-flash.json
```

为了避免只抽到某一个类别，也可以每个标签抽 3 张（最多 21 张）：

```powershell
node src/evaluate-scb.js --manifest "C:\path\to\manifest.jsonl" --per-label 3 --out results\scb-v41-flash.json
```

结果会记录每张图片的真实标签、预测标签、置信度、耗时和错误信息，并汇总准确率、混淆矩阵、每类 precision/recall/F1 和平均耗时。

运行人工复核的 25 张评估集：

```powershell
powershell -ExecutionPolicy Bypass -File .\Run-VerifiedEvaluation.ps1
```

脚本会在本机终端询问 API Key，运行后只输出评估摘要，并在 `data/scb/results/` 保存结果。摘要由 Node.js 读取，避免旧版 PowerShell 的中文 JSON 解析问题。不要把 Key 发到聊天中。

运行前检查文件和标签、不调用模型：

```powershell
node src/evaluate-scb.js --manifest "C:\path\to\manifest.jsonl" --limit 20 --dry-run
```

## 关于视频

第一阶段不直接上传整段视频。后续可以每隔 2～5 秒抽取一帧，复用同一个图片识别接口，再按时间汇总行为次数和持续时间。
