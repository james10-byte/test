#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$(dirname "$SCRIPT_DIR")}"
export INSTALL_DIR
. "$SCRIPT_DIR/lib/common.sh"

FAILURES=0
WARNINGS=0

pass() { ok "$*"; }
problem() { printf '%s[fail]%s %s\n' "$C_RED" "$C_RESET" "$*"; FAILURES=$((FAILURES + 1)); }
caution() { printf '%s[warn]%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; WARNINGS=$((WARNINGS + 1)); }

info "INCONNU BOY APK BUILDER diagnostics"
info "Directory: $INSTALL_DIR"
info ""

if [ ! -f "$INSTALL_DIR/docker-compose.yml" ]; then
  problem "No installation found in $INSTALL_DIR"
  exit 1
fi
pass "Installation files present (revision $(current_revision))"

if [ -f "$INSTALL_DIR/.env" ]; then
  mode="$(stat -c %a "$INSTALL_DIR/.env")"
  if [ "$mode" = "600" ]; then pass ".env exists with permissions 600"; else caution ".env permissions are $mode; run: chmod 600 $INSTALL_DIR/.env"; fi
else
  problem ".env is missing"
fi

if command -v docker > /dev/null 2>&1 && docker info > /dev/null 2>&1; then
  pass "Docker is running"
else
  problem "Docker is not installed or not running"
  info ""
  info "Summary: $FAILURES problem(s), $WARNINGS warning(s)"
  exit 1
fi

if docker compose version > /dev/null 2>&1; then pass "Docker Compose is available"; else problem "Docker Compose plugin is missing"; fi

if [ -f "$INSTALL_DIR/.env" ]; then
  status="$(compose ps --format '{{.Service}} {{.State}} {{.Health}}' 2> /dev/null || true)"
  if grep -q '^app running' <<< "$status"; then
    if grep -q '^app running healthy' <<< "$status"; then pass "The app container is running and healthy"; else caution "The app container is running but not healthy yet ($status)"; fi
  else
    problem "The app container is not running"
  fi

  if curl -fsS --max-time 5 "http://127.0.0.1:$(http_port)/api/health" > /dev/null 2>&1; then
    pass "Health endpoint answers on port $(http_port)"
  else
    problem "Health endpoint does not answer on port $(http_port)"
  fi

  if compose exec -T app sh -c 'test -x "$GRADLE_COMMAND" && test -d "$ANDROID_HOME/build-tools"' > /dev/null 2>&1; then
    pass "Gradle and the Android SDK are present in the container"
  else
    problem "Gradle or the Android SDK is missing in the container; builds will fail"
  fi

  data="$(data_path)"
  if [ -d "$data" ]; then
    owner="$(stat -c %u "$data")"
    if [ "$owner" = "10001" ]; then pass "Data directory ownership is correct"; else caution "Data directory is owned by uid $owner, expected 10001; run: chown -R 10001:10001 $data"; fi
    free_mb="$(df -Pm "$data" | awk 'NR == 2 { print $4 }')"
    if [ "$free_mb" -lt 5000 ]; then caution "Only ${free_mb} MB free where data is stored"; else pass "Free disk space: ${free_mb} MB"; fi
  else
    problem "Data directory $data does not exist"
  fi

  domain="$(env_value DOMAIN)"
  if [ -n "$domain" ]; then
    if getent hosts "$domain" > /dev/null 2>&1; then pass "DNS resolves $domain"; else caution "DNS does not resolve $domain"; fi
    if [ "$(env_value NODE_ENV)" != "production" ]; then caution "A domain is set but NODE_ENV is not production"; fi
  else
    caution "No domain configured: the service is served over plain HTTP. Run scripts/set-domain.sh to enable HTTPS."
  fi
fi

memory_mb=$(( $(awk '/^MemTotal:/ { print $2 }' /proc/meminfo) / 1024 ))
if [ "$memory_mb" -lt 3500 ]; then caution "Only ${memory_mb} MB of memory; Android builds may fail"; else pass "Memory: ${memory_mb} MB"; fi

newest="$(ls -1t "$BACKUP_DIR"/backup-*.tar.gz 2> /dev/null | head -n 1 || true)"
if [ -n "$newest" ]; then pass "Latest backup: $newest"; else caution "No backup found in $BACKUP_DIR. Run scripts/backup.sh"; fi

info ""
info "Summary: $FAILURES problem(s), $WARNINGS warning(s)"
if [ "$FAILURES" -gt 0 ]; then
  info "Recent application logs:"
  compose logs --tail 30 app 2> /dev/null || true
  exit 1
fi
