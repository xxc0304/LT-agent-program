import { SCB_LABELS, SCB_PRESENCE_STATES } from "../../learning-behavior/src/vision.js";
import {
  SCENE_ACTIVITY_LABELS,
  SCENE_ORIENTATION_LABELS,
  SCENE_POSTURE_LABELS,
} from "../../learning-behavior/src/scene-evaluation-metrics.js";
import { buildScenePrompt, normalizeScenePrediction } from "../../learning-behavior/src/scene-vision.js";

const CONTRACT_VERSION = "0.1";
const AGENT_ID = "learning-companion";
const ABSENCE_BEHAVIORS = new Set(["leaving_desk", "away_from_desk", "no_occupancy"]);
const ALLOWED_BEHAVIORS = new Set([...SCB_LABELS, ...ABSENCE_BEHAVIORS]);

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function clone(value) {
  return structuredClone(value);
}

function frameTimestamp(frame) {
  const capturedAt = frame?.capturedAt ?? frame?.captured_at;
  return typeof capturedAt === "string" ? Date.parse(capturedAt) : Number.NaN;
}

/**
 * Adapter for the learning-behavior model result.
 * It emits a privacy-aware Event and never controls a device directly.
 */
export class LearningCompanionAgent {
  constructor({
    analyzer = null,
    visionClient = null,
    minConfidence = 0.8,
    minSequenceSamples = 6,
    minSequenceDurationMs = 10 * 60 * 1000,
    maxSequenceGapMs = 2 * 60 * 1000,
    minPresenceConsensus = 0.8,
    clock = () => Date.now(),
  } = {}) {
    if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
      throw new Error("minConfidence 必须是 0 到 1 之间的数字");
    }
    if (!Number.isInteger(minSequenceSamples) || minSequenceSamples < 2) {
      throw new Error("minSequenceSamples 必须至少为 2，避免单帧被当作时间序列");
    }
    if (!Number.isFinite(minSequenceDurationMs) || minSequenceDurationMs < 0) {
      throw new Error("minSequenceDurationMs 必须是非负毫秒数");
    }
    if (!Number.isFinite(maxSequenceGapMs) || maxSequenceGapMs <= 0) {
      throw new Error("maxSequenceGapMs 必须是正毫秒数");
    }
    if (!Number.isFinite(minPresenceConsensus) || minPresenceConsensus <= 0 || minPresenceConsensus > 1) {
      throw new Error("minPresenceConsensus 必须大于 0 且不超过 1");
    }
    this.analyzer = analyzer;
    this.visionClient = visionClient;
    this.minConfidence = minConfidence;
    this.minSequenceSamples = minSequenceSamples;
    this.minSequenceDurationMs = minSequenceDurationMs;
    this.maxSequenceGapMs = maxSequenceGapMs;
    this.minPresenceConsensus = minPresenceConsensus;
    this.clock = clock;
  }

  get id() {
    return AGENT_ID;
  }

  get manifest() {
    return {
      agent_id: AGENT_ID,
      display_name: "学习伴学 Agent",
      version: "0.1",
      capabilities: ["learning_behavior_analysis", "learning_event_production"],
      produces: ["learning_behavior"],
      execution_mode: "edge",
      privacy_level: "restricted",
      direct_device_control: false,
    };
  }

  async analyze(input, options = {}) {
    const raw = this.analyzer ? await this.analyzer(input) : input;
    return this.toEvent(raw, options);
  }

  /**
   * Use the existing learning-behavior vision client and emit the same Event
   * shape as the mock analyzer path. The image itself never enters the Event.
   */
  async analyzeImage(filePath, options = {}) {
    if (!this.visionClient || typeof this.visionClient.analyzeImage !== "function") {
      throw new Error("未配置视觉识别客户端；请传入 visionClient 或使用 analyze() 处理已有模型结果");
    }
    const result = await this.visionClient.analyzeImage(filePath, options.visionOptions ?? {});
    const parsed = result?.parsed ?? {};
    const behavior = result?.predictedLabel ?? parsed.behavior ?? parsed.label;
    return this.toEvent({
      behavior,
      presence: result?.presence ?? parsed.presence,
      confidence: parsed.confidence,
      evidence: parsed.evidence,
      model: result?.model,
      needs_review: true,
      area: options.area,
      duration_ms: 0,
    }, {
      ...options,
      occurred_at: options.captured_at ?? options.capturedAt ?? nowIso(this.clock),
      duration_ms: 0,
      needs_review: true,
    });
  }

  /**
   * Adapt the exploratory classroom-scene schema to a privacy-aware Event.
   * This is a scene observation, not a target-child or occupancy judgment;
   * a single image always requires review and can never establish duration.
   */
  async analyzeSceneImage(filePath, options = {}) {
    if (!this.visionClient || typeof this.visionClient.analyzeImage !== "function") {
      throw new Error("未配置视觉识别客户端；请传入 visionClient");
    }
    const result = await this.visionClient.analyzeImage(filePath, {
      ...(options.visionOptions ?? {}),
      prompt: buildScenePrompt(),
    });
    const prediction = normalizeScenePrediction(result?.parsed ?? {});
    return this.toSceneEvent({ ...prediction, model: result?.model ?? null }, options);
  }

  toSceneEvent(raw, {
    event_id = `evt-learning-scene-${Date.now()}`,
    trace_id = `trace-learning-${event_id}`,
    area,
    occurred_at,
    captured_at,
    capturedAt,
  } = {}) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("课堂场景识别结果必须是 JSON 对象");
    }

    const warnings = Array.isArray(raw.schemaWarnings)
      ? raw.schemaWarnings.filter((item) => typeof item === "string")
      : [];
    const sourceActivities = Array.isArray(raw.activity) ? raw.activity : [];
    const activity = [...new Set(sourceActivities.filter((label) => SCENE_ACTIVITY_LABELS.includes(label)))];
    if (!Array.isArray(raw.activity) || sourceActivities.length === 0) {
      warnings.push("activity 缺失或为空，已保守映射为 unknown。");
    }
    if (activity.length !== sourceActivities.length) {
      warnings.push("activity 含无效标签，已剔除无效项。");
    }
    if (new Set(sourceActivities).size !== sourceActivities.length) {
      warnings.push("activity 含重复标签，已去重。");
    }
    if (activity.includes("unknown") && activity.length > 1) {
      warnings.push("activity 同时含 unknown 与其他标签，已保守映射为 unknown。");
    }
    const safeActivity = activity.length === 0 || (activity.includes("unknown") && activity.length > 1)
      ? ["unknown"]
      : activity;

    const posture = SCENE_POSTURE_LABELS.includes(raw.posture) ? raw.posture : "unknown";
    const orientation = SCENE_ORIENTATION_LABELS.includes(raw.orientation) ? raw.orientation : "unknown";
    if (posture !== raw.posture) warnings.push("posture 缺失或无效，已映射为 unknown。");
    if (orientation !== raw.orientation) warnings.push("orientation 缺失或无效，已映射为 unknown。");

    const validConfidence = Number.isFinite(raw.confidence) && raw.confidence >= 0 && raw.confidence <= 1;
    const confidence = validConfidence ? raw.confidence : 0;
    if (!validConfidence) warnings.push("confidence 缺失或无效，已映射为 0 并要求复核。");
    const evidence = typeof raw.evidence === "string" ? raw.evidence.trim().slice(0, 1000) : "";
    if (!evidence) warnings.push("evidence 缺失，无法复核模型判断依据。");
    const reviewReasons = ["single_frame", "classroom_scene_not_target_child"];
    if (confidence < this.minConfidence) reviewReasons.push("below_min_confidence");
    if (warnings.length > 0) reviewReasons.push("invalid_or_incomplete_model_output");

    const suppliedTimestamp = occurred_at ?? captured_at ?? capturedAt;
    if (suppliedTimestamp !== undefined && (typeof suppliedTimestamp !== "string" || !Number.isFinite(Date.parse(suppliedTimestamp)))) {
      throw new Error("课堂场景 occurred_at/captured_at 必须是有效时间字符串");
    }
    const timestamp = suppliedTimestamp ? new Date(suppliedTimestamp).toISOString() : nowIso(this.clock);

    return {
      schema_version: CONTRACT_VERSION,
      event_id,
      source_agent: AGENT_ID,
      event_type: "learning_behavior",
      occurred_at: timestamp,
      received_at: nowIso(this.clock),
      confidence,
      needs_review: true,
      privacy_level: "restricted",
      data_level: "L3",
      trace_id,
      source: { type: "learning_behavior_model", id: AGENT_ID },
      severity: "info",
      payload: {
        annotation_scope: "classroom_scene",
        target_child_specified: false,
        activity: safeActivity,
        posture,
        orientation,
        presence: "unknown",
        area,
        duration_ms: 0,
        evidence: evidence || null,
        model: typeof raw.model === "string" ? raw.model : null,
        review_reasons: reviewReasons,
        schema_warnings: [...new Set(warnings)],
      },
    };
  }

  /**
   * Analyze timestamped image samples and only mark desk presence as stable
   * when enough high-confidence samples agree across a real observation span
   * without excessive gaps between samples.
   * The image paths remain local and are never copied into the emitted Event.
   */
  async analyzeSequence(frames, options = {}) {
    if (!this.visionClient || typeof this.visionClient.analyzeImage !== "function") {
      throw new Error("未配置视觉识别客户端；无法分析图像序列");
    }
    if (!Array.isArray(frames) || frames.length === 0) {
      throw new Error("图像序列必须至少包含一帧");
    }

    const samples = frames.map((frame, index) => {
      const imagePath = frame?.imagePath ?? frame?.image_path ?? frame?.path;
      const timestamp = frameTimestamp(frame);
      if (typeof imagePath !== "string" || !imagePath) {
        throw new Error(`第 ${index + 1} 帧缺少 imagePath`);
      }
      if (!Number.isFinite(timestamp)) {
        throw new Error(`第 ${index + 1} 帧 capturedAt 必须是有效时间`);
      }
      if (index > 0 && timestamp <= frameTimestamp(frames[index - 1])) {
        throw new Error("图像序列 capturedAt 必须严格按时间递增");
      }
      return { imagePath, timestamp, capturedAt: new Date(timestamp).toISOString() };
    });

    const observations = [];
    for (const sample of samples) {
      const result = await this.visionClient.analyzeImage(sample.imagePath, options.visionOptions ?? {});
      const parsed = result?.parsed ?? {};
      const behavior = result?.predictedLabel ?? parsed.behavior ?? parsed.label;
      if (!ALLOWED_BEHAVIORS.has(behavior)) {
        throw new Error("视觉模型返回了不支持的学习行为标签；该序列不生成学习事件");
      }
      const presenceValue = result?.presence ?? parsed.presence;
      const presence = SCB_PRESENCE_STATES.includes(presenceValue) ? presenceValue : "unknown";
      const confidence = Number.isFinite(parsed.confidence) ? parsed.confidence : 0;
      if (confidence < 0 || confidence > 1) {
        throw new Error("视觉模型 confidence 必须是 0 到 1 之间的数字");
      }
      observations.push({
        behavior,
        presence,
        confidence,
        evidence: typeof parsed.evidence === "string" ? parsed.evidence : "",
        model: result?.model ?? null,
        needsReview: result?.needs_review === true || parsed.needs_review === true,
      });
    }

    const durationMs = samples.at(-1).timestamp - samples[0].timestamp;
    const enoughSamples = samples.length >= this.minSequenceSamples;
    const enoughDuration = durationMs >= this.minSequenceDurationMs;
    const maxObservedGapMs = Math.max(0, ...samples.slice(1).map((sample, index) =>
      sample.timestamp - samples[index].timestamp
    ));
    const gapsWithinLimit = maxObservedGapMs <= this.maxSequenceGapMs;
    const confidentAway = observations.filter((item) =>
      item.presence === "away_from_desk" && item.confidence >= this.minConfidence && !item.needsReview
    );
    const confidentAtDesk = observations.filter((item) =>
      item.presence === "at_desk" && item.confidence >= this.minConfidence && !item.needsReview
    );
    const awayStable = enoughSamples && enoughDuration && gapsWithinLimit
      && confidentAway.length / observations.length >= this.minPresenceConsensus;
    const atDeskStable = enoughSamples && enoughDuration && gapsWithinLimit
      && confidentAtDesk.length / observations.length >= this.minPresenceConsensus;
    const presence = awayStable ? "away_from_desk" : atDeskStable ? "at_desk" : "unknown";
    const stableSamples = awayStable ? confidentAway : atDeskStable ? confidentAtDesk : observations;
    const confidence = Math.min(...stableSamples.map((item) => item.confidence));
    const behaviorCounts = new Map();
    for (const item of observations) {
      behaviorCounts.set(item.behavior, (behaviorCounts.get(item.behavior) ?? 0) + 1);
    }
    const behavior = [...behaviorCounts.entries()]
      .sort((left, right) => right[1] - left[1])[0][0];
    const modelNames = [...new Set(observations.map((item) => item.model).filter(Boolean))];
    const evidence = `观测跨度 ${durationMs}ms，最大帧间隔 ${maxObservedGapMs}ms；离位 ${confidentAway.length}/${observations.length}、在位 ${confidentAtDesk.length}/${observations.length} 个样本达到置信度阈值；结论 ${presence}。`;
    const needsReview = !(awayStable || atDeskStable) || observations.some((item) => item.needsReview);
    const occurredAt = samples.at(-1).capturedAt;

    return this.toEvent({
      behavior,
      presence,
      confidence,
      evidence,
      model: modelNames.length === 1 ? modelNames[0] : modelNames.length > 1 ? modelNames.join(",") : null,
      needs_review: needsReview,
      area: options.area,
      duration_ms: durationMs,
    }, {
      event_id: options.event_id,
      trace_id: options.trace_id,
      area: options.area,
      occurred_at: occurredAt,
      duration_ms: durationMs,
      needs_review: needsReview,
    });
  }

  toEvent(raw, {
    event_id = `evt-learning-${Date.now()}`,
    trace_id = `trace-learning-${event_id}`,
    area = raw?.area,
    duration_ms = raw?.duration_ms ?? raw?.observed_for_ms ?? 0,
    occurred_at = nowIso(this.clock),
    needs_review,
  } = {}) {
    if (!raw || typeof raw !== "object") throw new Error("学习行为模型结果必须是 JSON 对象");
    if (!ALLOWED_BEHAVIORS.has(raw.behavior)) throw new Error("学习行为结果缺少合法 behavior 标签");

    const confidence = Number.isFinite(raw.confidence) ? raw.confidence : 0;
    if (confidence < 0 || confidence > 1) throw new Error("学习行为 confidence 必须在 0 到 1 之间");

    const presence = raw.presence ?? "unknown";
    if (!SCB_PRESENCE_STATES.includes(presence)) {
      throw new Error("学习行为 presence 必须是 at_desk、away_from_desk 或 unknown");
    }
    const observedDurationMs = duration_ms;
    if (!Number.isFinite(observedDurationMs) || observedDurationMs < 0) {
      throw new Error("学习行为 duration_ms 必须是非负毫秒数");
    }

    return {
      schema_version: CONTRACT_VERSION,
      event_id,
      source_agent: AGENT_ID,
      event_type: "learning_behavior",
      occurred_at,
      received_at: nowIso(this.clock),
      confidence,
      needs_review: needs_review ?? raw.needs_review ?? confidence < this.minConfidence,
      privacy_level: "restricted",
      data_level: "L3",
      trace_id,
      source: { type: "learning_behavior_model", id: AGENT_ID },
      severity: "info",
      payload: {
        behavior: raw.behavior,
        presence,
        area,
        duration_ms: observedDurationMs,
        evidence: raw.evidence ?? null,
        model: raw.model ?? null,
      },
    };
  }
}

export const LEARNING_AGENT_ID = AGENT_ID;
