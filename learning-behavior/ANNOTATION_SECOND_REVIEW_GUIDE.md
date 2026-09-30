# 第二位标注者：独立复核说明

用途：在不查看第一轮 AI 初标、旧标签和模型预测的情况下，对抽样图片做独立课堂场景级标注。该文件是复核操作说明，不是最终标注标准；标签口径以 `ANNOTATION_GUIDELINES_DRAFT.md` 为准。

## 请先遵守

1. 只打开 `ANNOTATION_REVIEWER_B_TEMPLATE.jsonl` 中给出的盲化图片，不要查看 `ANNOTATION_FIRST_PASS_DRAFT.jsonl`、`manifest-verified.jsonl`、`EVALUATION_REVIEW.md` 或模型结果。
2. 每张图独立填写活动、姿态、朝向、可见证据和不确定性；不要与第一位标注者讨论具体图片答案。
3. 这里没有指定家庭场景中的单个目标孩子。`target_visible`、`target_ambiguous`、`presence` 已按课堂场景口径预填；请不要把全班多数行为当成某个孩子的个体真值。
4. 允许多选活动；姿态/朝向可填 `mixed` 或 `unknown`。证据不足时弃答，不要推断走神、理解程度或学习效果。
5. 请把完成后的模板另存为独立结果，保留原始模板，不要覆盖第一轮初标文件。复核未完成前不要据此重算准确率。

## 可填标签

- `activity`: `reading`、`writing`、`raising_hand`、`peer_interaction`、`presenting`、`other`、`unknown`，可多选。
- `posture`: `seated`、`standing`、`moving`、`mixed`、`unknown`。
- `orientation`: `toward_learning_material`、`toward_instruction_source`、`turned_away`、`mixed`、`unknown`。
- `reviewer_confidence`: `high`、`medium`、`low`。
- `evidence`: 只描述直接可见动作，例如“手持笔接触纸面”；避免心理状态结论。

盲化模板包含 24 张匿名编号的图片。请逐张独立判断，不要尝试根据文件顺序或编号推测类别。
