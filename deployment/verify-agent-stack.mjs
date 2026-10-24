#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skipDemos = process.argv.includes("--skip-demos");
const node = process.execPath;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const failures = [];
let passed = 0;

function run(name, cwd, command, args) {
  console.log(`\n=== ${name} ===`);
  const onWindowsNpm = process.platform === "win32" && command === npm;
  const executable = onWindowsNpm ? "cmd.exe" : command;
  const executableArgs = onWindowsNpm ? ["/d", "/s", "/c", [command, ...args].join(" ")] : args;
  const result = spawnSync(executable, executableArgs, {
    cwd,
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });
  if (result.error) {
    console.error(`${name}: ${result.error.message}`);
    failures.push(`${name} (could not start)`);
    return;
  }
  if (result.status === 0) {
    passed += 1;
    console.log(`PASS: ${name}`);
    return;
  }
  const code = result.status ?? `signal ${result.signal ?? "unknown"}`;
  failures.push(`${name} (exit ${code})`);
  console.error(`FAIL: ${name} (${code})`);
}

if (Number(process.versions.node.split(".")[0]) < 20) {
  console.error(`Node.js ${process.version} found; Node.js 20 or newer is required.`);
  process.exit(2);
}

const deviceManagerDir = resolve(repoRoot, "device-manager");
const hostSdkProbe = spawnSync(node, [
  "--input-type=module",
  "-e",
  "import('openclaw/plugin-sdk/session-visibility').then(()=>process.exit(0)).catch(()=>process.exit(1))",
], { cwd: deviceManagerDir, stdio: "ignore", windowsHide: true });

const hostSdkOnlyTests = new Set([
  "energy-operations-tools.test.js",
  "maintenance-reminders.test.js",
  "mock-maintenance-reminder-tool.test.js",
  "openclaw-agent-transport.test.js",
  "openclaw-memory-runtime.test.js",
  "openclaw-routine-notifications.test.js",
]);

const deviceManagerTests = readdirSync(resolve(deviceManagerDir, "test"))
  .filter((name) => name.endsWith(".test.js"))
  .filter((name) => hostSdkProbe.status === 0 || !hostSdkOnlyTests.has(name))
  .map((name) => resolve(deviceManagerDir, "test", name));

if (hostSdkProbe.status !== 0) {
  console.warn("OpenClaw plugin SDK is not installed; only the six host-SDK adapter test files are skipped.");
}

const steps = [
  ["Linux installer safety and injected-CLI tests", repoRoot, node, ["--test", "deployment/install-agent-stack.test.mjs"]],
  ["Common contract compatibility tests", repoRoot, node, ["--test", "common-contracts/test/task-compat.test.mjs"]],
  ["Common contract example validation", repoRoot, node, ["common-contracts/validate-examples.mjs"]],
  ["Device manager unit tests", deviceManagerDir, node, ["--test", ...deviceManagerTests]],
  ["Device manager Mock acceptance", deviceManagerDir, npm, ["run", "acceptance"]],
  ["Energy Agent unit tests", resolve(repoRoot, "energy-saving"), npm, ["test"]],
  ["Learning behavior unit tests", resolve(repoRoot, "learning-behavior"), npm, ["test"]],
  ["Household memory unit tests", resolve(repoRoot, "agent-memory"), npm, ["test"]],
  ["Multi-Agent orchestrator unit tests", resolve(repoRoot, "multi-agent-orchestrator"), npm, ["test"]],
];

if (!skipDemos) {
  steps.push(
    ["Energy Agent Mock demo", resolve(repoRoot, "energy-saving"), npm, ["run", "demo"]],
    ["Multi-Agent to Mock HA end-to-end demo", resolve(repoRoot, "multi-agent-orchestrator"), npm, ["run", "demo"]],
  );
}

console.log(`Linux-first Agent stack verification (local/Mock only; Node.js ${process.version})`);
console.log(`Repository: ${repoRoot}`);

for (const [name, cwd, command, args] of steps) run(name, cwd, command, args);

console.log(`\n=== Summary ===\nPassed: ${passed} / ${passed + failures.length}`);
if (failures.length > 0) {
  console.error("Failed checks:");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error("This suite does not verify a live OpenClaw Gateway, Home Assistant, model behavior, or physical appliances.");
  process.exit(1);
}

console.log("All selected local/Mock checks passed.");
console.log("This does not verify a live OpenClaw Gateway, Home Assistant, model behavior, or physical appliances.");
