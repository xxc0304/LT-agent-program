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

结果会记录每张图片的真实标签、预测标签、在位判断、置信度、耗时和错误信息，并汇总总体准确率、已接受预测准确率、覆盖率、弃答数、接口错误数、混淆矩阵、每类 precision/recall/F1 和平均耗时。总体 `accuracy` 分母包含弃答和接口错误，不会只对成功返回合法标签的样本报准确率；`acceptedAccuracy` 单独表示模型作出有效预测时的准确率。

已有 25 张人工核验样本的离线复盘见 [EVALUATION_REVIEW.md](./EVALUATION_REVIEW.md)。现有结果约 48% 准确率，且类别与场景来源及标签重叠可能影响结论；在重新明确标签口径并建立独立测试集前，不应将其作为模型最终能力指标或自动控制依据。

为解决“站着写字”等多标签/维度混淆，已有[学习行为标注规则讨论稿](./ANNOTATION_GUIDELINES_DRAFT.md)及根据试测分歧补充的[标签边界讨论稿 v0.2](./ANNOTATION_DISAMBIGUATION_DRAFT_v0.2.md)。两份均需项目组确认后才能作为统一口径；当前旧清单和结果保留为历史基线。v0.2 基于已看过模型输出的试测样本，不应再用同一批样本调参后宣称新的独立测试成绩。

25 张已核验样本的课堂场景级视觉初标另存为[初标待复核草稿](./ANNOTATION_FIRST_PASS_DRAFT.jsonl)。它不是双人独立标注或新真值，目标孩子字段保持未知；完成人工复核、第二人独立标注和仲裁前，不得用它重算正式准确率。精确重复图与疑似近似帧已标注关系，统计时须去重/分组。

第二位标注者使用[盲化复核说明](./ANNOTATION_SECOND_REVIEW_GUIDE.md)和[空白复核模板](./ANNOTATION_REVIEWER_B_TEMPLATE.jsonl)。本机的盲化图片副本及编号映射留在 Git 忽略目录 `data/scb/blind-review/`，请只把模板和盲化图片交给复核者，不要把本机映射或第一轮初标一起发给对方。

本机已有一份由项目成员本人填写的 24 张场景级复核候选集，位于被 Git 忽略的 `data/scb/blind-review/ANNOTATION_USER_REVIEWED_DRAFT_LOCAL_ONLY.jsonl`。它是本人复核的暂定标签，不是第二位标注者的独立盲标，也不是仲裁后的金标准；所有样本都是课堂整体场景，不表示某个目标孩子。原始 Excel 不会被脚本改写。候选 JSONL 保留了原始活动字段、证据、不确定原因和质量提示。

检查候选标签和对应图片是否可用，不调用模型：

```powershell
node src/evaluate-scene.js --references data/scb/blind-review/ANNOTATION_USER_REVIEWED_DRAFT_LOCAL_ONLY.jsonl --validate-only
```

如需调用视觉模型，必须明确选定图片编号；脚本会把所选图片发送到已配置的第三方模型 API，并默认拒绝覆盖已有预测文件：

```powershell
node src/predict-scene.js --references data/scb/blind-review/ANNOTATION_USER_REVIEWED_DRAFT_LOCAL_ONLY.jsonl --ids blind-002,blind-003,blind-005,blind-007,blind-015 --out data/scb/results/scene-pilot-predictions.jsonl
```

2026-09-27 的 5 张场景级试测结果见[试测复盘](./SCENE_PILOT_REVIEW_2026-09-27.md)。

新的场景评估路径与旧单标签评估分开。它按 `activity` 多标签计算 micro/macro F1 和完全匹配率，并分别计算 `posture`、`orientation` 准确率。只统计预测文件中有记录的样本；已请求但失败/无有效标签的行按弃答保留在分母中，未运行的样本另行计数，不会冒充模型弃答。模型预测文件需为 JSONL，每行含 `id`、`activity` 数组、`posture` 和 `orientation`，例如 `{"id":"blind-001","activity":["writing","presenting"],"posture":"standing","orientation":"toward_learning_material"}`。准备好离线预测后，可这样比较：

```powershell
node src/evaluate-scene.js --references data/scb/blind-review/ANNOTATION_USER_REVIEWED_DRAFT_LOCAL_ONLY.jsonl --predictions data/scb/results/scene-predictions.jsonl --out data/scb/results/scene-evaluation.json
```

当前旧视觉接口仍输出单个 SCB 行为标签，不能直接拿来和这份多维标注比较；需要先明确新模型输出格式，再生成预测文件。最新复核表已修正之前发现的活动标签和不确定性填写问题，候选集已重新生成并通过标签/图片路径校验；这不改变其“单人复核暂定标签”的性质。

可以运行本地单人标注质量审计（不调用模型、不上传图片）：

```powershell
cd C:\Users\QVQ\Documents\ChatGPT\LT-agent-program\learning-behavior
npm test
node src/audit-scene-annotations.js --references data/scb/blind-review/ANNOTATION_USER_REVIEWED_DRAFT_LOCAL_ONLY.jsonl --out data/scb/results/solo-annotation-audit.json
```

审计报告统计标签覆盖、活动组合、空活动项，以及范围/标注者/置信度/证据/不确定性字段完整度，并明确标注者间一致性是否可计算。审计器分别统计人工 `reviewer_confidence` 与 AI 初标 `scene_annotation_confidence`，不会把 AI 初标置信度误报成缺失；空的活动/姿态/朝向字段可以作为“尚未填写”检查，但无效的非空标签仍会报错。正式预测评估仍采用严格校验。它只能检查结构和填写完整度，不能自动判断标签是否符合图片内容；单人标注不能称作双人金标准。报告保存在本机 Git 忽略的 `data/scb/results/` 目录。

2026-09-30 的 AI 初标字段审计摘要见[初标审计记录](./ANNOTATION_FIRST_PASS_AUDIT_2026-09-30.md)。

双人/多人独立复核完成后，可把各标注者结果合并成“一张图、每位标注者各一行”的 JSONL（`id` 相同、`annotator_id` 不同），再只读计算重叠样本上的逐对精确一致率：

```powershell
node src/audit-scene-annotations.js --references data/scb/blind-review/independent-reviewers.jsonl --agreement --out data/scb/results/inter-annotator-agreement.json
```

该报告分别比较多标签活动（活动集合完全一致）、姿态和朝向；空字段不纳入该维度一致率的分母，并报告缺失比较数。多于两位标注者时结果是逐对一致率，不是独立样本统计或 Cohen/Fleiss κ；第三人仲裁结果应另存，不能混入独立标注行。

可以用 `--min-confidence 0.8` 做选择性预测评估：低于阈值的模型输出保留在 `predictedLabel` 中，但其 `acceptedLabel` 记为空并作为弃答计入总体指标。阈值应在实验报告中注明，不能只看已接受样本的准确率而忽略覆盖率。默认阈值为 `0`，即不按置信度过滤。

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

注意：单张图片只代表单帧观察，不能证明行为持续多久；接入节能链路时会强制标记为人工复核且 `duration_ms` 为 0。多帧自动判断必须使用本次采样的真实时间戳；默认至少 6 帧、总跨度不少于 10 分钟、相邻帧最多间隔 2 分钟，并通过高置信度一致性检查。不要用手工填写的持续时间或过期示例时间触发设备控制。
