#!/usr/bin/env bash
set +x
set -euo pipefail

readonly SECRET_LABEL="LT Agent orchestration experiment API key"
readonly SECRET_APPLICATION="lt-agent-program"
readonly SECRET_PURPOSE="orchestration-comparison-model-api-key"
readonly SECRET_ENV_NAME="LT_EXPERIMENT_API_KEY"
secret_tool="${SECRET_TOOL:-secret-tool}"

usage() {
  printf 'Usage: %s {store|check|with-key -- command [args...]}\n' "$0" >&2
}

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

command -v "$secret_tool" >/dev/null 2>&1 || fail "secret-tool is unavailable; install libsecret-tools and use a signed-in Linux session with Secret Service."

lookup_key() {
  "$secret_tool" lookup application "$SECRET_APPLICATION" purpose "$SECRET_PURPOSE"
}

action="${1:-}"
if [[ $# -gt 0 ]]; then shift; fi

case "$action" in
  store)
    if lookup_key >/dev/null 2>&1; then
      printf 'API key is already stored in this Linux user Secret Service.\n'
      exit 0
    fi
    [[ -r /dev/tty && -w /dev/tty ]] || fail "Store requires an interactive terminal; no key was read."
    api_key=""
    if ! IFS= read -r -s -p 'DeepSeek API key (hidden input): ' api_key </dev/tty; then
      printf '\n' >/dev/tty
      unset api_key
      fail "No key was read; nothing was stored."
    fi
    printf '\n' >/dev/tty
    if [[ -z "$api_key" ]]; then
      unset api_key
      fail "The API key cannot be empty."
    fi
    if ! printf '%s' "$api_key" | "$secret_tool" store \
      --label="$SECRET_LABEL" \
      application "$SECRET_APPLICATION" \
      purpose "$SECRET_PURPOSE"; then
      unset api_key
      fail "Secret Service did not store the key; no file or environment fallback was used."
    fi
    unset api_key
    printf 'API key saved in this Linux user Secret Service.\n'
    ;;
  check)
    if lookup_key >/dev/null 2>&1; then
      printf 'API key is available in this Linux user Secret Service.\n'
    else
      fail "API key is unavailable. Run this helper with 'store' in a signed-in desktop session."
    fi
    ;;
  with-key)
    if [[ "${1:-}" == "--" ]]; then shift; fi
    [[ $# -gt 0 ]] || { usage; exit 2; }
    if ! api_key="$(lookup_key)" || [[ -z "$api_key" ]]; then
      unset api_key
      fail "API key is unavailable. Run this helper with 'store' in a signed-in desktop session."
    fi
    export "$SECRET_ENV_NAME=$api_key"
    unset api_key
    exec "$@"
    ;;
  *)
    usage
    exit 2
    ;;
esac
