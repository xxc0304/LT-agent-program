import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  planServiceIntegrationUpdate,
  validateServiceIntegrationManifest,
} from "./openclaw-service-integration.mjs";

const cliPath = fileURLToPath(new URL("./openclaw-service-integration.mjs", import.meta.url));

function manifest(overrides = {}) {
  return {
    schema_version: 1,
    service: { id: "shopping-service", api_contract_version: "2026-01" },
    connector: {
      package_name: "@example/shopping-openclaw",
      plugin_id: "shopping-service",
      version: "1.0.0",
      tested_openclaw_versions: ["2026.7.1-2"],
    },
    authentication: { credential_ref: "env:SHOPPING_SERVICE_TOKEN", permissions: ["catalog.read"] },
    capabilities: [{
      name: "search_catalog",
      effect: "read_only",
      permissions: ["catalog.read"],
      confirmation: "not_required",
    }],
    data_policy: { categories: ["product_catalog"], personal_data: "none", retention_days: null },
    verification: { test_environment: "sandbox", synthetic_data_only: true },
    ...overrides,
  };
}

test("accepts a provider-neutral manifest with a credential reference", () => {
  assert.deepEqual(validateServiceIntegrationManifest(manifest()), []);
});

test("JSON Schema is strict and remains the source of accepted manifest fields", async () => {
  const schemaPath = fileURLToPath(new URL("./openclaw-service-integration.schema.json", import.meta.url));
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties), [
    "schema_version", "service", "connector", "authentication", "capabilities", "data_policy", "verification",
  ]);
  for (const objectSchema of [
    schema.properties.service,
    schema.properties.connector,
    schema.properties.authentication,
    schema.properties.capabilities.items,
    schema.properties.data_policy,
    schema.properties.verification,
  ]) {
    assert.equal(objectSchema.additionalProperties, false);
  }
  const externalWriteRule = schema.properties.capabilities.items.allOf.find(
    (rule) => rule.if.properties.effect.const === "external_write",
  );
  assert.equal(externalWriteRule.then.properties.permissions.minItems, 1);
  assert.equal(externalWriteRule.then.properties.confirmation.const, "required_per_request");
  assert.match(schema.properties.verification.properties.test_environment.description, /does not verify test execution/);
});

test("rejects unknown fields and inline credential material without echoing it", () => {
  const candidate = manifest({
    authentication: { credential_ref: "sk-012345678901234567890123456789012345", permissions: [], api_key: "hidden" },
  });
  const errors = validateServiceIntegrationManifest(candidate);
  assert.ok(errors.some((error) => error.includes("not supported")));
  assert.ok(errors.some((error) => error.includes("credential reference")));
  assert.equal(errors.some((error) => error.includes("sk-012345678901234567890123456789012345")), false);
});

test("rejects external write capability without per-request confirmation", () => {
  const candidate = manifest({
    capabilities: [{ name: "place_order", effect: "external_write", permissions: [], confirmation: "not_required" }],
  });
  assert.ok(validateServiceIntegrationManifest(candidate).some((error) => error.includes("requires per-request user confirmation")));
});

test("rejects a capability permission not declared by the connector", () => {
  const candidate = manifest({
    capabilities: [{ name: "search_catalog", effect: "read_only", permissions: ["orders.write"], confirmation: "not_required" }],
  });
  assert.ok(validateServiceIntegrationManifest(candidate).some((error) => error.includes("not declared by authentication")));
});

test("blocks update when the target OpenClaw version was not tested", () => {
  const current = manifest({ connector: { ...manifest().connector, version: "1.0.0" } });
  const candidate = manifest({ connector: { ...manifest().connector, version: "1.1.0", tested_openclaw_versions: ["2026.8.0"] } });
  const result = planServiceIntegrationUpdate({ current, candidate, openclawVersion: "2026.7.1-2" });
  assert.equal(result.status, "blocked");
  assert.ok(result.errors.some((error) => error.includes("not declared testing")));
  assert.equal(result.activation_permitted, false);
});

test("blocks downgrade and identity changes", () => {
  const current = manifest({ connector: { ...manifest().connector, version: "2.0.0" } });
  const candidate = manifest({
    service: { id: "another-service", api_contract_version: "2026-01" },
    connector: { ...manifest().connector, version: "1.9.0" },
  });
  const result = planServiceIntegrationUpdate({ current, candidate, openclawVersion: "2026.7.1-2" });
  assert.equal(result.status, "blocked");
  assert.ok(result.errors.some((error) => error.includes("identity cannot change")));
  assert.ok(result.errors.some((error) => error.includes("must be newer")));
});

test("compares numeric semantic-version prerelease components correctly", () => {
  const current = manifest({ connector: { ...manifest().connector, version: "1.0.0-beta.2" } });
  const candidate = manifest({ connector: { ...manifest().connector, version: "1.0.0-beta.10" } });
  const result = planServiceIntegrationUpdate({ current, candidate, openclawVersion: "2026.7.1-2" });
  assert.equal(result.status, "sandbox_validation_required");
  assert.equal(result.metadata_preflight_passed, true);
  assert.equal(result.sandbox_validated, false);
});

test("rejects malformed semantic-version prerelease identifiers", () => {
  const candidate = manifest({ connector: { ...manifest().connector, version: "1.0.0-01" } });
  assert.ok(validateServiceIntegrationManifest(candidate).some((error) => error.includes("exact semantic version")));
});

test("flags permission, API contract, and data-policy changes for manual review", () => {
  const current = manifest();
  const candidate = manifest({
    service: { id: "shopping-service", api_contract_version: "2026-02" },
    connector: { ...manifest().connector, version: "1.1.0" },
    authentication: { credential_ref: "env:SHOPPING_SERVICE_TOKEN", permissions: ["catalog.read", "orders.write"] },
    capabilities: [
      { name: "search_catalog", effect: "read_only", permissions: ["catalog.read"], confirmation: "not_required" },
      { name: "place_order", effect: "external_write", permissions: ["orders.write"], confirmation: "required_per_request" },
    ],
    data_policy: { categories: ["product_catalog", "order_history"], personal_data: "stored", retention_days: 30 },
  });
  const result = planServiceIntegrationUpdate({ current, candidate, openclawVersion: "2026.7.1-2" });
  assert.equal(result.status, "manual_review_and_sandbox_validation_required");
  assert.deepEqual(result.permissions.added, ["orders.write"]);
  assert.equal(result.api_contract_changed, true);
  assert.equal(result.data_policy_changed, true);
  assert.equal(result.activation_permitted, false);
  assert.equal(result.gateway_config_modified, false);
});

test("flags capability permission remapping even when the overall scope set is unchanged", () => {
  const current = manifest({
    authentication: { credential_ref: "env:SHOPPING_SERVICE_TOKEN", permissions: ["catalog.read", "orders.read"] },
    capabilities: [{ name: "search_catalog", effect: "read_only", permissions: ["catalog.read"], confirmation: "not_required" }],
  });
  const candidate = manifest({
    connector: { ...manifest().connector, version: "1.1.0" },
    authentication: { credential_ref: "env:SHOPPING_SERVICE_TOKEN", permissions: ["catalog.read", "orders.read"] },
    capabilities: [{ name: "search_catalog", effect: "read_only", permissions: ["orders.read"], confirmation: "not_required" }],
  });
  const result = planServiceIntegrationUpdate({ current, candidate, openclawVersion: "2026.7.1-2" });
  assert.equal(result.status, "manual_review_and_sandbox_validation_required");
  assert.equal(result.capability_policy_changed, true);
});

test("flags removed permissions for review even when no capability changes", () => {
  const current = manifest({
    connector: { ...manifest().connector, version: "1.0.0" },
    authentication: { credential_ref: "env:SHOPPING_SERVICE_TOKEN", permissions: ["catalog.read", "orders.read"] },
  });
  const candidate = manifest({
    connector: { ...manifest().connector, version: "1.1.0" },
    authentication: { credential_ref: "env:SHOPPING_SERVICE_TOKEN", permissions: ["catalog.read"] },
  });
  const result = planServiceIntegrationUpdate({ current, candidate, openclawVersion: "2026.7.1-2" });
  assert.equal(result.status, "manual_review_and_sandbox_validation_required");
  assert.deepEqual(result.permissions.removed, ["orders.read"]);
});

test("reports when both manual review and sandbox validation are required", () => {
  const current = manifest({ connector: { ...manifest().connector, version: "1.0.0" } });
  const candidate = manifest({
    connector: { ...manifest().connector, version: "1.1.0" },
    authentication: { credential_ref: "env:SHOPPING_SERVICE_TOKEN", permissions: ["catalog.read", "orders.write"] },
    capabilities: [
      { name: "search_catalog", effect: "read_only", permissions: ["catalog.read"], confirmation: "not_required" },
      { name: "place_order", effect: "external_write", permissions: ["orders.write"], confirmation: "required_per_request" },
    ],
    verification: { test_environment: "mock", synthetic_data_only: true },
  });
  const result = planServiceIntegrationUpdate({ current, candidate, openclawVersion: "2026.7.1-2" });
  assert.equal(result.status, "manual_review_and_sandbox_validation_required");
});

test("mock-only verification cannot be reported as service compatibility validation", () => {
  const current = manifest({ connector: { ...manifest().connector, version: "1.0.0" } });
  const candidate = manifest({
    connector: { ...manifest().connector, version: "1.1.0" },
    verification: { test_environment: "mock", synthetic_data_only: true },
  });
  const result = planServiceIntegrationUpdate({ current, candidate, openclawVersion: "2026.7.1-2" });
  assert.equal(result.status, "sandbox_validation_required");
  assert.equal(result.sandbox_validated, false);
  assert.equal(result.sandbox_validation_claimed, false);
  assert.equal(result.sandbox_validation_status, "not_verified_by_preflight");
  assert.equal(result.activation_permitted, false);
});

test("sandbox declaration remains unverified and never activates the connector", () => {
  const current = manifest({ connector: { ...manifest().connector, version: "1.0.0" } });
  const candidate = manifest({ connector: { ...manifest().connector, version: "1.1.0" } });
  const result = planServiceIntegrationUpdate({ current, candidate, openclawVersion: "2026.7.1-2" });
  assert.equal(result.status, "sandbox_validation_required");
  assert.equal(result.metadata_preflight_passed, true);
  assert.equal(result.sandbox_validation_claimed, true);
  assert.equal(result.sandbox_validation_status, "not_verified_by_preflight");
  assert.equal(result.sandbox_validated, false);
  assert.equal(result.activation_permitted, false);
  assert.equal(result.gateway_config_modified, false);
});

test("external write capabilities require at least one declared permission", () => {
  const candidate = manifest({
    authentication: { credential_ref: "env:SHOPPING_SERVICE_TOKEN", permissions: [] },
    capabilities: [{
      name: "place_order",
      effect: "external_write",
      permissions: [],
      confirmation: "required_per_request",
    }],
  });
  assert.ok(validateServiceIntegrationManifest(candidate).some((error) => error.includes("manifest.capabilities[0].permissions must be an array with at least 1 item(s)")));
});

test("CLI validates the clearly synthetic fixture without printing its credential reference", () => {
  const fixturePath = fileURLToPath(new URL("./fixtures/synthetic-openclaw-service-manifest.fixture.json", import.meta.url));
  const result = spawnSync(process.execPath, [cliPath, "--validate", fixturePath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "valid_manifest");
  assert.equal(output.service_id, "example-shopping-service");
  assert.equal(output.activation_permitted, false);
  assert.equal(result.stdout.includes("EXAMPLE_SERVICE_TOKEN"), false);
});

test("CLI update plan reports unsupported Gateway versions with a failing exit code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-service-plan-"));
  try {
    const currentFile = join(directory, "current.json");
    const candidateFile = join(directory, "candidate.json");
    const current = manifest({ connector: { ...manifest().connector, version: "1.0.0" } });
    const candidate = manifest({
      connector: { ...manifest().connector, version: "1.1.0", tested_openclaw_versions: ["2026.8.0"] },
    });
    await writeFile(currentFile, JSON.stringify(current));
    await writeFile(candidateFile, JSON.stringify(candidate));
    const result = spawnSync(process.execPath, [
      cliPath,
      "--current", currentFile,
      "--candidate", candidateFile,
      "--openclaw-version", "2026.7.1-2",
    ], { encoding: "utf8" });
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "blocked");
    assert.equal(output.activation_permitted, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI reports malformed JSON without echoing the file contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-service-invalid-"));
  try {
    const file = join(directory, "invalid.json");
    await writeFile(file, '{"api_key":"do-not-print-this-value"');
    const result = spawnSync(process.execPath, [cliPath, "--validate", file], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.equal(result.stderr.includes("do-not-print-this-value"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
