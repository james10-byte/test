#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$(dirname "$SCRIPT_DIR")}"
export INSTALL_DIR
. "$SCRIPT_DIR/lib/common.sh"

ARCHIVE=""
RESTORE_ENV=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes) export ASSUME_YES=1; shift ;;
    --restore-env) RESTORE_ENV=1; shift ;;
    --help|-h) info "Usage: sudo bash restore.sh <backup.tar.gz> [--yes] [--restore-env]"; exit 0 ;;
    -*) fail "Unknown option: $1" ;;
    *) ARCHIVE="$1"; shift ;;
  esac
done

[ -n "$ARCHIVE" ] || fail "Usage: sudo bash restore.sh <backup.tar.gz> [--yes] [--restore-env]"
[ -f "$ARCHIVE" ] || fail "Backup file not found: $ARCHIVE"

require_root
require_installation

validate_archive() {
  local names listing entry
  tar -tzf "$ARCHIVE" > /dev/null 2>&1 || fail "The file is not a readable tar.gz archive."
  names="$(tar -tzf "$ARCHIVE")"
  while IFS= read -r entry; do
    case "$entry" in
      /*|*..*) fail "The archive contains an unsafe path: $entry" ;;
      metadata.sqlite|backup-manifest.json|.env|artifacts|artifacts/*) ;;
      *) fail "The archive contains an unexpected entry: $entry" ;;
    esac
  done <<< "$names"
  listing="$(tar -tvzf "$ARCHIVE")"
  if grep -qE '^[lh]' <<< "$listing"; then
    fail "The archive contains links, which are not allowed."
  fi
  grep -qx 'metadata.sqlite' <<< "$names" || fail "The archive has no database."
  grep -qx 'backup-manifest.json' <<< "$names" || fail "The archive has no manifest."
}

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

validate_archive
tar -xzf "$ARCHIVE" -C "$STAGE" --no-same-owner --no-same-permissions
chmod 755 "$STAGE"
chmod 644 "$STAGE/metadata.sqlite"

EXPECTED_SHA="$(grep -E '"databaseSha256"' "$STAGE/backup-manifest.json" | sed -E 's/.*"databaseSha256": *"([a-f0-9]{64})".*/\1/')"
ACTUAL_SHA="$(sha256sum "$STAGE/metadata.sqlite" | cut -d' ' -f1)"
[[ "$EXPECTED_SHA" =~ ^[a-f0-9]{64}$ ]] || fail "The manifest is malformed."
[ "$EXPECTED_SHA" = "$ACTUAL_SHA" ] || fail "The database checksum does not match the manifest. The backup is corrupted."
ok "Archive structure and database checksum verified"

RESULT="$(docker compose --project-directory "$INSTALL_DIR" run --rm --no-deps -T -v "$STAGE:/check:ro" app node scripts/check-database.mjs /check/metadata.sqlite)" \
  || fail "The database in the backup failed its integrity check."
ok "Database integrity verified ($RESULT)"

info "This replaces the current metadata and artifacts. The current data is moved aside, not deleted."
confirm "Restore from $ARCHIVE?" || fail "Restore cancelled. Nothing was changed."

DATA="$(data_path)"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
ASIDE="$DATA/pre-restore-$STAMP"

compose stop || fail "Could not stop the services."
mkdir -p "$ASIDE"
for item in metadata.sqlite metadata.sqlite-wal metadata.sqlite-shm artifacts; do
  if [ -e "$DATA/$item" ]; then mv "$DATA/$item" "$ASIDE/$item"; fi
done

restore_previous() {
  warn "Restoring the previous data"
  rm -rf "$DATA/metadata.sqlite" "$DATA/metadata.sqlite-wal" "$DATA/metadata.sqlite-shm" "$DATA/artifacts"
  for item in metadata.sqlite metadata.sqlite-wal metadata.sqlite-shm artifacts; do
    if [ -e "$ASIDE/$item" ]; then mv "$ASIDE/$item" "$DATA/$item"; fi
  done
  compose up -d || true
  fail "The restore failed and the previous data was put back."
}

cp "$STAGE/metadata.sqlite" "$DATA/metadata.sqlite" || restore_previous
if [ -d "$STAGE/artifacts" ]; then cp -a "$STAGE/artifacts" "$DATA/artifacts" || restore_previous; else mkdir -p "$DATA/artifacts"; fi
if [ "$RESTORE_ENV" = "1" ] && [ -f "$STAGE/.env" ]; then
  cp "$INSTALL_DIR/.env" "$INSTALL_DIR/.env.before-restore"
  cp "$STAGE/.env" "$INSTALL_DIR/.env"
  chmod 600 "$INSTALL_DIR/.env" "$INSTALL_DIR/.env.before-restore"
  ok "Configuration restored; the previous one is in $INSTALL_DIR/.env.before-restore"
fi
chown -R 10001:10001 "$DATA" 2> /dev/null || true

compose up -d || restore_previous
if wait_for_health; then
  ok "Restore complete. The previous data is in $ASIDE and can be deleted once you have verified everything."
else
  restore_previous
fi
