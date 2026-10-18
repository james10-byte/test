#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$(dirname "$SCRIPT_DIR")}"
export INSTALL_DIR
. "$SCRIPT_DIR/lib/common.sh"

PURGE=0
CONFIRMATION=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    --confirm) CONFIRMATION="${2:-}"; shift 2 ;;
    --yes) export ASSUME_YES=1; shift ;;
    --help|-h)
      info "Usage: sudo bash uninstall.sh [--yes] [--purge --confirm DELETE]"
      info "Without --purge the containers and images are removed; configuration, metadata and artifacts stay in $INSTALL_DIR."
      info "With --purge the whole installation directory is deleted, including data and .env. Backups in $BACKUP_DIR are never deleted."
      exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

require_root
require_installation

if [ "$PURGE" = "1" ]; then
  if [ -z "$CONFIRMATION" ]; then
    [ -t 0 ] || fail "Purging deletes all data. Re-run with: --purge --confirm DELETE"
    warn "This permanently deletes $INSTALL_DIR, including your database, APK artifacts and configuration."
    read -r -p "Type DELETE to continue: " CONFIRMATION
  fi
  [ "$CONFIRMATION" = "DELETE" ] || fail "Confirmation text did not match. Nothing was deleted."
else
  confirm "Stop and remove the containers and images?" || fail "Cancelled. Nothing was changed."
fi

compose down --remove-orphans --rmi local || warn "Some containers or images could not be removed."
ok "Containers and images removed"

if [ "$PURGE" = "1" ]; then
  case "$INSTALL_DIR" in
    /|/opt|/usr|/var|/home|/root|"") fail "Refusing to delete the unsafe path '$INSTALL_DIR'." ;;
  esac
  cd /
  rm -rf -- "$INSTALL_DIR"
  ok "Deleted $INSTALL_DIR"
  info "Backups in $BACKUP_DIR were left in place."
else
  info "Configuration, metadata and artifacts were kept in $INSTALL_DIR."
  info "To delete everything later: sudo bash $INSTALL_DIR/scripts/uninstall.sh --purge --confirm DELETE"
fi
