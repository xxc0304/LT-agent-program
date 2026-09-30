---
name: learning-behavior-review
description: 根据已配置视觉模块返回的结果，形成谨慎、可复核的学习行为观察和标准事件；不具备视觉工具时不得假装看过图片。
user-invocable: true
---

# 儿童学习行为观察与复核

本 Skill 用于解释和整理学习行为识别结果。识图能力来自 `learning-behavior/src/vision.js` 配置的视觉客户端；**本工作区模板本身没有图片识别工具**。只有在当前运行时明确提供视觉结果后才能分析图片，不得根据图片路径、聊天文字或想象声称看到了画面。

## 行为标签与证据

第一版行为类别为 `reading`、`writing`、`listening`、`raising_hand`、`turning_around`、`standing`、`discussing`。在位状态单独使用 `at_desk`、`away_from_desk`、`unknown`。

课堂整体场景试验使用独立字段：`annotation_scope: "classroom_scene"`、`activity` 多标签数组、`posture` 和 `orientation`。没有指定目标孩子时，必须将 `target_child_specified` 设为 `false`、`presence` 设为 `unknown`；不得把全班多数人的状态写成某个孩子的行为。

- 只复述图像/视觉模块实际提供的可见证据；不推断成绩、情绪、动机、是否“认真”或是否“走神”。
- `turning_around` 只表示转身/回头；`standing` 只表示站立，二者都不等于离开书桌。
- 单帧不能证明行为持续时间、长期习惯或已经离开。没有时间序列输入时，`duration_ms` 不得凭空填写；持续行为必须由上游多帧/传感器聚合器提供。
- 结果缺失、遮挡、类别无法区分或置信度缺失时，应弃答/请求人工复核，不要硬选标签。当前默认复核阈值为 0.8，但模型置信度未经校准，不能视作真实概率。

## 事件输出与隐私

只有接收端明确要求标准 Event 且已有合格识别结果时，才输出 `learning_behavior` Event。保留 `trace_id`、置信度、`needs_review` 和简短证据；按当前适配器使用 `privacy_level: "restricted"`、`data_level: "L3"`。不将原始图片、视频帧、API Key 或不必要的儿童身份信息放入 Event、日志或跨 Agent 消息。

当置信度低于阈值、需要复核或只有单帧不足以支撑时间性判断时，设置 `needs_review: true`。未确认的学习判断只供复核，不能直接触发设备动作；学习伴学 Agent 不调用灯、插座、空调、窗帘或门锁工具。

课堂整体单帧观察必须使用 `duration_ms: 0` 并要求复核。即使其模型结果意外包含 `away_from_desk` 或长持续时间，也不得将 `annotation_scope: "classroom_scene"` 事件用作节能触发信号。

## 回复和交接

明确区分“模型识别结果”“人工复核结果”和“持续时间证据”。如果要把事件交给节能 Agent，必须同时满足其离开/无人信号、置信度和持续时间规则；单纯阅读、书写、站立或转身应交由下游规则忽略。跨组公共字段尚未冻结，使用本地 v0.1 适配器时不要宣称协议已最终确定。
