#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$(dirname "$SCRIPT_DIR")}"
export INSTALL_DIR
. "$SCRIPT_DIR/lib/common.sh"

TARGET=""
SKIP_BACKUP=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) TARGET="${2:-}"; shift 2 ;;
    --no-backup) SKIP_BACKUP=1; shift ;;
    --yes) export ASSUME_YES=1; shift ;;
    --help|-h) info "Usage: sudo bash update.sh [--version <tag-or-branch>] [--no-backup] [--yes]"; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

require_root
require_installation
command -v git > /dev/null 2>&1 || fail "git is required."

if [ -n "$(git -C "$INSTALL_DIR" status --porcelain --untracked-files=no)" ]; then
  fail "The installation has local changes to tracked files. Commit or revert them before updating."
fi

PREVIOUS_REVISION="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
PREVIOUS_BRANCH="$(git -C "$INSTALL_DIR" rev-parse --abbrev-ref HEAD)"
info "Current revision: $(current_revision)"

if [ "$SKIP_BACKUP" = "0" ]; then
  info "Creating a backup before updating"
  bash "$SCRIPT_DIR/backup.sh" --quiet || fail "The pre-update backup failed. Nothing was changed. Use --no-backup to skip it at your own risk."
fi

info "Fetching updates"
git -C "$INSTALL_DIR" fetch --tags --prune origin
if [ -n "$TARGET" ]; then
  [[ "$TARGET" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "'$TARGET' is not a valid branch or tag name."
  git -C "$INSTALL_DIR" checkout --quiet "$TARGET"
  if git -C "$INSTALL_DIR" symbolic-ref --quiet HEAD > /dev/null; then
    git -C "$INSTALL_DIR" merge --ff-only --quiet "origin/$TARGET"
  fi
else
  if [ "$PREVIOUS_BRANCH" = "HEAD" ]; then
    fail "The installation is pinned to a tag or commit. Choose the version with --version <tag-or-branch>."
  fi
  git -C "$INSTALL_DIR" merge --ff-only --quiet "origin/$PREVIOUS_BRANCH"
fi

NEW_REVISION="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
if [ "$NEW_REVISION" = "$PREVIOUS_REVISION" ] && [ -z "$TARGET" ]; then
  ok "Already up to date ($(current_revision))"
  exit 0
fi

set_env_value APP_VERSION "${TARGET:-$PREVIOUS_BRANCH}" "$INSTALL_DIR/.env"

rollback() {
  warn "Update failed. Returning to revision ${PREVIOUS_REVISION:0:7}"
  git -C "$INSTALL_DIR" checkout --quiet --force "$PREVIOUS_BRANCH" 2> /dev/null || git -C "$INSTALL_DIR" checkout --quiet --force "$PREVIOUS_REVISION"
  git -C "$INSTALL_DIR" reset --quiet --hard "$PREVIOUS_REVISION"
  compose build || true
  compose up -d || true
  fail "The update was rolled back. Configuration, metadata and artifacts were not touched."
}

info "Rebuilding images"
compose build || rollback
compose up -d || rollback

if wait_for_health; then
  ok "Updated to $(current_revision). Configuration, metadata and artifacts were preserved."
else
  warn "The updated service is not healthy."
  rollback
fi
