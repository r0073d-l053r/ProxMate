#!/usr/bin/env bash
#
# ProxMate host-side updater.
#
# Checks out a release tag, rebuilds the Docker Compose stack, and restarts it.
# Database migrations run automatically when the backend container starts
# (docker-entrypoint.sh → `prisma migrate deploy`), so no separate migrate step.
#
# This runs ON THE HOST (not in a container) because a container can't rebuild
# and restart itself. The in-app "Install update" button only drops a request
# flag; this script — triggered by the systemd path unit, or run by hand — does
# the privileged work.
#
# Usage:
#   ./deploy/update.sh                 # update to the newest vX.Y.Z tag
#   ./deploy/update.sh v1.2.0          # update to a specific tag
#   ./deploy/update.sh --from-request  # consume a pending in-app request (systemd)
#
# Env:
#   PROXMATE_DIR        repo checkout (default: /opt/proxmate)
#   UPDATE_CONTROL_DIR  request/status dir (default: $PROXMATE_DIR/deploy/update-control)
#
set -euo pipefail

PROXMATE_DIR="${PROXMATE_DIR:-/opt/proxmate}"
CONTROL_DIR="${UPDATE_CONTROL_DIR:-$PROXMATE_DIR/deploy/update-control}"
STATUS_FILE="$CONTROL_DIR/update-status.json"
REQUEST_FILE="$CONTROL_DIR/update-request.json"

mkdir -p "$CONTROL_DIR"

# status <state> <message> [tag]  — writes the JSON the in-app card polls.
status() {
  printf '{"state":"%s","message":"%s","tag":"%s","updatedAt":"%s"}\n' \
    "$1" "$2" "${3:-${TAG:-}}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATUS_FILE"
  # This script runs as root, but the app (in its container, as an unprivileged
  # user) rewrites this same file on the next request. Hand it back to the
  # control dir's owner so the app can always overwrite it. Best-effort — the
  # app also self-heals if this is ever skipped.
  chown --reference="$CONTROL_DIR" "$STATUS_FILE" 2>/dev/null || true
  chmod 0664 "$STATUS_FILE" 2>/dev/null || true
}

fail() {
  status "error" "$1"
  echo "ProxMate update failed: $1" >&2
  exit 1
}

cd "$PROXMATE_DIR" || fail "PROXMATE_DIR $PROXMATE_DIR not found"

TAG=""
if [[ "${1:-}" == "--from-request" ]]; then
  [[ -f "$REQUEST_FILE" ]] || { echo "no pending update request"; exit 0; }
  TAG="$(sed -nE 's/.*"tag"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$REQUEST_FILE" | head -1)"
  rm -f "$REQUEST_FILE"
elif [[ -n "${1:-}" ]]; then
  TAG="$1"
fi

git fetch --tags --prune origin

# Default to the newest semver tag when none was given.
if [[ -z "$TAG" ]]; then
  TAG="$(git tag -l 'v*' --sort=-v:refname | head -1)"
  [[ -n "$TAG" ]] || fail "no release tags found"
fi

# Validate the tag charset (defense in depth — it's passed to git checkout).
[[ "$TAG" =~ ^v?[0-9A-Za-z][0-9A-Za-z._-]*$ ]] || fail "invalid tag: $TAG"
git rev-parse -q --verify "refs/tags/$TAG^{commit}" >/dev/null 2>&1 || fail "unknown tag: $TAG"

echo "==> Updating ProxMate to $TAG"
status "running" "Checking out $TAG" "$TAG"
git checkout -q --force "refs/tags/$TAG"

status "running" "Building images" "$TAG"
docker compose build

status "running" "Restarting (applies DB migrations on boot)" "$TAG"
docker compose up -d

# Prune the now-dangling previous image layers (best effort).
docker image prune -f >/dev/null 2>&1 || true

status "success" "Updated to $TAG" "$TAG"
echo "==> ProxMate is now on $TAG"
