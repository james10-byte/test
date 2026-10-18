#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$(dirname "$SCRIPT_DIR")}"
export INSTALL_DIR
. "$SCRIPT_DIR/lib/common.sh"

DOMAIN="${1:-}"
[ -n "$DOMAIN" ] || fail "Usage: sudo bash set-domain.sh <domain>"
[[ "$DOMAIN" =~ ^([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$ ]] || fail "'$DOMAIN' is not a valid domain name."

require_root
require_installation

ENV_FILE="$INSTALL_DIR/.env"
cp "$ENV_FILE" "$ENV_FILE.before-domain"
chmod 600 "$ENV_FILE.before-domain"
set_env_value NODE_ENV production "$ENV_FILE"
set_env_value PUBLIC_BASE_URL "https://$DOMAIN" "$ENV_FILE"
set_env_value TRUST_PROXY true "$ENV_FILE"
set_env_value DOMAIN "$DOMAIN" "$ENV_FILE"
set_env_value BIND_ADDRESS 127.0.0.1 "$ENV_FILE"
ok "Configuration updated. The previous file was saved as $ENV_FILE.before-domain"

compose up -d
if wait_for_health; then
  ok "HTTPS is being served for $DOMAIN. Certificates are issued on the first request; DNS and ports 80 and 443 must be reachable."
else
  cp "$ENV_FILE.before-domain" "$ENV_FILE"
  compose up -d || true
  fail "The service did not become healthy. The previous configuration was restored."
fi
