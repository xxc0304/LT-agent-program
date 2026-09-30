import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const skills = [
  {
    name: "device-status",
    file: "device-manager/agent-workspace/skills/device-status/SKILL.md",
    required: ["list_devices", "get_state"],
  },
  {
    name: "device-control",
    file: "device-manager/agent-workspace/skills/device-control/SKILL.md",
    required: [
      "control_device",
      "confirmed: true",
      "get_state",
      "unlock",
      "不得自行拼成实体 ID",
      "澄清用户是指物理开门、解锁门锁还是其他动作",
      "自动化请求不是当前控制指令",
      "不得猜测实体 ID",
      "不得静默返回 `NO_REPLY` 或空内容",
    ],
  },
  {
    name: "scene-control",
    file: "device-manager/agent-workspace/skills/scene-control/SKILL.md",
    required: ["plan_scene", "execute_scene_plan", "confirmation_phrase", "confirmed", "绝不控制设备", "home", "sleep", "away"],
  },
  {
    name: "fault-diagnosis",
    file: "device-manager/agent-workspace/skills/fault-diagnosis/SKILL.md",
    required: ["diagnose_device", "get_device_events"],
  },
  {
    name: "household-preferences",
    file: "device-manager/agent-workspace/skills/household-preferences/SKILL.md",
    required: ["get_household_preference", "remember_household_preference", "confirm_household_memory_candidate", "forget_household_memory"],
  },
  {
    name: "energy-planning",
    file: "openclaw-agents/energy-saving/skills/energy-planning/SKILL.md",
    required: ["occupancy_changed", "learning_behavior", "device_action", "device-manager"],
  },
  {
    name: "learning-behavior-review",
    file: "openclaw-agents/learning-companion/skills/learning-behavior-review/SKILL.md",
    required: ["reading", "standing", "away_from_desk", "needs_review", "restricted", "L3"],
  },
];

test("项目中的 Agent Skills 均有有效的 OpenClaw Skill 元数据和关键安全流程", async () => {
  for (const skill of skills) {
    const absolutePath = path.join(repoRoot, skill.file);
    const contents = await fs.readFile(absolutePath, "utf8");
    const frontmatter = contents.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    assert.ok(frontmatter, `${skill.file} 缺少 YAML frontmatter`);
    assert.match(frontmatter[1], new RegExp(`^name:\\s*${skill.name}$`, "m"));
    assert.match(frontmatter[1], /^description:\s*\S.+$/m);
    assert.match(frontmatter[1], /^user-invocable:\s*true$/m);

    const body = contents.slice(frontmatter[0].length);
    for (const phrase of skill.required) {
      assert.ok(body.includes(phrase), `${skill.name} 缺少关键内容：${phrase}`);
    }
  }
});

test("设备管家全局规则要求核实实体、澄清开门歧义并始终回复", async () => {
  const rules = await fs.readFile(
    path.join(repoRoot, "device-manager/agent-workspace/AGENTS.md"),
    "utf8",
  );
  for (const phrase of [
    "只可使用工具返回的 ID",
    "等同于 `unlock`",
    "自动化、定时或未来触发请求不是即时控制指令",
    "不得以 `NO_REPLY` 或空内容结束",
  ]) {
    assert.ok(rules.includes(phrase), `设备管家全局规则缺少：${phrase}`);
  }
});
