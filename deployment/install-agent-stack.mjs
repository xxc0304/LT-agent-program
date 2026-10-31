#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { constants as fsConstants } from "node:fs";
import { access, copyFile, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REQUIRED_OPENCLAW_VERSION = "2026.7.1-2";
export const PROJECT_AGENT_IDS = ["device-manager", "energy-saving", "learning-companion"];
export const RESTRICTED_SESSION_TOOLS = ["sessions_list", "sessions_history", "sessions_send", "sessions_spawn"];
const ENERGY_AGENT_ONLY_TOOLS = ["analyze_energy_usage", "forecast_energy_budget", "evaluate_energy_effect", "calculate_energy_optimization"];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = {
    repoRoot, frontdoorAgentId: undefined, openclawPath: "openclaw", outputPath: undefined,
    apply: false, enableSQLiteMemory: false, memoryDatabasePath: undefined,
    skipMockVerification: false, skipGatewayRestartPrompt: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--plan-only") options.planOnly = true;
    else if (arg === "--frontdoor-agent-id") options.frontdoorAgentId = requireValue(argv, ++index, arg);
    else if (arg === "--openclaw-path") options.openclawPath = requireValue(argv, ++index, arg);
    else if (arg === "--output") options.outputPath = requireValue(argv, ++index, arg);
    else if (arg === "--enable-sqlite-memory") options.enableSQLiteMemory = true;
    else if (arg === "--memory-database-path") options.memoryDatabasePath = requireValue(argv, ++index, arg);
    else if (arg === "--skip-mock-verification") options.skipMockVerification = true;
    else if (arg === "--skip-gateway-restart-prompt") options.skipGatewayRestartPrompt = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.apply && options.planOnly) throw new Error("Use either --apply or --plan-only, not both.");
  if (options.memoryDatabasePath && !options.enableSQLiteMemory) throw new Error("--memory-database-path requires --enable-sqlite-memory.");
  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function usage() {
  return [
    "Linux-capable LT Agent stack installer (read-only plan is the default)",
    "Usage: node deployment/install-agent-stack.mjs [options]",
    "  --apply                    Install into the currently selected OpenClaw profile",
    "  --plan-only                Explicitly request a read-only plan (the default)",
    "  --frontdoor-agent-id <id>  Select the existing OpenClaw chat Agent",
    "  --openclaw-path <path>     OpenClaw CLI path (default: openclaw on PATH)",
    "  --output <path>            Also save the JSON deployment plan at this path",
    "  --enable-sqlite-memory     Opt in to SQLite household memory (Node.js >=22.5)",
    "  --memory-database-path <absolute-path>  Select SQLite database location",
    "  --skip-gateway-restart-prompt  Leave restart entirely to the operator",
    "  --skip-mock-verification   Skip repository local/Mock verification",
    "  --help                     Show this help",
  ].join("\n");
}

function nativeCommandRunner(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) return { status: null, stdout: "", stderr: result.error.message, error: result.error };
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", signal: result.signal };
}

function runChecked(commandRunner, command, args, label, options = {}) {
  const result = commandRunner(command, args, options);
  if (result?.status !== 0) {
    const suffix = result?.status == null ? "could not start" : `exit code ${result.status}`;
    throw new Error(`${label} failed (${suffix}).`);
  }
  return String(result.stdout ?? "");
}

async function askText(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive confirmation requires a terminal. Re-run from a terminal; no changes were made.");
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try { return await terminal.question(prompt); }
  finally { terminal.close(); }
}

function parseJsonOutput(text, label) {
  const source = String(text).trim();
  try { return JSON.parse(source); } catch {}
  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== "{" && source[start] !== "[") continue;
    for (let end = source.length - 1; end > start; end -= 1) {
      if (source[end] !== "}" && source[end] !== "]") continue;
      try { return JSON.parse(source.slice(start, end + 1)); } catch {}
    }
  }
  throw new Error(`Could not parse structured output while ${label}.`);
}

function getRows(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["agents", "plugins", "items", "entries", "results"]) {
    if (key in value) return getRows(value[key]);
  }
  return [value];
}

function getProperty(object, names) {
  if (!object || typeof object !== "object") return undefined;
  for (const name of names) if (Object.hasOwn(object, name)) return object[name];
  return undefined;
}

function stringArray(value, settingName) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`OpenClaw setting '${settingName}' is not a list; it will not be replaced.`);
  const result = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error(`OpenClaw setting '${settingName}' contains a non-text item; it will not be replaced.`);
    if (item.trim()) result.push(item);
  }
  return result;
}

function findRow(rows, id) {
  return rows.find((row) => String(getProperty(row, ["id", "agentId"]) ?? "").toLowerCase() === id.toLowerCase());
}

function findPluginRow(rows, id) {
  return rows.find((row) => String(getProperty(row, ["id", "pluginId", "name"]) ?? "").toLowerCase() === id.toLowerCase());
}

export function comparablePath(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const input = value.trim();
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(input)) {
    return win32.resolve(input).replace(/[\\/]+$/, "").toLowerCase();
  }
  return posix.resolve(input).replace(/\/+$/, "");
}

function pluginSourcePath(record) {
  if (!record || typeof record !== "object") return null;
  const pathKeys = new Set(["resolvedPath", "pluginPath", "packagePath", "sourcePath", "installPath", "rootDir", "path"]);
  for (const [key, value] of Object.entries(record)) {
    if (pathKeys.has(key) && typeof value === "string" && (/^(?:[A-Za-z]:[\\/]|\\\\|\/)/).test(value)) return value;
    if (value && typeof value === "object") {
      const nested = pluginSourcePath(value);
      if (nested) return nested;
    }
  }
  return null;
}

function addUniqueStrings(existing, additions) {
  const result = [];
  const seen = new Set();
  for (const item of [...existing, ...additions]) {
    const key = item.toLowerCase();
    if (!seen.has(key)) { seen.add(key); result.push(item); }
  }
  return result;
}

function makeConfigReader(commandRunner, openclawPath) {
  return (settingPath, optional = false) => {
    const result = commandRunner(openclawPath, ["config", "get", "--json", settingPath]);
    if (result?.status !== 0) {
      if (optional) return undefined;
      throw new Error(`Could not read OpenClaw setting '${settingPath}'. No profile changes were made.`);
    }
    return parseJsonOutput(result.stdout, `reading OpenClaw setting '${settingPath}'`);
  };
}

function getPluginRows(commandRunner, openclawPath) {
  return getRows(parseJsonOutput(
    runChecked(commandRunner, openclawPath, ["plugins", "list", "--verbose", "--json"], "Checking installed OpenClaw plugins"),
    "reading installed OpenClaw plugins",
  ));
}

function resolvePluginSource(commandRunner, openclawPath, pluginRows, pluginId) {
  const row = findPluginRow(pluginRows, pluginId);
  if (!row) return { row: null, sourcePath: null };
  let sourcePath = pluginSourcePath(row);
  if (!sourcePath) {
    const inspected = parseJsonOutput(
      runChecked(commandRunner, openclawPath, ["plugins", "inspect", pluginId, "--json"], `Checking the existing ${pluginId} plugin path`),
      `reading ${pluginId} plugin details`,
    );
    sourcePath = pluginSourcePath(inspected);
  }
  return { row, sourcePath };
}

function assertPluginPath({ commandRunner, openclawPath, pluginRows, pluginId, expectedPath }) {
  const { row, sourcePath } = resolvePluginSource(commandRunner, openclawPath, pluginRows, pluginId);
  if (row && (!sourcePath || comparablePath(sourcePath) !== comparablePath(expectedPath))) {
    throw new Error(`A different ${pluginId} plugin is already registered. It was not overwritten; review it or remove it using the OpenClaw CLI before retrying.`);
  }
  return Boolean(row);
}

function parseConfigPath(output) {
  const match = String(output).match(/(?:~[\\/]|[A-Za-z]:[\\/]|\\\\|\/)[^\r\n"']*openclaw\.json/i);
  if (!match) throw new Error("Could not identify the active OpenClaw config file. No profile changes were made.");
  const reportedPath = match[0].trim().replace(/^~(?=[\\/])/, homedir());
  return resolve(reportedPath);
}

function selectFrontdoorAgent(rows, requestedId) {
  if (requestedId) {
    const row = findRow(rows, requestedId);
    if (!row) throw new Error(`Frontdoor Agent '${requestedId}' is not present in the active OpenClaw profile.`);
    return String(getProperty(row, ["id", "agentId"]));
  }
  const defaults = rows.filter((row) => getProperty(row, ["isDefault", "default"]) === true);
  if (defaults.length === 1) return String(getProperty(defaults[0], ["id", "agentId"]));
  for (const preferred of ["dev", "main"]) {
    const row = rows.find((item) => String(getProperty(item, ["id", "agentId"])) === preferred);
    if (row) return preferred;
  }
  const candidates = rows.filter((row) => {
    const id = String(getProperty(row, ["id", "agentId"]) ?? "");
    return id && !PROJECT_AGENT_IDS.includes(id);
  });
  if (candidates.length === 1) return String(getProperty(candidates[0], ["id", "agentId"]));
  throw new Error("Could not uniquely select the user-facing Agent. Re-run with --frontdoor-agent-id <id>.");
}

async function assertPackageFiles(root) {
  const required = [
    "device-manager/openclaw.plugin.json",
    "multi-agent-orchestrator/openclaw.plugin.json",
    "device-manager/agent-workspace/AGENTS.md",
    "openclaw-agents/energy-saving/AGENTS.md",
    "openclaw-agents/learning-companion/AGENTS.md",
  ];
  for (const relativePath of required) {
    try { await access(join(root, relativePath)); }
    catch { throw new Error(`The package is incomplete: missing ${relativePath}`); }
  }
}

export async function runInstaller(options = {}) {
  const root = resolve(options.repoRoot ?? repoRoot);
  const commandRunner = options.commandRunner ?? nativeCommandRunner;
  const openclawPath = options.openclawPath ?? "openclaw";
  const npmPath = options.npmPath ?? "npm";
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const frontdoorAgentId = options.frontdoorAgentId;
  const apply = options.apply === true;
  if (options.memoryDatabasePath && !options.enableSQLiteMemory) throw new Error("--memory-database-path requires --enable-sqlite-memory.");
  if (options.enableSQLiteMemory) {
    const versionParts = String(nodeVersion).replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!versionParts || Number(versionParts[1]) < 22 || (Number(versionParts[1]) === 22 && Number(versionParts[2]) < 5)) {
      throw new Error(`SQLite memory requires Node.js 22.5 or newer; found v${nodeVersion}. JSON memory still supports Node.js 20+.`);
    }
  }

  await assertPackageFiles(root);
  const npmVersion = runChecked(commandRunner, npmPath, ["--version"], "Checking npm availability").trim();
  const versionOutput = runChecked(commandRunner, openclawPath, ["--version"], "Checking OpenClaw version");
  const versionMatch = versionOutput.match(/(?:OpenClaw\s+)?(\d{4}\.\d+\.\d+(?:-\d+)?)/i);
  if (!versionMatch) throw new Error("Could not read the installed OpenClaw version.");
  const openclawVersion = versionMatch[1];
  if (openclawVersion !== REQUIRED_OPENCLAW_VERSION) {
    throw new Error(`This package requires OpenClaw ${REQUIRED_OPENCLAW_VERSION}; found ${openclawVersion}. The installer will not upgrade or switch profiles.`);
  }
  const nodeMajorVersion = Number(String(nodeVersion).replace(/^v/i, "").split(".")[0]);
  if (!Number.isFinite(nodeMajorVersion) || nodeMajorVersion < 20) throw new Error(`Node.js 20 or newer is required; found v${nodeVersion}.`);

  const configOutput = runChecked(commandRunner, openclawPath, ["config", "file"], "Checking active OpenClaw profile");
  const configPath = parseConfigPath(configOutput);
  try {
    const configStat = await stat(configPath);
    if (!configStat.isFile()) throw new Error("not a regular file");
  } catch {
    throw new Error("The active OpenClaw config does not exist at the reported path. Complete OpenClaw setup first; no profile was initialized.");
  }
  runChecked(commandRunner, openclawPath, ["config", "validate"], "Validating the current OpenClaw profile");
  const agentRows = getRows(parseJsonOutput(
    runChecked(commandRunner, openclawPath, ["agents", "list", "--json"], "Reading configured Agent names"),
    "reading configured Agent names",
  ));
  const frontdoorId = selectFrontdoorAgent(agentRows, frontdoorAgentId);
  if (PROJECT_AGENT_IDS.some((id) => id.toLowerCase() === frontdoorId.toLowerCase())) throw new Error("The frontdoor Agent cannot be one of the project business Agents.");

  const deviceManagerManifest = JSON.parse(await readFile(join(root, "device-manager/openclaw.plugin.json"), "utf8"));
  const pluginTools = (deviceManagerManifest.contracts?.tools ?? []).filter((tool) => typeof tool === "string");
  if (!pluginTools.includes("talk_to_device_manager")) throw new Error("The package plugin is missing talk_to_device_manager.");
  const deviceManagerTools = pluginTools.filter((tool) => !ENERGY_AGENT_ONLY_TOOLS.includes(tool));
  const platformManifest = JSON.parse(await readFile(join(root, "multi-agent-orchestrator/openclaw.plugin.json"), "utf8"));
  const platformTool = (platformManifest.contracts?.tools ?? []).find((tool) => tool === "orchestrate_household_agents");
  if (!platformTool) throw new Error("The platform plugin is missing orchestrate_household_agents.");

  const pluginRows = getPluginRows(commandRunner, openclawPath);
  const deviceManagerRegistered = assertPluginPath({
    commandRunner, openclawPath, pluginRows, pluginId: "device-manager", expectedPath: join(root, "device-manager"),
  });
  const platformRegistered = assertPluginPath({
    commandRunner, openclawPath, pluginRows, pluginId: "platform-orchestrator", expectedPath: join(root, "multi-agent-orchestrator"),
  });

  const workspaceMap = {
    "device-manager": join(root, "device-manager", "agent-workspace"),
    "energy-saving": join(root, "openclaw-agents", "energy-saving"),
    "learning-companion": join(root, "openclaw-agents", "learning-companion"),
  };
  const createAgents = [];
  for (const agentId of PROJECT_AGENT_IDS) {
    const row = findRow(agentRows, agentId);
    if (!row) { createAgents.push(agentId); continue; }
    const workspace = getProperty(row, ["workspace", "workspaceDir"]);
    if (!workspace || comparablePath(workspace) !== comparablePath(workspaceMap[agentId])) {
      throw new Error(`Agent '${agentId}' already exists with a different workspace. It was left unchanged; resolve the workspace choice before retrying.`);
    }
  }

  const getConfig = makeConfigReader(commandRunner, openclawPath);
  const currentPluginAllowValue = getConfig("plugins.allow", true);
  const hasExplicitPluginAllow = currentPluginAllowValue !== undefined && currentPluginAllowValue !== null;
  const currentPluginAllow = stringArray(currentPluginAllowValue, "plugins.allow");
  const currentA2A = getConfig("tools.agentToAgent", true);
  const currentA2AAllow = stringArray(getProperty(currentA2A, ["allow"]), "tools.agentToAgent.allow");
  const expectedA2AIds = [frontdoorId, ...PROJECT_AGENT_IDS];
  const expectedA2AIdSet = new Set(expectedA2AIds.map((id) => id.toLowerCase()));
  const unexpectedA2AIds = currentA2AAllow.filter((id) => !expectedA2AIdSet.has(id.toLowerCase()));
  if (unexpectedA2AIds.length) {
    throw new Error(`The active profile already allows other Agent IDs through tools.agentToAgent.allow (${unexpectedA2AIds.join(", ")}). The installer will not broaden that shared policy; review it before retrying.`);
  }

  const preflightAgentList = getRows(getConfig("agents.list", true));
  const frontdoorEntry = findRow(preflightAgentList, frontdoorId);
  if (frontdoorEntry) {
    const frontdoorDeny = stringArray(getProperty(getProperty(frontdoorEntry, ["tools"]), ["deny"]), `agents.list.${frontdoorId}.tools.deny`);
    if (frontdoorDeny.includes(platformTool)) throw new Error(`The selected frontdoor Agent '${frontdoorId}' explicitly denies ${platformTool}. It was not overridden.`);
  }
  const managerEntry = findRow(preflightAgentList, "device-manager");
  if (managerEntry) {
    const managerDeny = stringArray(getProperty(getProperty(managerEntry, ["tools"]), ["deny"]), "agents.list.device-manager.tools.deny");
    const blockedTools = pluginTools.filter((tool) => managerDeny.includes(tool));
    if (blockedTools.length) throw new Error(`The existing device-manager Agent explicitly denies required plugin tools (${blockedTools.join(", ")}). It was not overridden.`);
  }

  const currentVisibility = getConfig("tools.sessions.visibility", true) ?? "tree";
  const visibilityNeedsWidening = currentVisibility !== "all";
  if (visibilityNeedsWidening) {
    const unprotected = [];
    for (const summary of agentRows) {
      const agentId = String(getProperty(summary, ["id", "agentId"]) ?? "");
      if (!agentId || PROJECT_AGENT_IDS.includes(agentId) || agentId === frontdoorId) continue;
      const configEntry = findRow(preflightAgentList, agentId);
      if (!configEntry) { unprotected.push(`${agentId} (no readable agents.list entry)`); continue; }
      const deny = stringArray(getProperty(getProperty(configEntry, ["tools"]), ["deny"]), `agents.list.${agentId}.tools.deny`);
      const missing = RESTRICTED_SESSION_TOOLS.filter((tool) => !deny.includes(tool));
      if (missing.length) unprotected.push(`${agentId} (does not explicitly deny: ${missing.join(", ")})`);
    }
    if (unprotected.length) {
      throw new Error(`Changing tools.sessions.visibility from '${currentVisibility}' to 'all' is a global expansion. These unrelated Agents are not proven to have session tools disabled: ${unprotected.join("; ")}. No backup or profile changes were made.`);
    }
  }

  let resolvedMemoryDatabasePath;
  let preserveImplicitMemoryDatabasePath = false;
  if (options.enableSQLiteMemory) {
    const configuredBackend = getConfig("plugins.entries.device-manager.config.memoryBackend", true);
    const configuredPath = getConfig("plugins.entries.device-manager.config.memoryDatabasePath", true);
    const environment = options.env ?? process.env;
    const legacySQLite = !configuredBackend && environment.FAMILY_MEMORY_BACKEND === "sqlite";
    if (options.memoryDatabasePath) {
      if (!isAbsolute(options.memoryDatabasePath)) throw new Error("--memory-database-path must be an absolute path outside the extracted package directory.");
      resolvedMemoryDatabasePath = resolve(options.memoryDatabasePath);
    } else if (configuredBackend === "sqlite") {
      if (!configuredPath) preserveImplicitMemoryDatabasePath = true;
      else if (typeof configuredPath !== "string" || !isAbsolute(configuredPath)) {
        throw new Error("The active profile has a non-absolute SQLite database path. No profile changes were made; pass an explicit absolute --memory-database-path if a path change is intended.");
      } else resolvedMemoryDatabasePath = resolve(configuredPath);
    } else if (legacySQLite && !environment.FAMILY_MEMORY_DB_PATH) {
      preserveImplicitMemoryDatabasePath = true;
    } else if (legacySQLite) {
      if (!isAbsolute(environment.FAMILY_MEMORY_DB_PATH)) throw new Error("FAMILY_MEMORY_DB_PATH selects a relative legacy SQLite path; use an absolute --memory-database-path after confirming the intended database.");
      resolvedMemoryDatabasePath = resolve(environment.FAMILY_MEMORY_DB_PATH);
    } else {
      resolvedMemoryDatabasePath = resolve(dirname(configPath), "device-manager", "family-memory.sqlite");
    }
    if (resolvedMemoryDatabasePath) {
      const rootPath = comparablePath(root);
      const databasePath = comparablePath(resolvedMemoryDatabasePath);
      if (databasePath === rootPath || databasePath.startsWith(`${rootPath}${process.platform === "win32" ? "\\" : "/"}`)) {
        throw new Error("The SQLite database must be outside the extracted package directory so household data cannot be included in a later package build.");
      }
      try {
        const dbStat = await stat(resolvedMemoryDatabasePath);
        if (dbStat.isDirectory()) throw new Error(`The SQLite memory path points to a directory, not a database file: ${resolvedMemoryDatabasePath}`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  const plan = {
    mode: apply ? "apply-pending-confirmation" : "plan-only",
    npmVersion,
    openclawVersion,
    activeProfileConfig: configPath,
    frontdoorAgentId: frontdoorId,
    projectAgentIds: PROJECT_AGENT_IDS,
    plannedPlugins: ["device-manager", "platform-orchestrator"],
    workspaces: workspaceMap,
    createAgents,
    existingPlugins: { "device-manager": deviceManagerRegistered, "platform-orchestrator": platformRegistered },
    pluginTools,
    mainChatOrchestrationTool: platformTool,
    currentPluginAllowEntries: currentPluginAllow.length,
    pluginAllowListIsExplicit: hasExplicitPluginAllow,
    currentAgentToAgentAllow: currentA2AAllow,
    sessionVisibility: { current: currentVisibility, planned: "all", requiresChange: visibilityNeedsWidening },
    memory: options.enableSQLiteMemory
      ? { backend: "sqlite", databasePath: resolvedMemoryDatabasePath ?? null, preserveRuntimeDefaultPath: preserveImplicitMemoryDatabasePath }
      : { backend: "preserve-existing" },
    safety: {
      profileMutations: false,
      packageInstallation: false,
      gatewayRestart: false,
      mockVerification: false,
    },
  };
  if (options.outputPath) {
    await writeFile(resolve(options.outputPath), `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    plan.planArtifact = resolve(options.outputPath);
  }
  if (!apply) return plan;

  const confirmation = options.confirmInstall
    ? await options.confirmInstall(plan)
    : await askText("To back up and apply this plan to the active OpenClaw profile, type INSTALL: ");
  if (confirmation !== "INSTALL") {
    return { ...plan, mode: "cancelled", cancellation: "Install confirmation was not the exact text INSTALL." };
  }

  let backupPath;
  let backupCreated = false;
  let gatewayRestart = "pending";
  let mockVerification = "skipped";
  try {
    const timestamp = (options.now?.() ?? new Date()).toISOString().replace(/[-:.TZ]/g, "");
    backupPath = `${configPath}.pre-lt-agent-program-${timestamp}.bak`;
    await copyFile(configPath, backupPath, fsConstants.COPYFILE_EXCL);
    backupCreated = true;

    const npmArgs = ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--legacy-peer-deps", "--package-lock=false"];
    runChecked(commandRunner, npmPath, npmArgs, "Installing device-manager dependencies", { cwd: join(root, "device-manager") });
    runChecked(commandRunner, npmPath, npmArgs, "Installing platform-orchestrator dependencies", { cwd: join(root, "multi-agent-orchestrator") });
    runChecked(commandRunner, openclawPath, ["plugins", "build", "--root", join(root, "multi-agent-orchestrator"), "--entry", "./src/openclaw-platform-plugin.js"], "Building platform-orchestrator plugin metadata");
    if (!deviceManagerRegistered) runChecked(commandRunner, openclawPath, ["plugins", "install", "--link", join(root, "device-manager")], "Installing the device-manager plugin");
    runChecked(commandRunner, openclawPath, ["plugins", "enable", "device-manager"], "Enabling the device-manager plugin");
    if (!platformRegistered) runChecked(commandRunner, openclawPath, ["plugins", "install", "--link", join(root, "multi-agent-orchestrator")], "Installing the platform-orchestrator plugin");
    runChecked(commandRunner, openclawPath, ["plugins", "enable", "platform-orchestrator"], "Enabling the platform-orchestrator plugin");
    for (const agentId of createAgents) {
      runChecked(commandRunner, openclawPath, ["agents", "add", agentId, "--workspace", workspaceMap[agentId], "--non-interactive"], `Registering ${agentId}`);
    }

    const freshAgentList = getRows(getConfig("agents.list"));
    const writes = [];
    const freshPluginAllow = getConfig("plugins.allow", true);
    if (freshPluginAllow !== undefined && freshPluginAllow !== null) {
      writes.push(["plugins.allow", addUniqueStrings(stringArray(freshPluginAllow, "plugins.allow"), ["device-manager", "platform-orchestrator"])]);
    }
    writes.push(["plugins.entries.device-manager.config.frontdoorAgentId", frontdoorId]);
    if (options.enableSQLiteMemory) {
      writes.push(["plugins.entries.device-manager.config.memoryBackend", "sqlite"]);
      if (!preserveImplicitMemoryDatabasePath) writes.push(["plugins.entries.device-manager.config.memoryDatabasePath", resolvedMemoryDatabasePath]);
    }
    writes.push(["plugins.entries.platform-orchestrator.config.frontdoorAgentId", frontdoorId]);
    const freshA2A = getConfig("tools.agentToAgent", true);
    writes.push(["tools.agentToAgent.enabled", true]);
    writes.push(["tools.agentToAgent.allow", addUniqueStrings(stringArray(getProperty(freshA2A, ["allow"]), "tools.agentToAgent.allow"), [frontdoorId, ...PROJECT_AGENT_IDS])]);
    writes.push(["tools.sessions.visibility", "all"]);

    const policies = [
      { id: frontdoorId, allow: [platformTool], deny: ["talk_to_device_manager", ...pluginTools, ...RESTRICTED_SESSION_TOOLS] },
      { id: "device-manager", allow: deviceManagerTools, deny: ["sessions_list", "sessions_history", "sessions_spawn", ...ENERGY_AGENT_ONLY_TOOLS] },
      { id: "energy-saving", allow: ["plan_energy_optimization", "calculate_energy_optimization", "forecast_energy_budget", "analyze_energy_usage", "evaluate_energy_effect"], deny: RESTRICTED_SESSION_TOOLS },
      { id: "learning-companion", allow: [], deny: RESTRICTED_SESSION_TOOLS },
    ];
    for (const policy of policies) {
      const index = freshAgentList.findIndex((row) => String(getProperty(row, ["id", "agentId"]) ?? "").toLowerCase() === policy.id.toLowerCase());
      if (index < 0) throw new Error(`OpenClaw did not expose Agent '${policy.id}' in agents.list after registration.`);
      const row = freshAgentList[index];
      const tools = getProperty(row, ["tools"]);
      const existingAllow = stringArray(getProperty(tools, ["alsoAllow"]), `agents.list.${policy.id}.tools.alsoAllow`);
      const existingDeny = stringArray(getProperty(tools, ["deny"]), `agents.list.${policy.id}.tools.deny`);
      if (policy.allow.length) writes.push([`agents.list[${index}].tools.alsoAllow`, addUniqueStrings(existingAllow, policy.allow)]);
      writes.push([`agents.list[${index}].tools.deny`, addUniqueStrings(existingDeny, policy.deny)]);
    }

    for (const [settingPath, value] of writes) {
      runChecked(commandRunner, openclawPath, ["config", "set", settingPath, JSON.stringify(value), "--strict-json", "--dry-run"], `Validating ${settingPath}`);
    }
    for (const [settingPath, value] of writes) {
      runChecked(commandRunner, openclawPath, ["config", "set", settingPath, JSON.stringify(value), "--strict-json"], `Updating ${settingPath}`);
    }
    runChecked(commandRunner, openclawPath, ["config", "validate"], "Validating the installed OpenClaw configuration");

    if (!options.skipGatewayRestartPrompt) {
      const restartConfirmation = options.confirmGatewayRestart
        ? await options.confirmGatewayRestart(plan)
        : await askText("Restart the Gateway safely now? This may briefly interrupt active work. Type RESTART to proceed, or press Enter to leave it pending: ");
      if (restartConfirmation === "RESTART") {
        try {
          runChecked(commandRunner, openclawPath, ["gateway", "restart", "--safe"], "Safely restarting the OpenClaw Gateway");
          const runtimeOutput = runChecked(commandRunner, openclawPath, ["plugins", "inspect", "platform-orchestrator", "--runtime"], "Checking platform-orchestrator runtime registration");
          gatewayRestart = /\bloaded\b/i.test(runtimeOutput) ? "restarted-and-loaded" : "restarted-runtime-needs-review";
        } catch (error) {
          gatewayRestart = `restart-or-inspection-failed: ${error.message}`;
        }
      }
    }

    if (!options.skipMockVerification) {
      const verifyEnv = { ...(options.env ?? process.env), DEVICE_MANAGER_BACKEND: "mock" };
      for (const name of [
        "HA_URL",
        "HA_TOKEN",
        "HA_ENTITY_ALLOWLIST",
        "HA_CONFIRMATION_REQUIRED_ENTITIES",
        "DEVICE_MANAGER_LOCK_AUTH_URL",
        "DEVICE_MANAGER_LOCK_AUTH_PUBLIC_KEY",
        "DEVICE_MANAGER_LOCK_AUTH_ISSUER",
        "DEVICE_MANAGER_LOCK_AUTH_AUDIENCE",
      ]) delete verifyEnv[name];
      runChecked(commandRunner, process.execPath, ["deployment/verify-agent-stack.mjs"], "Running local/Mock verification", { cwd: root, env: verifyEnv });
      mockVerification = "passed";
    }
    return {
      ...plan,
      mode: "applied",
      backupPath,
      configWrites: writes.map(([settingPath]) => settingPath),
      gatewayRestart,
      mockVerification,
      safety: { ...plan.safety, profileMutations: true, packageInstallation: true, gatewayRestart: gatewayRestart === "restarted-and-loaded", mockVerification: mockVerification === "passed" },
    };
  } catch (error) {
    if (backupCreated) throw new Error(`${error.message} Backup retained at: ${backupPath}. No automatic rollback was attempted.`);
    throw error;
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  try {
    const plan = await runInstaller({ ...options, ...dependencies });
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
