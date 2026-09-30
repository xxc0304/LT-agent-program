# 学习行为场景初标结构审计

日期：2026-09-30
审计对象：`ANNOTATION_FIRST_PASS_DRAFT.jsonl`（25 条）
方式：本地字段审计；没有打开图片、调用模型 API 或上传数据。

## 审计结果

- 25/25 条均为 `classroom_scene`，指定目标儿童样本为 0；因此不能把本表当作目标儿童个体行为真值。
- `annotator_id` 均为 `AI-PRELIM-01`。这是 AI 初标，不是第二位人工标注者；标注者间一致率不可计算，也不构成金标准。
- 活动为多标签，出现次数：`reading` 10、`writing` 17、`raising_hand` 1、`peer_interaction` 4、`presenting` 13。不同活动可共现，计数总和会大于样本数。
- 姿态：`seated` 10、`standing` 1、`mixed` 14。朝向：`toward_learning_material` 11、`toward_instruction_source` 3、`mixed` 11。
- AI 初标置信度：高 11、中 12、低 2；25 条都有证据文字，16 条标记不确定，且不确定项都有说明。
- 结构审计未发现空活动、缺失范围/标注者/证据或无效标签；但“结构完整”不代表标签与图片内容正确。

## 复核状态与解释

独立复核模板目前有 24 个盲化样本行，活动、姿态、朝向、置信度和证据尚未填写。当前没有第二位标注者的完成结果，不能计算任何双人一致率。

审计器已修正两点：会分别识别 AI 的 `scene_annotation_confidence` 与人工的 `reviewer_confidence`；能统计尚未完成模板的空项。新增 `--agreement` 模式可在第二位标注者完成后，按相同样本 ID 逐对计算活动集合、姿态和朝向的一致率；空维度不进入该维度分母，仲裁结果应另行保存。

这些标签只能作为待复核的课堂场景观察草稿。不能用 AI 初标替代人工复核，也不能把它们和旧的单标签模型测试结果直接算成正式准确率。正式模型评估仍需独立复核标签、明确样本范围，并遵守数据集许可。

复现命令：

```powershell
node src/audit-scene-annotations.js --references ANNOTATION_FIRST_PASS_DRAFT.jsonl
node src/audit-scene-annotations.js --references ANNOTATION_REVIEWER_B_TEMPLATE.jsonl
```
