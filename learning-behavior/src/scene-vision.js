import { SCENE_ACTIVITY_LABELS, SCENE_ORIENTATION_LABELS, SCENE_POSTURE_LABELS } from "./scene-evaluation-metrics.js";

export function buildScenePrompt() {
  return [
    "你是课堂场景观察器。请描述整张课堂图片中可见的总体活动，不要猜测未指定的目标儿童。",
    "只根据画面证据判断，不推断注意力、理解程度、学习效果、情绪或孩子身份。",
    `activity 是可多选数组，只能从以下标签选：${SCENE_ACTIVITY_LABELS.join(", ")}。`,
    "同一画面可以同时有多种活动；证据不足时只返回 [\"unknown\"]，不能把 unknown 和其他活动混用。",
    `posture 是单选，只能从以下标签选：${SCENE_POSTURE_LABELS.join(", ")}。多人姿态不同时用 mixed。`,
    `orientation 是单选，只能从以下标签选：${SCENE_ORIENTATION_LABELS.join(", ")}。多人朝向不同时用 mixed，不能确认时用 unknown。`,
    "presenting 表示学生在前方指示、操作或展示学习内容；peer_interaction 需要可见同伴交流线索。",
    "presence 固定返回 unknown，因为本任务没有指定某个目标儿童或家庭书桌区域。",
    "只返回一个 JSON 对象，不要 Markdown、代码围栏或额外解释：",
    '{"activity":["writing"],"posture":"mixed","orientation":"toward_learning_material","presence":"unknown","confidence":0.0,"evidence":"简短描述可见证据"}',
  ].join("\n");
}

export function normalizeScenePrediction(parsed) {
  const warnings = [];
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      activity: [],
      posture: null,
      orientation: null,
      presence: "unknown",
      confidence: null,
      evidence: null,
      schemaWarnings: ["模型输出不是 JSON 对象"],
    };
  }

  let activity;
  if (Array.isArray(parsed.activity)) {
    activity = parsed.activity;
  } else if (typeof parsed.activity === "string") {
    activity = [parsed.activity];
    warnings.push("activity 应为数组；模型返回了单个字符串，已包装成单元素数组。");
  } else {
    activity = [];
    warnings.push("缺少有效的 activity 数组。");
  }
  for (const label of activity) {
    if (!SCENE_ACTIVITY_LABELS.includes(label)) warnings.push(`activity 含无效标签：${String(label)}`);
  }
  if (activity.includes("unknown") && activity.length > 1) {
    warnings.push("activity 同时包含 unknown 与其他标签。");
  }

  const posture = typeof parsed.posture === "string" ? parsed.posture : null;
  const orientation = typeof parsed.orientation === "string" ? parsed.orientation : null;
  if (!SCENE_POSTURE_LABELS.includes(posture)) warnings.push("posture 缺失或标签无效。");
  if (!SCENE_ORIENTATION_LABELS.includes(orientation)) warnings.push("orientation 缺失或标签无效。");

  return {
    activity,
    posture,
    orientation,
    presence: typeof parsed.presence === "string" ? parsed.presence : "unknown",
    confidence: Number.isFinite(parsed.confidence) ? parsed.confidence : null,
    evidence: typeof parsed.evidence === "string" ? parsed.evidence : null,
    schemaWarnings: warnings,
  };
}
