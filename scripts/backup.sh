#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$(dirname "$SCRIPT_DIR")}"
export INSTALL_DIR
. "$SCRIPT_DIR/lib/common.sh"

KEEP="${BACKUP_KEEP:-7}"
INCLUDE_ENV=1
QUIET=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-env) INCLUDE_ENV=0; shift ;;
    --quiet) QUIET=1; shift ;;
    --output-dir) BACKUP_DIR="${2:-}"; shift 2 ;;
    --help|-h) info "Usage: sudo bash backup.sh [--no-env] [--output-dir <dir>] [--quiet]"; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

require_root
require_installation

DATA="$(data_path)"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"; rm -f "$DATA/snapshots/metadata-$STAMP.sqlite"' EXIT

mkdir -p "$BACKUP_DIR" "$DATA/snapshots"
chmod 700 "$BACKUP_DIR"

[ -f "$DATA/metadata.sqlite" ] || fail "No database found in $DATA. Has the service ever started?"

compose exec -T app node scripts/snapshot-database.mjs /data/metadata.sqlite "/data/snapshots/metadata-$STAMP.sqlite" > /dev/null \
  || fail "The database snapshot failed. Is the service running?"
cp "$DATA/snapshots/metadata-$STAMP.sqlite" "$STAGE/metadata.sqlite"

mkdir -p "$DATA/artifacts"
ARTIFACT_COUNT="$(find "$DATA/artifacts" -type f | wc -l | tr -d ' ')"
DATABASE_SHA="$(sha256sum "$STAGE/metadata.sqlite" | cut -d' ' -f1)"

cat > "$STAGE/backup-manifest.json" <<MANIFEST
{
  "format": 1,
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "revision": "$(current_revision)",
  "databaseSha256": "$DATABASE_SHA",
  "artifactCount": $ARTIFACT_COUNT,
  "includesEnvironment": $([ "$INCLUDE_ENV" = "1" ] && printf true || printf false)
}
MANIFEST

OUTPUT="$BACKUP_DIR/backup-$STAMP.tar.gz"
TAR_ARGS=(-czf "$OUTPUT" -C "$STAGE" metadata.sqlite backup-manifest.json -C "$DATA" artifacts)
if [ "$INCLUDE_ENV" = "1" ]; then
  TAR_ARGS+=(-C "$INSTALL_DIR" .env)
fi
umask 077
tar "${TAR_ARGS[@]}"
chmod 600 "$OUTPUT"

tar -tzf "$OUTPUT" > /dev/null || fail "The backup archive could not be read back."

mapfile -t OLD_BACKUPS < <(ls -1t "$BACKUP_DIR"/backup-*.tar.gz 2> /dev/null | tail -n +"$((KEEP + 1))")
for old in "${OLD_BACKUPS[@]}"; do
  rm -f "$old"
done

if [ "$QUIET" = "0" ]; then
  ok "Backup written to $OUTPUT ($ARTIFACT_COUNT artifacts, database sha256 ${DATABASE_SHA:0:12})"
  if [ "$INCLUDE_ENV" = "1" ]; then
    info "The archive contains your .env file. Store it somewhere private."
  fi
  info "Retention: the $KEEP most recent backups are kept."
fi
