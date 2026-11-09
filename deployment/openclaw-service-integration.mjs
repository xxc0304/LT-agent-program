#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const manifestSchema = JSON.parse(readFileSync(new URL("./openclaw-service-integration.schema.json", import.meta.url), "utf8"));
const properties = manifestSchema.properties;
const schemaKeys = (schema) => Object.keys(schema.properties);
const TOP_LEVEL_KEYS = schemaKeys(manifestSchema);
const SERVICE_KEYS = schemaKeys(properties.service);
const CONNECTOR_KEYS = schemaKeys(properties.connector);
const AUTHENTICATION_KEYS = schemaKeys(properties.authentication);
const CAPABILITY_KEYS = schemaKeys(properties.capabilities.items);
const DATA_POLICY_KEYS = schemaKeys(properties.data_policy);
const VERIFICATION_KEYS = schemaKeys(properties.verification);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const CREDENTIAL_TEXT = /\b(?:bearer\s+\S+|sk-[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9]{20,}|api[_ -]?key\s*[:=]\s*\S+|access[_ -]?token\s*[:=]\s*\S+|password\s*[:=]\s*\S+)\b/i;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkKeys(value, allowed, path, errors) {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${path}.${key} is not supported`);
  }
  return true;
}

function checkString(value, path, errors, { pattern, minLength = 1 } = {}) {
  if (typeof value !== "string" || value.trim().length < minLength) {
    errors.push(`${path} must be a non-empty string`);
    return false;
  }
  let valid = true;
  if (CREDENTIAL_TEXT.test(value)) {
    errors.push(`${path} looks like inline credential material; use a credential reference`);
    valid = false;
  }
  if (pattern && !pattern.test(value)) {
    errors.push(`${path} has an unsupported format`);
    valid = false;
  }
  return valid;
}

function checkStringArray(value, path, errors, { minItems = 0, pattern } = {}) {
  if (!Array.isArray(value) || value.length < minItems) {
    errors.push(`${path} must be an array with at least ${minItems} item(s)`);
    return [];
  }
  const seen = new Set();
  value.forEach((item, index) => {
    if (!checkString(item, `${path}[${index}]`, errors, { pattern })) return;
    if (seen.has(item)) errors.push(`${path} must not contain duplicates`);
    seen.add(item);
  });
  return value;
}

function compareVersions(left, right) {
  const a = SEMVER.exec(left);
  const b = SEMVER.exec(right);
  if (!a || !b) return null;
  for (let index = 1; index <= 3; index += 1) {
    const delta = Number(a[index]) - Number(b[index]);
    if (delta !== 0) return Math.sign(delta);
  }
  if (a[4] === b[4]) return 0;
  if (!a[4]) return 1;
  if (!b[4]) return -1;
  const aParts = a[4].split(".");
  const bParts = b[4].split(".");
  for (let index = 0; index < Math.max(aParts.length, bParts.length); index += 1) {
    if (aParts[index] === undefined) return -1;
    if (bParts[index] === undefined) return 1;
    if (aParts[index] === bParts[index]) continue;
    const aNumeric = /^\d+$/.test(aParts[index]);
    const bNumeric = /^\d+$/.test(bParts[index]);
    if (aNumeric && bNumeric) return Math.sign(Number(aParts[index]) - Number(bParts[index]));
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return aParts[index] < bParts[index] ? -1 : 1;
  }
  return 0;
}

export function validateServiceIntegrationManifest(manifest) {
  const errors = [];
  if (!checkKeys(manifest, TOP_LEVEL_KEYS, "manifest", errors)) return errors;
  if (manifest.schema_version !== 1) errors.push("manifest.schema_version must equal 1");

  if (checkKeys(manifest.service, SERVICE_KEYS, "manifest.service", errors)) {
    checkString(manifest.service.id, "manifest.service.id", errors, { pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/ });
    checkString(manifest.service.api_contract_version, "manifest.service.api_contract_version", errors);
  }

  if (checkKeys(manifest.connector, CONNECTOR_KEYS, "manifest.connector", errors)) {
    checkString(manifest.connector.package_name, "manifest.connector.package_name", errors, {
      pattern: /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/,
    });
    checkString(manifest.connector.plugin_id, "manifest.connector.plugin_id", errors, { pattern: /^[a-z0-9][a-z0-9._-]*$/ });
    if (!checkString(manifest.connector.version, "manifest.connector.version", errors, { pattern: SEMVER })) {
      errors.push("manifest.connector.version must be an exact semantic version");
    }
    const versions = checkStringArray(manifest.connector.tested_openclaw_versions, "manifest.connector.tested_openclaw_versions", errors, {
      minItems: 1,
      pattern: SEMVER,
    });
    for (const version of versions) {
      if (!SEMVER.test(version)) errors.push("manifest.connector.tested_openclaw_versions entries must be exact semantic versions");
    }
  }

  if (checkKeys(manifest.authentication, AUTHENTICATION_KEYS, "manifest.authentication", errors)) {
    checkString(manifest.authentication.credential_ref, "manifest.authentication.credential_ref", errors, {
      pattern: /^(?:env:[A-Z][A-Z0-9_]*|secret-store:[a-z0-9][a-z0-9._/-]*)$/,
    });
    checkStringArray(manifest.authentication.permissions, "manifest.authentication.permissions", errors, {
      pattern: /^[a-zA-Z0-9][a-zA-Z0-9:._/-]*$/,
    });
  }

  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    errors.push("manifest.capabilities must contain at least one declared capability");
  } else {
    const names = new Set();
    manifest.capabilities.forEach((capability, index) => {
      const path = `manifest.capabilities[${index}]`;
      if (!checkKeys(capability, CAPABILITY_KEYS, path, errors)) return;
      checkString(capability.name, `${path}.name`, errors, { pattern: /^[a-z0-9][a-z0-9._-]*$/ });
      if (names.has(capability.name)) errors.push(`${path}.name duplicates another capability`);
      names.add(capability.name);
      if (!["read_only", "planning", "external_write"].includes(capability.effect)) {
        errors.push(`${path}.effect must be read_only, planning, or external_write`);
      }
      const permissions = checkStringArray(capability.permissions, `${path}.permissions`, errors, {
        minItems: capability.effect === "external_write" ? 1 : 0,
        pattern: /^[a-zA-Z0-9][a-zA-Z0-9:._/-]*$/,
      });
      const declaredPermissions = new Set(manifest.authentication?.permissions ?? []);
      for (const permission of permissions) {
        if (!declaredPermissions.has(permission)) errors.push(`${path}.permissions contains a permission not declared by authentication`);
      }
      if (!["required_per_request", "not_required"].includes(capability.confirmation)) {
        errors.push(`${path}.confirmation must be required_per_request or not_required`);
      }
      if (capability.effect === "external_write" && capability.confirmation !== "required_per_request") {
        errors.push(`${path}.external_write requires per-request user confirmation`);
      }
    });
  }

  if (checkKeys(manifest.data_policy, DATA_POLICY_KEYS, "manifest.data_policy", errors)) {
    checkStringArray(manifest.data_policy.categories, "manifest.data_policy.categories", errors);
    if (!["none", "transient", "stored"].includes(manifest.data_policy.personal_data)) {
      errors.push("manifest.data_policy.personal_data must be none, transient, or stored");
    }
    const retention = manifest.data_policy.retention_days;
    if (retention !== null && (!Number.isSafeInteger(retention) || retention < 0)) {
      errors.push("manifest.data_policy.retention_days must be a non-negative integer or null");
    }
    if (manifest.data_policy.personal_data === "stored" && (!Number.isSafeInteger(retention) || retention < 1)) {
      errors.push("stored personal data requires a positive retention_days value");
    }
  }

  if (checkKeys(manifest.verification, VERIFICATION_KEYS, "manifest.verification", errors)) {
    if (!["mock", "sandbox"].includes(manifest.verification.test_environment)) {
      errors.push("manifest.verification.test_environment must be mock or sandbox");
    }
    if (manifest.verification.synthetic_data_only !== true) {
      errors.push("manifest.verification.synthetic_data_only must be true");
    }
  }

  return errors;
}

function sorted(values) {
  return [...values].sort();
}

function setDifference(next, previous) {
  const prior = new Set(previous);
  return sorted(next.filter((item) => !prior.has(item)));
}

export function planServiceIntegrationUpdate({ current, candidate, openclawVersion }) {
  const errors = [
    ...validateServiceIntegrationManifest(current).map((error) => `current: ${error}`),
    ...validateServiceIntegrationManifest(candidate).map((error) => `candidate: ${error}`),
  ];
  if (!SEMVER.test(openclawVersion ?? "")) errors.push("openclawVersion must be an exact semantic version");
  if (errors.length > 0) return {
    status: "blocked",
    errors,
    activation_permitted: false,
    gateway_config_modified: false,
  };

  if (current.service.id !== candidate.service.id) errors.push("service identity cannot change during an update");
  if (current.connector.package_name !== candidate.connector.package_name) errors.push("connector package cannot change during an in-place update");
  if (current.connector.plugin_id !== candidate.connector.plugin_id) errors.push("OpenClaw plugin id cannot change during an in-place update");
  const versionOrder = compareVersions(candidate.connector.version, current.connector.version);
  if (versionOrder !== 1) errors.push("candidate connector version must be newer than current");
  const openclawTested = candidate.connector.tested_openclaw_versions.includes(openclawVersion);
  if (!openclawTested) errors.push("candidate has not declared testing against the target OpenClaw version");
  if (errors.length > 0) return {
    status: "blocked",
    errors,
    activation_permitted: false,
    gateway_config_modified: false,
  };

  const currentPermissions = current.authentication.permissions;
  const nextPermissions = candidate.authentication.permissions;
  const addedPermissions = setDifference(nextPermissions, currentPermissions);
  const removedPermissions = setDifference(currentPermissions, nextPermissions);
  const capabilitySignature = (capabilities) => capabilities.map((capability) => ({
    name: capability.name,
    effect: capability.effect,
    permissions: sorted(capability.permissions),
    confirmation: capability.confirmation,
  })).sort((left, right) => left.name.localeCompare(right.name));
  const currentCapabilities = capabilitySignature(current.capabilities);
  const nextCapabilities = capabilitySignature(candidate.capabilities);
  const capabilityChanges = JSON.stringify(currentCapabilities) !== JSON.stringify(nextCapabilities);
  const normalizeDataPolicy = (policy) => ({
    categories: sorted(policy.categories),
    personal_data: policy.personal_data,
    retention_days: policy.retention_days,
  });
  const dataPolicyChanges = JSON.stringify(normalizeDataPolicy(current.data_policy))
    !== JSON.stringify(normalizeDataPolicy(candidate.data_policy));
  const credentialReferenceChanged = current.authentication.credential_ref !== candidate.authentication.credential_ref;
  const apiContractChanged = current.service.api_contract_version !== candidate.service.api_contract_version;
  const manualReviewRequired = addedPermissions.length > 0
    || removedPermissions.length > 0
    || capabilityChanges
    || dataPolicyChanges
    || credentialReferenceChanged
    || apiContractChanged;
  const sandboxValidationClaimed = candidate.verification.test_environment === "sandbox";
  const status = manualReviewRequired
    ? "manual_review_and_sandbox_validation_required"
    : "sandbox_validation_required";

  return {
    status,
    service_id: candidate.service.id,
    connector_version: { current: current.connector.version, candidate: candidate.connector.version },
    openclaw_version: openclawVersion,
    api_contract_changed: apiContractChanged,
    permissions: { added: addedPermissions, removed: removedPermissions },
    capability_policy_changed: capabilityChanges,
    data_policy_changed: dataPolicyChanges,
    credential_reference_changed: credentialReferenceChanged,
    metadata_preflight_passed: true,
    sandbox_validation_claimed: sandboxValidationClaimed,
    sandbox_validation_status: "not_verified_by_preflight",
    sandbox_validated: false,
    activation_permitted: false,
    gateway_config_modified: false,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--validate", "--current", "--candidate", "--openclaw-version"].includes(key)) {
      throw new Error(`Unknown option: ${key}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
    args[key.slice(2).replaceAll("-", "_")] = value;
  }
  const validateMode = Boolean(args.validate);
  const planMode = Boolean(args.current || args.candidate || args.openclaw_version);
  if (validateMode === planMode) throw new Error("Use either --validate <manifest.json> or --current <file> --candidate <file> --openclaw-version <version>.");
  if (planMode && (!args.current || !args.candidate || !args.openclaw_version)) {
    throw new Error("Update planning requires --current, --candidate, and --openclaw-version.");
  }
  return { ...args, mode: validateMode ? "validate" : "plan" };
}

async function readManifest(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read a valid JSON manifest: ${error instanceof Error ? error.code ?? error.name : "unknown error"}`);
  }
}

export async function runServiceIntegrationCli(argv) {
  const args = parseArgs(argv);
  let result;
  if (args.mode === "validate") {
    const manifest = await readManifest(args.validate);
    const errors = validateServiceIntegrationManifest(manifest);
    result = errors.length > 0
      ? { status: "invalid", errors, activation_permitted: false }
      : {
        status: "valid_manifest",
        service_id: manifest.service.id,
        connector_version: manifest.connector.version,
        tested_openclaw_versions: manifest.connector.tested_openclaw_versions,
        activation_permitted: false,
      };
  } else {
    result = planServiceIntegrationUpdate({
      current: await readManifest(args.current),
      candidate: await readManifest(args.candidate),
      openclawVersion: args.openclaw_version,
    });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.status !== "invalid" && result.status !== "blocked";
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  try {
    const succeeded = await runServiceIntegrationCli(process.argv.slice(2));
    if (!succeeded) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Service integration check failed"}\n`);
    process.exitCode = 2;
  }
}
