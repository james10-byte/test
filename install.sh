#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/INCONNU-BOY/INCONNU-BOY-APK-BUILDER.git}"
VERSION="${VERSION:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/inconnu-boy-apk-builder}"
DOMAIN="${DOMAIN:-}"
OS_RELEASE_FILE="${OS_RELEASE_FILE:-/etc/os-release}"
MIN_MEMORY_MB="${MIN_MEMORY_MB:-3500}"
MIN_DISK_MB="${MIN_DISK_MB:-20000}"
NETWORK_CHECK_URL="${NETWORK_CHECK_URL:-https://github.com}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-240}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-3}"
ASSUME_YES="${ASSUME_YES:-0}"
DRY_RUN=0
HTTP_PORT_VALUE="${HTTP_PORT:-3000}"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_RESET=$'\033[0m'
else
  C_GREEN=""; C_YELLOW=""; C_RED=""; C_RESET=""
fi

info() { printf '%s\n' "$*"; }
ok() { printf '%s[ ok ]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s[warn]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
fail() { printf '%s[fail]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

on_error() {
  local line="$1"
  printf '%s[fail]%s The installation stopped at line %s. Nothing was removed. Fix the problem above and run the installer again.\n' "$C_RED" "$C_RESET" "$line" >&2
}
trap 'on_error $LINENO' ERR

usage() {
  cat <<USAGE
Usage: sudo bash install.sh [options]

Options:
  --domain <name>     Serve the platform over HTTPS on this domain (DNS must already point to this server)
  --version <ref>     Git branch or tag to install (default: main)
  --dir <path>        Installation directory (default: /opt/inconnu-boy-apk-builder)
  --yes               Do not ask questions
  --dry-run           Run every check and print the plan without changing anything
  --help              Show this help
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; fail "Unknown option: $1" ;;
  esac
done

os_value() {
  grep -E "^$1=" "$OS_RELEASE_FILE" 2> /dev/null | tail -n 1 | cut -d= -f2- | tr -d '"' || true
}

require_root() {
  if [ "${INCONNU_SKIP_ROOT_CHECK:-0}" != "1" ] && [ "$(id -u)" -ne 0 ]; then
    fail "This installer must run as root. Try: sudo bash install.sh"
  fi
  ok "Running with sufficient privileges"
}

check_os() {
  local id version
  id="$(os_value ID)"
  version="$(os_value VERSION_ID)"
  case "$id:$version" in
    ubuntu:20.04|ubuntu:22.04|ubuntu:24.04|debian:11|debian:12) ok "Operating system: $id $version" ;;
    *) fail "Unsupported operating system '${id:-unknown} ${version:-unknown}'. Supported: Ubuntu 20.04, 22.04, 24.04 and Debian 11, 12." ;;
  esac
  local machine
  machine="$(uname -m)"
  if [ "$machine" != "x86_64" ] && [ "${INCONNU_ALLOW_ARM:-0}" != "1" ]; then
    fail "Unsupported CPU architecture '$machine'. Android build tools are only supported on x86_64 here. Set INCONNU_ALLOW_ARM=1 to try anyway."
  fi
  ok "Architecture: $machine"
}

check_resources() {
  local memory_kb memory_mb disk_mb target
  memory_kb="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)"
  memory_mb=$((memory_kb / 1024))
  if [ "$memory_mb" -lt "$MIN_MEMORY_MB" ]; then
    fail "Only ${memory_mb} MB of memory found; at least ${MIN_MEMORY_MB} MB is required for Android builds."
  fi
  ok "Memory: ${memory_mb} MB"
  target="$INSTALL_DIR"
  while [ ! -d "$target" ]; do target="$(dirname "$target")"; done
  disk_mb="$(df -Pm "$target" | awk 'NR == 2 { print $4 }')"
  if [ "$disk_mb" -lt "$MIN_DISK_MB" ]; then
    fail "Only ${disk_mb} MB of free disk space on $target; at least ${MIN_DISK_MB} MB is required."
  fi
  ok "Free disk space: ${disk_mb} MB"
}

check_network() {
  if ! curl -fsS --max-time 15 -o /dev/null "$NETWORK_CHECK_URL"; then
    fail "Cannot reach $NETWORK_CHECK_URL. Check the server's internet connection and DNS."
  fi
  ok "Network connectivity"
}

validate_inputs() {
  if [ -n "$DOMAIN" ] && ! [[ "$DOMAIN" =~ ^([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$ ]]; then
    fail "'$DOMAIN' is not a valid domain name."
  fi
  if ! [[ "$VERSION" =~ ^[A-Za-z0-9._/-]+$ ]]; then
    fail "'$VERSION' is not a valid branch or tag name."
  fi
  if ! [[ "$HTTP_PORT_VALUE" =~ ^[0-9]{2,5}$ ]]; then
    fail "HTTP_PORT must be a number."
  fi
  case "$INSTALL_DIR" in
    /*) ;;
    *) fail "The installation directory must be an absolute path." ;;
  esac
}

check_existing_installation() {
  if [ -e "$INSTALL_DIR/docker-compose.yml" ] || [ -d "$INSTALL_DIR/.git" ]; then
    info "An installation already exists in $INSTALL_DIR."
    info "Nothing was changed. To upgrade it, run: sudo bash $INSTALL_DIR/scripts/update.sh"
    info "To check its health, run: sudo bash $INSTALL_DIR/scripts/doctor.sh"
    exit 0
  fi
  if [ -d "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2> /dev/null)" ]; then
    fail "$INSTALL_DIR exists and is not empty. Choose another directory with --dir."
  fi
}

ask_domain() {
  if [ -z "$DOMAIN" ] && [ "$ASSUME_YES" != "1" ] && [ -t 0 ]; then
    read -r -p "Domain name for HTTPS (leave empty to use plain HTTP on this server's IP): " DOMAIN
    validate_inputs
  fi
}

print_plan() {
  info ""
  info "Plan"
  info "  Source:      $REPO_URL ($VERSION)"
  info "  Directory:   $INSTALL_DIR"
  if [ -n "$DOMAIN" ]; then info "  Access:      https://$DOMAIN (Caddy, automatic certificates)"; else info "  Access:      http://<server-ip>:$HTTP_PORT_VALUE (no HTTPS)"; fi
}

ensure_packages() {
  local missing=()
  for tool in git curl; do
    command -v "$tool" > /dev/null 2>&1 || missing+=("$tool")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    info "Installing packages: ${missing[*]} ca-certificates gnupg"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y --no-install-recommends "${missing[@]}" ca-certificates gnupg
  fi
  ok "Required tools are present"
}

ensure_docker() {
  if docker compose version > /dev/null 2>&1 && docker info > /dev/null 2>&1; then
    ok "Docker and Docker Compose are already installed"
    return
  fi
  local id codename
  id="$(os_value ID)"
  codename="$(os_value VERSION_CODENAME)"
  info "Installing Docker Engine from the official Docker apt repository"
  export DEBIAN_FRONTEND=noninteractive
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${id}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
    "$(dpkg --print-architecture)" "$id" "$codename" > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
  docker compose version > /dev/null 2>&1 || fail "Docker Compose is not available after installation."
  ok "Docker installed"
}

fetch_source() {
  info "Downloading $REPO_URL ($VERSION)"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 --branch "$VERSION" "$REPO_URL" "$INSTALL_DIR"
  ok "Source downloaded to $INSTALL_DIR"
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

prepare_configuration() {
  local env_file="$INSTALL_DIR/.env"
  if [ -f "$env_file" ]; then
    ok "Keeping the existing configuration in $env_file"
  else
    cp "$INSTALL_DIR/.env.example" "$env_file"
    if [ -n "$DOMAIN" ]; then
      set_env_value NODE_ENV production "$env_file"
      set_env_value PUBLIC_BASE_URL "https://$DOMAIN" "$env_file"
      set_env_value TRUST_PROXY true "$env_file"
      set_env_value DOMAIN "$DOMAIN" "$env_file"
      set_env_value BIND_ADDRESS 127.0.0.1 "$env_file"
    else
      set_env_value NODE_ENV staging "$env_file"
      set_env_value PUBLIC_BASE_URL "" "$env_file"
      set_env_value BIND_ADDRESS 0.0.0.0 "$env_file"
    fi
    set_env_value HTTP_PORT "$HTTP_PORT_VALUE" "$env_file"
    set_env_value APP_VERSION "$VERSION" "$env_file"
    chmod 600 "$env_file"
    ok "Configuration written to $env_file"
  fi
  local data="$INSTALL_DIR/data"
  mkdir -p "$data/artifacts" "$data/workspaces" "$data/gradle-home" "$data/build-home" "$data/snapshots"
  if [ "$(id -u)" -eq 0 ]; then
    chown -R 10001:10001 "$data"
  fi
  chmod 750 "$data"
  ok "Persistent directories prepared in $data"
}

compose() {
  local profile=()
  if [ -n "$DOMAIN" ]; then profile=(--profile https); fi
  docker compose --project-directory "$INSTALL_DIR" "${profile[@]}" "$@"
}

start_services() {
  info "Building the images. The first build downloads the Android SDK and can take several minutes."
  compose build
  compose up -d
  ok "Containers started"
}

wait_for_health() {
  local url="${HEALTH_URL:-http://127.0.0.1:${HTTP_PORT_VALUE}/api/health}"
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  info "Waiting for the health check (up to ${HEALTH_TIMEOUT}s)"
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS --max-time 5 "$url" > /dev/null 2>&1; then
      ok "The service is healthy"
      return 0
    fi
    sleep "$HEALTH_INTERVAL"
  done
  warn "The service did not become healthy in time. Last log lines:"
  compose logs --tail 60 app >&2 || true
  fail "Health check failed. Run: sudo bash $INSTALL_DIR/scripts/doctor.sh"
}

print_summary() {
  local address
  if [ -n "$DOMAIN" ]; then
    address="https://$DOMAIN"
  else
    address="http://$(hostname -I 2> /dev/null | awk '{ print $1 }' || true):${HTTP_PORT_VALUE}"
  fi
  info ""
  info "INCONNU BOY APK BUILDER is running."
  info "  Address:     $address"
  info "  Directory:   $INSTALL_DIR"
  info "  Update:      sudo bash $INSTALL_DIR/scripts/update.sh"
  info "  Diagnostics: sudo bash $INSTALL_DIR/scripts/doctor.sh"
  info "  Backup:      sudo bash $INSTALL_DIR/scripts/backup.sh"
  if [ -z "$DOMAIN" ]; then
    info ""
    info "HTTPS: point a DNS A record at this server, open ports 80 and 443, then run:"
    info "  sudo bash $INSTALL_DIR/scripts/set-domain.sh your.domain.example"
    info "Plain HTTP exposes uploads and download links without encryption. Do not use it for sensitive projects."
  fi
}

require_root
check_os
check_resources
check_network
validate_inputs
check_existing_installation
ask_domain
print_plan

if [ "$DRY_RUN" = "1" ]; then
  info ""
  info "Dry run complete. No changes were made."
  exit 0
fi

ensure_packages
ensure_docker
fetch_source
prepare_configuration
start_services
wait_for_health
print_summary
