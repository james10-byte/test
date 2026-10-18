#!/usr/bin/env bash

INSTALL_DIR="${INSTALL_DIR:-/opt/inconnu-boy-apk-builder}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/inconnu-boy-apk-builder}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-3}"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_RESET=$'\033[0m'
else
  C_GREEN=""; C_YELLOW=""; C_RED=""; C_RESET=""
fi

info() { printf '%s\n' "$*"; }
ok() { printf '%s[ ok ]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s[warn]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
fail() { printf '%s[fail]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

require_root() {
  if [ "${INCONNU_SKIP_ROOT_CHECK:-0}" != "1" ] && [ "$(id -u)" -ne 0 ]; then
    fail "This script must run as root. Try: sudo bash $0"
  fi
}

require_installation() {
  if [ ! -f "$INSTALL_DIR/docker-compose.yml" ] || [ ! -f "$INSTALL_DIR/.env" ]; then
    fail "No installation found in $INSTALL_DIR."
  fi
}

env_value() {
  local key="$1" file="${2:-$INSTALL_DIR/.env}"
  [ -f "$file" ] || return 0
  grep -E "^${key}=" "$file" | tail -n 1 | cut -d= -f2- | tr -d '\r' || true
}

set_env_value() {
  local key="$1" value="$2" file="$3" temporary
  temporary="$(mktemp)"
  awk -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    index($0, key "=") == 1 { print key "=" value; found = 1; next }
    { print }
    END { if (!found) print key "=" value }
  ' "$file" > "$temporary"
  cat "$temporary" > "$file"
  rm -f "$temporary"
}

data_path() {
  local path
  path="$(env_value DATA_PATH)"
  [ -n "$path" ] || path="./data"
  case "$path" in
    /*) ;;
    *) path="$INSTALL_DIR/${path#./}" ;;
  esac
  printf '%s' "$path"
}

http_port() {
  local port
  port="$(env_value HTTP_PORT)"
  printf '%s' "${port:-3000}"
}

compose() {
  local profile=()
  if [ -n "$(env_value DOMAIN)" ]; then
    profile=(--profile https)
  fi
  docker compose --project-directory "$INSTALL_DIR" "${profile[@]}" "$@"
}

wait_for_health() {
  local url="${HEALTH_URL:-http://127.0.0.1:$(http_port)/api/health}"
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS --max-time 5 "$url" > /dev/null 2>&1; then
      return 0
    fi
    sleep "$HEALTH_INTERVAL"
  done
  return 1
}

confirm() {
  local prompt="$1" answer
  if [ "${ASSUME_YES:-0}" = "1" ]; then
    return 0
  fi
  if [ ! -t 0 ]; then
    fail "Confirmation required but no terminal is available. Re-run with --yes."
  fi
  read -r -p "$prompt [y/N] " answer
  [ "$answer" = "y" ] || [ "$answer" = "Y" ] || [ "$answer" = "yes" ]
}

current_revision() {
  git -C "$INSTALL_DIR" rev-parse --short HEAD 2> /dev/null || printf 'unknown'
}
