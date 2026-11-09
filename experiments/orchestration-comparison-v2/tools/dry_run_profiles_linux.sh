#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: %s {A|B|C|D|all}\n' "$0" >&2
}

selection="${1:-}"
case "$selection" in
  A|B|C|D) candidates=("$selection") ;;
  all) candidates=(A B C D) ;;
  *) usage; exit 2 ;;
esac

command -v openclaw >/dev/null 2>&1 || { echo "openclaw is not on PATH" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
experiment_root="$(cd -- "$script_dir/.." && pwd)"
repo_root="$(cd -- "$script_dir/../../.." && pwd)"
expected_version="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).openclaw_version)' "$experiment_root/candidate-matrix.json")"
version_output="$(openclaw --version 2>&1)"
if [[ "$version_output" != *"$expected_version"* ]]; then
  printf 'Expected OpenClaw %s; found: %s\n' "$expected_version" "$version_output" >&2
  exit 1
fi

scratch_root="$(mktemp -d "${TMPDIR:-/tmp}/lt-orchestration-v2-dryrun-XXXXXX")"
trap 'rm -rf -- "$scratch_root"' EXIT

echo "OpenClaw: $version_output"
echo "Candidates: ${candidates[*]}"
echo "No Gateway will start; no model request, API key, or device action is used."

for candidate in "${candidates[@]}"; do
  profile_dir="$scratch_root/$candidate"
  mkdir -p "$profile_dir/state"
  printf '{}\n' > "$profile_dir/openclaw.json"

  node - "$experiment_root/profiles/$candidate/openclaw-config.patch.json" \
    "$profile_dir/openclaw.patch.json" "$experiment_root" "$repo_root" <<'NODE'
const fs = require("node:fs");
const [source, destination, experimentRoot, repoRoot] = process.argv.slice(2);
const document = JSON.parse(fs.readFileSync(source, "utf8"));

function resolvePlaceholders(value) {
  if (typeof value === "string") {
    return value
      .replaceAll("__EXP_ROOT__", experimentRoot)
      .replaceAll("__REPO_ROOT__", repoRoot);
  }
  if (Array.isArray(value)) return value.map(resolvePlaceholders);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolvePlaceholders(child)]));
  }
  return value;
}

const resolvedDocument = resolvePlaceholders(document);
for (const agent of resolvedDocument.agents?.list ?? []) {
  if (typeof agent.workspace !== "string") continue;
  let isDirectory = false;
  try { isDirectory = fs.statSync(agent.workspace).isDirectory(); } catch {}
  if (!isDirectory) throw new Error(`Workspace for agent '${agent.id}' does not exist: ${agent.workspace}`);
}

fs.writeFileSync(destination, `${JSON.stringify(resolvedDocument, null, 2)}\n`, "utf8");
NODE

  export OPENCLAW_PROFILE="lt-orchestration-v2-${candidate,,}-dryrun-$$"
  export OPENCLAW_CONFIG_PATH="$profile_dir/openclaw.json"
  export OPENCLAW_STATE_DIR="$profile_dir/state"

  printf 'Checking candidate %s ...\n' "$candidate"
  openclaw config patch --file "$profile_dir/openclaw.patch.json" --dry-run
done

echo "All selected candidate config fragments passed OpenClaw CLI dry-run."
echo "This checks config schema and isolated paths only; it does not load plugins or call the model."
