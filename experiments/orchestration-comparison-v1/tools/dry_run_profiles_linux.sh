#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: %s {A|B|C|all}\n' "$0" >&2
}

strategy="${1:-}"
case "$strategy" in
  A|B|C) strategies=("$strategy") ;;
  all) strategies=(A B C) ;;
  *) usage; exit 2 ;;
esac

command -v openclaw >/dev/null 2>&1 || { echo "openclaw is not on PATH" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }

version_output="$(openclaw --version 2>&1)"
case "$version_output" in
  *2026.7.1-2*) ;;
  *) echo "Expected OpenClaw 2026.7.1-2; found: $version_output" >&2; exit 1 ;;
esac

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
experiment_root="$(cd -- "$script_dir/.." && pwd)"
scratch_root="$(mktemp -d "${TMPDIR:-/tmp}/lt-orchestration-dryrun-XXXXXX")"

echo "OpenClaw: $version_output"
echo "Scratch profile files: $scratch_root"
echo "No Gateway will be started; no model request or device action will be sent."

for item in "${strategies[@]}"; do
  profile_dir="$scratch_root/$item"
  mkdir -p "$profile_dir/state"
  printf '{}\n' > "$profile_dir/openclaw.json"

  node - "$experiment_root/profiles/$item/openclaw-config.patch.json" \
    "$profile_dir/openclaw.patch.json" "$experiment_root" <<'JS'
const fs = require("node:fs");
const [source, destination, experimentRoot] = process.argv.slice(2);
const document = JSON.parse(fs.readFileSync(source, "utf8"));

function resolve(value) {
  if (typeof value === "string") return value.replaceAll("__EXP_ROOT__", experimentRoot);
  if (Array.isArray(value)) return value.map(resolve);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolve(child)]));
  }
  return value;
}

fs.writeFileSync(destination, JSON.stringify(resolve(document), null, 2) + "\n", "utf8");
JS

  export OPENCLAW_PROFILE="lt-orchestration-dryrun-${item,,}-$$"
  export OPENCLAW_CONFIG_PATH="$profile_dir/openclaw.json"
  export OPENCLAW_STATE_DIR="$profile_dir/state"

  echo "Checking strategy $item ..."
  openclaw config patch --file "$profile_dir/openclaw.patch.json" --dry-run
done

echo "All requested configuration fragments passed the local Linux CLI dry-run."
echo "This validates config schema only. It does not load a Gateway or validate tool execution."
