# 学习行为评估集标注规则（讨论稿 v0.1）

状态：供项目组讨论，不是已冻结的公共契约。本文用于改进实验标注，不直接改变当前 `learning_behavior` Event 字段或 Agent 行为。

## 1. 先定义评估对象

家庭伴学场景关注的是**台灯/书桌摄像区域里的目标儿童**，不是整间教室里“多数学生正在做什么”。一张图中有多名学生、无法稳定指定目标儿童时，标为 `target_visible: false` 或 `target_ambiguous: true`，不纳入“单个孩子行为识别”的主准确率；可以单独作为多人场景鲁棒性测试。

SCB-Dataset 的课堂图片可以用于初步验证视觉模型，但与家庭书桌摄像视角不同。报告应明确它是外部课堂场景基准，不能代替家庭摄像头/台灯场景的验证。

## 2. 不再把不同维度硬塞进一个互斥标签

一个孩子可以“站着写字”，也可以“站着听讲”。因此标注拆为相互独立的维度：

| 维度 | 建议标签 | 只记录可见证据 |
|---|---|---|
| `activity` 活动（可多选） | `reading`、`writing`、`raising_hand`、`peer_interaction`、`presenting`、`other`、`unknown` | 例如手持笔接触纸面；不据此推断理解程度、专注程度或学习效果 |
| `posture` 姿态（单选） | `seated`、`standing`、`moving`、`mixed`、`unknown` | 只描述身体姿态；`standing` 不与 `writing` 互斥；课堂场景多人姿态不同时用 `mixed` |
| `orientation` 朝向（单选） | `toward_learning_material`、`toward_instruction_source`、`turned_away`、`mixed`、`unknown` | `turned_away` 只代表可见朝向，不等于走神；课堂场景中方向不一时用 `mixed` |
| `presence` 在位（单选） | `at_desk`、`away_from_desk`、`unknown` | 单张空画面不能证明孩子离开；摄像区域遮挡/目标无法确定时用 `unknown` |

`listening` 是心理/注意状态，静态图像通常只能看到朝向，不能证明孩子确实在听；实验标注优先使用 `orientation: toward_instruction_source`。如需保留旧标签 `listening`，只能把它定义成这个可见代理标签，并在报告中说明它不代表理解或注意力。

`discussing` 也不能只凭多人同框判断。只有画面中能看到明确的同伴交互线索（如相互朝向、交谈/手势互动）才标 `peer_interaction`；证据不足就标 `unknown`，不能从“课堂场景”推断正在讨论。

## 3. 单张图和时间序列分别标注

- 单帧的 `activity`、`posture`、`orientation` 是拍摄瞬间的观察，不代表行为持续多久。
- 单帧若未看到目标儿童，`presence` 标 `unknown`，不能直接标离开。
- `away_from_desk` 需要固定摄像视野、目标/区域定义清楚，并在真实时间序列中连续观察；持续时长只按采集时间戳计算。
- 遮挡、模糊、远小目标、画面中目标冲突或多项活动难以分辨时，允许弃答，禁止为凑标签猜测。
- 不标注“走神、懒惰、厌学、情绪异常、理解/掌握”等静态图片无法客观证明的心理结论。

## 4. 标注流程和质量控制

1. 在看模型预测前，标注者先独立标记目标是否可定位、可见性、各维度标签和可见证据，避免被模型答案带偏。
2. 每个样本至少由两人独立标注；分歧交第三人仲裁。保存原始两份标签和仲裁结果，不只保留最终答案。
3. 对每个标签写清正例/反例和“不确定”案例。特别复核“站立+书写”“讨论+听讲”等多活动样本。
4. 报告逐维度的每类 Precision/Recall/F1、弃答率、混淆/共现情况以及标注者一致性；多标签活动不能只报一个整体准确率。
5. 划分训练/调参/测试集时按课堂、来源场景或采集会话分组，避免同一场景的近似帧跨集合。测试集不能参与提示词/阈值选择。
6. 数据许可、儿童隐私审批和最小化留存先于模型调用；评估原图不提交到 Git，也不把图像、可识别信息放进跨 Agent Event。

## 5. 建议的评估清单字段

这是评估数据的建议格式，不是 Agent Event。单个目标孩子样本使用 `annotation_scope: "target_student"`；多人课堂图没有指定目标孩子时，使用 `annotation_scope: "classroom_scene"`，目标相关字段填 `unknown`，不得把全班多数人的状态当成目标孩子的真值：

```json
{
  "id": "sample-001",
  "image": "images/sample-001.jpg",
  "source_group": "classroom-a",
  "annotation_scope": "target_student",
  "target_visible": true,
  "target_ambiguous": false,
  "activity": ["writing"],
  "posture": "standing",
  "orientation": "toward_learning_material",
  "presence": "at_desk",
  "evidence": "目标儿童站立，手持笔在纸面书写",
  "uncertain": false,
  "annotator_id": "A01"
}
```

课堂场景级标注的 `target_visible` 取 `true | false | "unknown"`；未指定目标孩子时必须是 `"unknown"`，`target_ambiguous` 设为 `true`，`presence` 设为 `"unknown"`。此时 `activity`、`posture`、`orientation` 描述画面中可见的课堂整体情况，允许多活动、`mixed` 和 `unknown`。不能把这类样本混入目标孩子个体识别准确率。

`ANNOTATION_FIRST_PASS_DRAFT.jsonl` 是基于画面的 AI 单人初标草稿，不是双人独立人工标注，也不是新真值；初标过程已知旧标签/模型评估背景，不具备盲标条件。只供人工复核和完善口径使用，未完成两人独立复核与分歧仲裁前不得用于正式重算准确率。已知精确重复图片及疑似相邻帧应在拆分和计分时按组处理。

多标注者清单可以每位标注者一行，仲裁结果另存，避免覆盖分歧。`annotator_id` 使用匿名编号，不写姓名；清单不应包含儿童姓名、学号或其他身份信息。

## 6. 旧标签迁移建议

| 旧 SCB 标签 | 新维度建议 | 注意事项 |
|---|---|---|
| `reading` | `activity: reading` | 需要可见阅读材料/阅读姿态证据 |
| `writing` | `activity: writing` | 可与 `posture: standing` 同时成立 |
| `listening` | `orientation: toward_instruction_source` | 不能声称已证明注意或理解 |
| `raising_hand` | `activity: raising_hand` | 若手部被遮挡则 `unknown` |
| `turning_around` | `orientation: turned_away` | 不等于走神 |
| `standing` | `posture: standing` | 不应与活动类别互斥 |
| `discussing` | `activity: peer_interaction` | 需要具体交互证据；不能仅由课堂/多人同框推断 |

在项目组确认新标注方案前，旧 `manifest-verified.jsonl` 和旧模型结果保留作为历史基线，不要静默改标签或把新旧指标直接横向比较。
