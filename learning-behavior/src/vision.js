import fs from "node:fs/promises";
import path from "node:path";

export const SCB_LABELS = [
  "reading",
  "writing",
  "listening",
  "raising_hand",
  "turning_around",
  "standing",
  "discussing",
];

const MIME_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export function buildVisionPrompt() {
  return [
    "你是课堂学习行为识别器。请只根据图片中可见证据判断行为，不要推测图片之外的事实。",
    `从以下标签中选择一个主要行为：${SCB_LABELS.join(", ")}。`,
    "turning_around 只表示转身或回头，不要直接写成‘走神’。",
    "只返回一个合法 JSON 对象，不要返回 Markdown 或解释文字：",
    '{"behavior":"reading","confidence":0.0,"evidence":"简短可见证据"}',
    "confidence 必须是 0 到 1 之间的小数。",
  ].join("\n");
}

export function mimeTypeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function parseModelJson(text) {
  if (typeof text !== "string") return null;
  const withoutFence = text.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(withoutFence);
  } catch {
    const start = withoutFence.indexOf("{");
    const end = withoutFence.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(withoutFence.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

export function pickBehavior(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed.behavior ?? parsed.label ?? parsed.predicted_label;
  return SCB_LABELS.includes(candidate) ? candidate : null;
}

export async function createDeepSeekVisionClient({
  apiKey = process.env.DEEPSEEK_API_KEY,
  endpoint = process.env.DEEPSEEK_ENDPOINT ?? "https://api.deepseek.com/chat/completions",
  model = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash-vision-exp",
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) throw new Error("缺少 DEEPSEEK_API_KEY；请在当前终端设置，不要把 Key 写入项目文件。");

  return {
    model,
    async analyzeImage(filePath, { prompt = buildVisionPrompt() } = {}) {
      const bytes = await fs.readFile(filePath);
      const dataUrl = `data:${mimeTypeFor(filePath)};base64,${bytes.toString("base64")}`;
      const startedAt = Date.now();
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`视觉接口返回 HTTP ${response.status}：${body.slice(0, 500)}`);
      }
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new Error("视觉接口返回的内容不是合法 JSON。");
      }
      const content = payload.choices?.[0]?.message?.content;
      const text = Array.isArray(content)
        ? content.map((item) => item.text ?? "").join("")
        : String(content ?? "");
      const parsed = parseModelJson(text);
      return {
        model,
        rawText: text,
        parsed,
        predictedLabel: pickBehavior(parsed),
        latencyMs: Date.now() - startedAt,
        usage: payload.usage ?? null,
      };
    },
  };
}
