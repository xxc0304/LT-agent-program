import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const MATRIX = JSON.parse(readFileSync(new URL("./candidate-matrix.json", import.meta.url), "utf8"));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function readCandidateConfig(candidate) {
  const definition = MATRIX.candidates[candidate];
  return JSON.parse(readFileSync(new URL(definition.config_patch, import.meta.url), "utf8"));
}

function expectedProvider() {
  return {
    models: [
      {
        id: MATRIX.shared_model.model_id,
        input: ["text"],
        reasoning: true,
        name: "DeepSeek V4 Flash (OpenAI-compatible pilot)",
        maxTokens: MATRIX.shared_model.max_tokens,
        contextWindow: MATRIX.shared_model.context_window,
      },
    ],
    apiKey: {
      source: "env",
      provider: "default",
      id: MATRIX.shared_model.secret_reference,
    },
    api: MATRIX.shared_model.api,
    baseUrl: MATRIX.shared_model.base_url,
  };
}

test("candidate matrix includes runnable A/B/C/D profile sources", () => {
  assert.deepEqual(Object.keys(MATRIX.candidates).sort(), ["A", "B", "C", "D"]);
  for (const [candidate, definition] of Object.entries(MATRIX.candidates)) {
    assert.ok(readFileSync(new URL(definition.config_patch, import.meta.url), "utf8"), candidate);
    assert.ok(existsSync(new URL(`${definition.source_profile}/`, import.meta.url)), candidate);
    assert.ok(definition.method.length > 0, candidate);
  }
});

test("all four candidates use the same model endpoint, model ID, limits, and secret reference", () => {
  const provider = expectedProvider();
  for (const candidate of Object.keys(MATRIX.candidates)) {
    const config = readCandidateConfig(candidate);
    assert.deepEqual(config.models.providers[MATRIX.shared_model.provider_id], provider, candidate);
    assert.equal(config.agents.defaults.model.primary, `${MATRIX.shared_model.provider_id}/${MATRIX.shared_model.model_id}`, candidate);
    assert.deepEqual(config.secrets.providers.default.allowlist, [MATRIX.shared_model.secret_reference], candidate);
  }
});

test("candidate tool boundaries match their declared orchestration method", () => {
  for (const [candidate, definition] of Object.entries(MATRIX.candidates)) {
    const config = readCandidateConfig(candidate);
    const main = config.agents.list.find((agent) => agent.default);
    assert.equal(main.id, "dev", candidate);
    assert.deepEqual(main.tools.allow, definition.main_tools, candidate);
    assert.deepEqual(config.tools.alsoAllow, definition.main_tools, candidate);
    assert.equal(config.tools.agentToAgent.enabled, true, candidate);
    assert.deepEqual([...config.tools.agentToAgent.allow].sort(), config.agents.list.map((agent) => agent.id).sort(), candidate);
    assert.equal(config.gateway.bind, "loopback", candidate);
    assert.equal(config.gateway.auth.mode, "none", candidate);
    for (const specialist of config.agents.list.filter((agent) => agent.id !== main.id)) {
      assert.deepEqual(specialist.tools.allow, [], `${candidate}/${specialist.id} must not receive tools`);
    }
  }
});

test("all profile workspaces exist and use distinct loopback ports", () => {
  const ports = [];
  for (const candidate of Object.keys(MATRIX.candidates)) {
    const config = readCandidateConfig(candidate);
    ports.push(config.gateway.port);
    for (const agent of config.agents.list) {
      const workspace = agent.workspace
        .replaceAll("__EXP_ROOT__", fileURLToPath(new URL("./", import.meta.url)))
        .replaceAll("__REPO_ROOT__", REPO_ROOT);
      assert.ok(existsSync(resolve(workspace)), `${candidate}/${agent.id} workspace does not exist: ${workspace}`);
    }
  }
  assert.equal(new Set(ports).size, ports.length);
});

test("Linux dry-run resolves the repository root from its tools directory", () => {
  const script = readFileSync(new URL("./tools/dry_run_profiles_linux.sh", import.meta.url), "utf8");
  const rootExpression = script.match(/repo_root="\$\(cd -- "\$script_dir\/(.+?)" && pwd\)"/);
  assert.ok(rootExpression, "dry-run script must define repo_root relative to script_dir");
  const scriptDirectory = fileURLToPath(new URL("./tools/", import.meta.url));
  assert.equal(resolve(scriptDirectory, rootExpression[1]), resolve(REPO_ROOT));
});

test("B and D remain the same platform plugin/config except prompt workspace and isolated port", () => {
  const configB = readCandidateConfig("B");
  const configD = readCandidateConfig("D");
  configD.gateway.port = configB.gateway.port;
  configD.agents.list.find((agent) => agent.id === "dev").workspace = configB.agents.list.find((agent) => agent.id === "dev").workspace;
  assert.deepEqual(configD, configB);
});

test("candidate plugins are isolated to the declared orchestration variants", () => {
  assert.deepEqual(Object.keys(readCandidateConfig("A").plugins ?? {}), []);
  assert.deepEqual(Object.keys(readCandidateConfig("B").plugins.entries), ["platform-orchestrator"]);
  assert.deepEqual(Object.keys(readCandidateConfig("C").plugins.entries), ["manager-agent-tools"]);
  assert.deepEqual(Object.keys(readCandidateConfig("D").plugins.entries), ["platform-orchestrator"]);
});
