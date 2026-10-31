import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { comparablePath, runInstaller } from "./install-agent-stack.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

test("path identity follows filesystem case rules for Linux and Windows", () => {
  assert.notEqual(comparablePath("/srv/OpenClaw/plugins"), comparablePath("/srv/openclaw/plugins"));
  assert.equal(comparablePath("C:\\OpenClaw\\plugins"), comparablePath("c:/openclaw/PLUGINS/"));
});

async function withProfile(run) {
  const dir = await mkdtemp(join(tmpdir(), "lt-agent-linux-installer-"));
  const configPath = join(dir, "openclaw.json");
  await writeFile(configPath, "{}\n", "utf8");
  try { await run({ dir, configPath }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

function fakeOpenClaw(configPath, log = []) {
  return (command, args, options = {}) => {
    log.push({ command, args, cwd: options.cwd });
    if (command === "npm" && args.join(" ") === "--version") return { status: 0, stdout: "10.8.2\n" };
    if (args.join(" ") === "--version") return { status: 0, stdout: "OpenClaw 2026.7.1-2\n" };
    if (args.join(" ") === "config file") return { status: 0, stdout: `Config file: ${configPath}\n` };
    if (args.join(" ") === "config validate") return { status: 0, stdout: "valid\n" };
    if (args.join(" ") === "agents list --json") return { status: 0, stdout: JSON.stringify([{ id: "main", isDefault: true }]) };
    if (args.join(" ") === "plugins list --verbose --json") return { status: 0, stdout: "[]" };
    if (args[0] === "config" && args[1] === "get") return { status: 1, stdout: "" };
    return { status: 1, stdout: "", stderr: "unexpected mock command" };
  };
}

function fakeApplyRunner(configPath, log = [], { failOn } = {}) {
  const projectAgents = [
    { id: "main", tools: {} },
    { id: "device-manager", tools: {} },
    { id: "energy-saving", tools: {} },
    { id: "learning-companion", tools: {} },
  ];
  let agentConfigReads = 0;
  return (command, args, options = {}) => {
    const call = { command, args, cwd: options.cwd };
    log.push(call);
    const joined = args.join(" ");
    if (joined === "--version") return { status: 0, stdout: "OpenClaw 2026.7.1-2\n" };
    if (joined === "config file") return { status: 0, stdout: `Config file: ${configPath}\n` };
    if (joined === "config validate") return { status: 0, stdout: "valid\n" };
    if (joined === "agents list --json") return { status: 0, stdout: JSON.stringify([{ id: "main", isDefault: true }]) };
    if (joined === "plugins list --verbose --json") return { status: 0, stdout: "[]" };
    if (args[0] === "config" && args[1] === "get") {
      const setting = args[3];
      if (setting === "agents.list") {
        agentConfigReads += 1;
        if (agentConfigReads > 1) return { status: 0, stdout: JSON.stringify(projectAgents) };
      }
      return { status: 1, stdout: "" };
    }
    if (command === "npm") {
      if (failOn === "npm" && args.includes("install")) return { status: 1, stdout: "", stderr: "mock npm failure" };
      return { status: 0, stdout: "mock npm ok" };
    }
    if (args[0] === "config" && args[1] === "set") return { status: 0, stdout: "config set ok" };
    if (args[0] === "plugins" || args[0] === "agents") return { status: 0, stdout: "OpenClaw operation ok" };
    return { status: 1, stdout: "", stderr: "unexpected mock command" };
  };
}

test("default run is read-only and writes a JSON plan artifact when requested", async () => {
  await withProfile(async ({ dir, configPath }) => {
    const artifactPath = join(dir, "plan.json");
    const calls = [];
    const plan = await runInstaller({
      repoRoot: packageRoot,
      commandRunner: fakeOpenClaw(configPath, calls),
      outputPath: artifactPath,
    });

    assert.equal(plan.mode, "plan-only");
    assert.equal(plan.npmVersion, "10.8.2");
    assert.equal(plan.frontdoorAgentId, "main");
    assert.equal(plan.safety.profileMutations, false);
    assert.equal(plan.safety.packageInstallation, false);
    assert.equal(plan.safety.gatewayRestart, false);
    assert.equal(JSON.parse(await readFile(artifactPath, "utf8")).frontdoorAgentId, "main");
    assert.equal(calls[0].args.join(" "), "--version");
    assert.ok(calls.some(({ args }) => args.join(" ") === "plugins list --verbose --json"));
    assert.ok(calls.every(({ args }) => !(args[0] === "config" && args[1] === "set")));
    assert.deepEqual(plan.createAgents, ["device-manager", "energy-saving", "learning-companion"]);
    assert.equal(plan.mainChatOrchestrationTool, "orchestrate_household_agents");
  });
});

test("a plugin registered from a different source is rejected before writes", async () => {
  await withProfile(async ({ configPath }) => {
    const calls = [];
    const runner = fakeOpenClaw(configPath, calls);
    const base = runner;
    const wrapped = (command, args, options) => {
      if (args.join(" ") === "plugins list --verbose --json") {
        calls.push({ command, args });
        return { status: 0, stdout: JSON.stringify([{ id: "device-manager", resolvedPath: "C:/unrelated/device-manager" }]) };
      }
      return base(command, args, options);
    };
    await assert.rejects(runInstaller({ repoRoot: packageRoot, commandRunner: wrapped }), /different device-manager plugin/);
    assert.ok(calls.every(({ args }) => !(args[0] === "config" && args[1] === "set")));
    assert.ok(calls.every(({ args }) => args[0] !== "agents" || args[1] !== "add"));
  });
});

test("existing plugin rows keyed by name are recognized when their source matches", async () => {
  await withProfile(async ({ configPath }) => {
    const base = fakeOpenClaw(configPath);
    const runner = (command, args, options) => {
      if (args.join(" ") === "plugins list --verbose --json") {
        return { status: 0, stdout: JSON.stringify([{ name: "device-manager", sourcePath: join(packageRoot, "device-manager") }]) };
      }
      return base(command, args, options);
    };
    const plan = await runInstaller({ repoRoot: packageRoot, commandRunner: runner });
    assert.equal(plan.existingPlugins["device-manager"], true);
    assert.equal(plan.existingPlugins["platform-orchestrator"], false);
  });
});

test("an unexpected existing Agent-to-Agent allow entry is not broadened", async () => {
  await withProfile(async ({ configPath }) => {
    const calls = [];
    const base = fakeOpenClaw(configPath, calls);
    const runner = (command, args, options) => {
      if (args.join(" ") === "config get --json tools.agentToAgent") {
        calls.push({ command, args });
        return { status: 0, stdout: JSON.stringify({ allow: ["unrelated-agent"] }) };
      }
      return base(command, args, options);
    };
    await assert.rejects(runInstaller({ repoRoot: packageRoot, commandRunner: runner }), /will not broaden that shared policy/);
    assert.ok(calls.every(({ args }) => !(args[0] === "config" && args[1] === "set")));
  });
});

test("global session visibility is not expanded when an unrelated Agent lacks session-tool denial", async () => {
  await withProfile(async ({ configPath }) => {
    const calls = [];
    const base = fakeOpenClaw(configPath, calls);
    const runner = (command, args, options) => {
      if (args.join(" ") === "agents list --json") {
        calls.push({ command, args });
        return { status: 0, stdout: JSON.stringify([{ id: "main", isDefault: true }, { id: "guest" }]) };
      }
      if (args.join(" ") === "config get --json tools.sessions.visibility") {
        calls.push({ command, args });
        return { status: 0, stdout: JSON.stringify("tree") };
      }
      if (args.join(" ") === "config get --json agents.list") {
        calls.push({ command, args });
        return { status: 0, stdout: JSON.stringify([{ id: "guest", tools: { deny: ["sessions_list"] } }]) };
      }
      return base(command, args, options);
    };
    await assert.rejects(runInstaller({ repoRoot: packageRoot, commandRunner: runner }), /global expansion/);
    assert.ok(calls.every(({ args }) => !(args[0] === "config" && args[1] === "set")));
  });
});

test("apply requires exact confirmation and creates no backup when cancelled", async () => {
  await withProfile(async ({ dir, configPath }) => {
    const calls = [];
    const result = await runInstaller({
      repoRoot: packageRoot,
      commandRunner: fakeApplyRunner(configPath, calls),
      apply: true,
      confirmInstall: async () => "install",
    });
    assert.equal(result.mode, "cancelled");
    assert.deepEqual(await readdir(dir), ["openclaw.json"]);
    assert.ok(calls.every(({ command, args }) => !(command === "npm" && args.includes("install")) && !(args[0] === "config" && args[1] === "set")));
  });
});

test("npm availability is checked before the active profile is read or backed up", async () => {
  await withProfile(async ({ dir, configPath }) => {
    const calls = [];
    const runner = (command, args) => {
      calls.push({ command, args });
      return { status: command === "npm" ? 127 : 0, stdout: "", stderr: "not installed" };
    };
    await assert.rejects(runInstaller({ repoRoot: packageRoot, commandRunner: runner, apply: true }), /Checking npm availability failed/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "npm");
    assert.deepEqual(await readdir(dir), ["openclaw.json"]);
    assert.equal(await readFile(configPath, "utf8"), "{}\n");
  });
});

test("confirmed apply backs up first, dry-runs every config write, then applies writes", async () => {
  await withProfile(async ({ dir, configPath }) => {
    const calls = [];
    let backupExistsAtFirstMutation = false;
    const baseRunner = fakeApplyRunner(configPath, calls);
    const runner = (command, args, options) => {
      if (command === "npm" && args.includes("install")) {
        backupExistsAtFirstMutation = readdirSync(dir).some((name) => name.endsWith(".bak"));
      }
      return baseRunner(command, args, options);
    };

    const plan = await runInstaller({
      repoRoot: packageRoot,
      commandRunner: runner,
      apply: true,
      confirmInstall: async () => "INSTALL",
      skipGatewayRestartPrompt: true,
      skipMockVerification: true,
      now: () => new Date("2026-10-23T12:34:56.789Z"),
    });
    const dirEntries = await readdir(dir);
    const backupName = dirEntries.find((name) => name.endsWith(".bak"));
    assert.equal(plan.mode, "applied");
    assert.ok(backupName);
    assert.deepEqual(await readFile(join(dir, backupName), "utf8"), "{}\n");
    assert.equal(plan.backupPath, join(dir, backupName));
    const configSetCalls = calls.filter(({ args }) => args[0] === "config" && args[1] === "set");
    const firstWriteIndex = configSetCalls.findIndex(({ args }) => !args.includes("--dry-run"));
    assert.ok(firstWriteIndex > 0);
    assert.ok(configSetCalls.slice(0, firstWriteIndex).every(({ args }) => args.includes("--dry-run")));
    assert.ok(configSetCalls.slice(firstWriteIndex).every(({ args }) => !args.includes("--dry-run")));
    assert.ok(configSetCalls.every(({ args }) => args.includes("--strict-json")));
    assert.ok(configSetCalls.some(({ args }) => args[2] === "agents.list[0].tools.alsoAllow"));
    assert.ok(configSetCalls.some(({ args }) => args[2] === "agents.list[1].tools.alsoAllow"));
    const energyAllowlistDryRun = configSetCalls.find(({ args }) =>
      args[2] === "agents.list[2].tools.alsoAllow" && args.includes("--dry-run"));
    assert.ok(energyAllowlistDryRun, "energy-saving receives a validated minimal tool allowlist");
    assert.deepEqual(JSON.parse(energyAllowlistDryRun.args[3]), [
      "plan_energy_optimization",
      "calculate_energy_optimization",
      "forecast_energy_budget",
      "analyze_energy_usage",
      "evaluate_energy_effect",
    ]);
    assert.ok(plan.configWrites.includes("tools.agentToAgent.allow"));
    assert.equal(plan.safety.profileMutations, true);
    assert.equal(backupExistsAtFirstMutation, true);
  });
});

test("a post-backup failure retains the backup and does not attempt rollback", async () => {
  await withProfile(async ({ dir, configPath }) => {
    await assert.rejects(runInstaller({
      repoRoot: packageRoot,
      commandRunner: fakeApplyRunner(configPath, [], { failOn: "npm" }),
      apply: true,
      confirmInstall: async () => "INSTALL",
      now: () => new Date("2026-10-23T12:34:56.789Z"),
    }), /Backup retained at: .*\.bak\. No automatic rollback was attempted/);
    assert.equal((await readdir(dir)).filter((name) => name.endsWith(".bak")).length, 1);
  });
});

test("SQLite path must be absolute and outside the package", async () => {
  await withProfile(async ({ configPath }) => {
    const calls = [];
    await assert.rejects(runInstaller({
      repoRoot: packageRoot,
      commandRunner: fakeOpenClaw(configPath, calls),
      enableSQLiteMemory: true,
      memoryDatabasePath: join(packageRoot, "should-not-be-written.sqlite"),
      nodeVersion: "24.19.0",
    }), /outside the extracted package directory/);
    assert.ok(calls.every(({ args }) => !(args[0] === "config" && args[1] === "set")));
  });
});

test("safe Gateway restart is opt-in and Mock verification clears HA and lock-auth credentials", async () => {
  await withProfile(async ({ configPath }) => {
    const calls = [];
    const baseRunner = fakeApplyRunner(configPath, calls);
    let mockEnv;
    const commandRunner = (command, args, options = {}) => {
      if (args.join(" ") === "gateway restart --safe") {
        calls.push({ command, args });
        return { status: 0, stdout: "gateway restarted safely" };
      }
      if (args[0] === "plugins" && args[1] === "inspect") {
        calls.push({ command, args });
        return { status: 0, stdout: "platform-orchestrator loaded" };
      }
      if (command === process.execPath && args[0] === "deployment/verify-agent-stack.mjs") {
        calls.push({ command, args });
        mockEnv = options.env;
        return { status: 0, stdout: "mock verification passed" };
      }
      return baseRunner(command, args, options);
    };
    const plan = await runInstaller({
      repoRoot: packageRoot,
      commandRunner,
      apply: true,
      confirmInstall: async () => "INSTALL",
      confirmGatewayRestart: async () => "RESTART",
      env: {
        HA_URL: "http://mock.invalid",
        HA_TOKEN: "test-only-secret",
        DEVICE_MANAGER_BACKEND: "real",
        DEVICE_MANAGER_LOCK_AUTH_URL: "https://auth.invalid/authorize",
        DEVICE_MANAGER_LOCK_AUTH_PUBLIC_KEY: "test-only-public-key",
        DEVICE_MANAGER_LOCK_AUTH_ISSUER: "test-only-issuer",
        DEVICE_MANAGER_LOCK_AUTH_AUDIENCE: "test-only-audience",
      },
      now: () => new Date("2026-10-23T12:34:56.789Z"),
    });
    assert.equal(plan.gatewayRestart, "restarted-and-loaded");
    assert.equal(plan.mockVerification, "passed");
    assert.equal(mockEnv.DEVICE_MANAGER_BACKEND, "mock");
    for (const name of [
      "HA_URL",
      "HA_TOKEN",
      "HA_ENTITY_ALLOWLIST",
      "HA_CONFIRMATION_REQUIRED_ENTITIES",
      "DEVICE_MANAGER_LOCK_AUTH_URL",
      "DEVICE_MANAGER_LOCK_AUTH_PUBLIC_KEY",
      "DEVICE_MANAGER_LOCK_AUTH_ISSUER",
      "DEVICE_MANAGER_LOCK_AUTH_AUDIENCE",
    ]) assert.equal(Object.hasOwn(mockEnv, name), false);
    assert.ok(calls.some(({ args }) => args.join(" ") === "gateway restart --safe"));
  });
});

test("ambiguous frontdoor selection fails instead of guessing", async () => {
  await withProfile(async ({ configPath }) => {
    const runner = (command, args) => {
      if (command === "npm" && args.join(" ") === "--version") return { status: 0, stdout: "10.8.2" };
      if (args.join(" ") === "--version") return { status: 0, stdout: "OpenClaw 2026.7.1-2" };
      if (args.join(" ") === "config file") return { status: 0, stdout: configPath };
      if (args.join(" ") === "config validate") return { status: 0, stdout: "valid" };
      if (args.join(" ") === "agents list --json") return { status: 0, stdout: JSON.stringify([{ id: "alpha" }, { id: "beta" }]) };
      return { status: 1, stdout: "" };
    };
    await assert.rejects(runInstaller({ repoRoot: packageRoot, commandRunner: runner }), /--frontdoor-agent-id/);
  });
});
