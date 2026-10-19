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
#   ./deploy/update.sh --mark-failed   # systemd ExecStopPost: report a killed run
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

# json_escape <text> — make arbitrary text safe inside a JSON string literal.
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s" | tr -d '\000-\037'
}

# status <state> <message> [tag]  — writes the JSON the in-app card polls.
# Best-effort: a status that cannot be written must never abort the update or
# hide the real error.
status() {
  printf '{"state":"%s","message":"%s","tag":"%s","updatedAt":"%s"}\n' \
    "$1" "$(json_escape "$2")" "$(json_escape "${3-${TAG:-}}")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > "$STATUS_FILE" 2>/dev/null || return 0
  # This script runs as root, but the app (in its container, as an unprivileged
  # user) rewrites this same file on the next request. Hand it back to the
  # control dir's owner so the app can always overwrite it. Best-effort — the
  # app also self-heals if this is ever skipped.
  chown --reference="$CONTROL_DIR" "$STATUS_FILE" 2>/dev/null || true
  chmod 0664 "$STATUS_FILE" 2>/dev/null || true
}

LOG_HINT="see: journalctl -u proxmate-updater"
STEP="Starting"
FINISHED=0

fail() {
  FINISHED=1
  status "error" "$1"
  echo "ProxMate update failed: $1" >&2
  exit 1
}

# Any other way out of this script — a failing git/docker step under `set -e`,
# an unset variable, a signal — must still leave an error status behind.
# Otherwise the in-app card keeps showing "queued"/"running" forever and nobody
# learns that the update never happened.
on_exit() {
  local rc=$?
  if [[ $rc -ne 0 && $FINISHED -eq 0 ]]; then
    status "error" "Update failed during: $STEP (exit $rc) — $LOG_HINT"
    echo "ProxMate update failed during: $STEP (exit $rc)" >&2
  fi
}
trap on_exit EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# The updater runs as root, while the checkout normally belongs to the human
# who installed it (install.sh hands it back to them). git refuses to work in a
# repository owned by someone else unless that directory is declared safe, so
# trust exactly this one checkout, for this script's git calls only.
git() { command git -c safe.directory="$PROXMATE_DIR" "$@"; }

# --mark-failed: run by systemd after the service stops. When the run was killed
# (OOM, timeout, reboot) no trap got to report it, so a status that still says
# queued/running becomes an error instead of spinning forever in the UI.
if [[ "${1:-}" == "--mark-failed" ]]; then
  FINISHED=1
  current="$(sed -nE 's/.*"state"[[:space:]]*:[[:space:]]*"([a-z]+)".*/\1/p' "$STATUS_FILE" 2>/dev/null | head -1 || true)"
  if [[ "$current" == "queued" || "$current" == "running" ]]; then
    status "error" "Updater stopped before finishing (systemd result: ${SERVICE_RESULT:-unknown}) — $LOG_HINT" ""
  fi
  exit 0
fi

cd "$PROXMATE_DIR" || fail "PROXMATE_DIR $PROXMATE_DIR not found"

TAG=""
if [[ "${1:-}" == "--from-request" ]]; then
  [[ -f "$REQUEST_FILE" ]] || { echo "no pending update request"; FINISHED=1; exit 0; }
  TAG="$(sed -nE 's/.*"tag"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$REQUEST_FILE" | head -1)"
  rm -f "$REQUEST_FILE"
elif [[ -n "${1:-}" ]]; then
  TAG="$1"
fi

STEP="Fetching release tags"
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
STEP="Checking out $TAG"
status "running" "$STEP" "$TAG"
git checkout -q --force "refs/tags/$TAG"

STEP="Building images"
status "running" "$STEP" "$TAG"
docker compose build

STEP="Restarting (applies DB migrations on boot)"
status "running" "$STEP" "$TAG"
docker compose up -d

# Prune the now-dangling previous image layers (best effort).
docker image prune -f >/dev/null 2>&1 || true

FINISHED=1
status "success" "Updated to $TAG" "$TAG"
echo "==> ProxMate is now on $TAG"
