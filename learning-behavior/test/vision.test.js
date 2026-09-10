import test from "node:test";
import assert from "node:assert/strict";

import { buildVisionPrompt, parseModelJson, pickBehavior } from "../src/vision.js";

test("视觉提示词包含 SCB 第一版标签和 JSON 要求", () => {
  const prompt = buildVisionPrompt();
  assert.match(prompt, /reading/);
  assert.match(prompt, /turning_around/);
  assert.match(prompt, /JSON/);
});

test("可以解析普通 JSON 和 Markdown JSON", () => {
  assert.deepEqual(parseModelJson('{"behavior":"reading"}'), { behavior: "reading" });
  assert.deepEqual(parseModelJson('```json\n{"behavior":"writing"}\n```'), { behavior: "writing" });
});

test("只接受预定义的 SCB 行为标签", () => {
  assert.equal(pickBehavior({ behavior: "reading" }), "reading");
  assert.equal(pickBehavior({ behavior: "走神" }), null);
});
