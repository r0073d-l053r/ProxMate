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
#   ./deploy/update.sh v1.3.3          # update to a specific tag
#   ./deploy/update.sh --from-request  # consume a pending in-app request (systemd)
#   ./deploy/update.sh --mark-failed   # systemd ExecStopPost: report a killed run
#
# Env:
#   PROXMATE_DIR        repo checkout (default: /opt/proxmate)
#   UPDATE_CONTROL_DIR  request/status dir (default: $PROXMATE_DIR/deploy/update-control)
#   UPDATE_CONTROL_UID / UPDATE_CONTROL_GID
#                       owner of a control dir this script has to create
#                       (default: 1000, the backend container's `node` user)
#
set -euo pipefail

PROXMATE_DIR="${PROXMATE_DIR:-/opt/proxmate}"
CONTROL_DIR="${UPDATE_CONTROL_DIR:-$PROXMATE_DIR/deploy/update-control}"
STATUS_FILE="$CONTROL_DIR/update-status.json"
REQUEST_FILE="$CONTROL_DIR/update-request.json"

# The app (uid 1000, `node`, in its container) writes the request and status
# files here, so a control dir this script has to create must belong to that
# user — created root-owned, "Install update" could never queue a request. An
# existing directory is left as it is.
if [[ ! -d "$CONTROL_DIR" ]]; then
  install -d -m 0775 -o "${UPDATE_CONTROL_UID:-1000}" -g "${UPDATE_CONTROL_GID:-1000}" "$CONTROL_DIR" 2>/dev/null \
    || mkdir -p "$CONTROL_DIR"
fi

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
#
# The control dir is writable by the app container, so whatever sits at
# update-status.json (or appears there mid-write) is not trusted: this script
# runs as root and must never write, chown or chmod THROUGH a link planted
# there. So the status is written to a fresh, randomly named file — opened with
# O_CREAT|O_EXCL (bash noclobber on a name that does not exist yet), which never
# follows a symlink — and then renamed over update-status.json. A rename
# replaces whatever entry is there; it never follows it.
status() {
  local tmp owner
  tmp="$(mktemp -u "$CONTROL_DIR/.update-status.XXXXXXXXXX" 2>/dev/null)" || return 0
  # umask 002 gives 0664 at creation, so no chmod by path is needed afterwards.
  if ! (umask 0002; set -o noclobber
        printf '{"state":"%s","message":"%s","tag":"%s","updatedAt":"%s"}\n' \
          "$1" "$(json_escape "$2")" "$(json_escape "${3-${TAG:-}}")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
          > "$tmp") 2>/dev/null; then
    return 0
  fi
  # The app (in its container, as an unprivileged user) rewrites this same file
  # on the next request, so hand it to the control dir's owner. -h: if the entry
  # was swapped for a link, change the link itself, never its target. The app
  # also self-heals if this is ever skipped.
  owner="$(stat -c '%u:%g' "$CONTROL_DIR" 2>/dev/null)" && chown -h "$owner" "$tmp" 2>/dev/null || true
  # -T: treat the destination as a file even if a directory was planted there.
  mv -fT "$tmp" "$STATUS_FILE" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
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
REQ_DIR=""
on_exit() {
  local rc=$?
  # rm -rf never follows links inside the directory it removes.
  if [[ -n "$REQ_DIR" ]]; then rm -rf "$REQ_DIR" 2>/dev/null || true; fi
  if [[ $rc -ne 0 && $FINISHED -eq 0 ]]; then
    status "error" "Update failed during: $STEP (exit $rc) — $LOG_HINT"
    echo "ProxMate update failed during: $STEP (exit $rc)" >&2
  fi
}
trap on_exit EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# The updater runs as root, while the checkout normally belongs to the human
# who installed it (install.sh hands it back to them). Run git AS that owner
# when we can: git run by root leaves root-owned objects, refs and working
# files behind, after which the owner's own git commands fail. Without runuser
# (or for an owner with no account name) fall back to running as root. Either
# way the checkout is declared safe — git otherwise refuses to work in a
# repository owned by someone else — for this script's git calls only.
#
# reclaim_for_owner <uid> <gid>: hand back to the owner whatever in .git, and
# among the tracked files and their parent directories, belongs to someone else.
# Root-owned leftovers (an earlier `sudo ./deploy/update.sh`, a `sudo git pull`)
# would otherwise make the owner's fetch fail, or make the checkout skip files
# it cannot replace while still moving HEAD. Untracked files (.env,
# docker-compose.override.yml, backups, the control dir) are never touched, and
# `chown -h` / `find` without -L never follow a link out of the checkout.
reclaim_for_owner() {
  local uid="$1" gid="$2"
  [[ -d "$PROXMATE_DIR/.git" && ! -L "$PROXMATE_DIR/.git" ]] || return 1
  find "$PROXMATE_DIR/.git" ! -user "$uid" -exec chown -h "$uid:$gid" {} + || return 1
  # pipefail (set above) makes a failing ls-files fail this too.
  command git -c safe.directory="$PROXMATE_DIR" -C "$PROXMATE_DIR" ls-files -z |
    reclaim_paths "$uid" "$gid"
}
# has_linked_ancestor <relative path>: true when any directory above it (inside
# the checkout) is a symlink. Such a path resolves to somewhere else — possibly
# outside the checkout — so it is never touched.
has_linked_ancestor() {
  local rest="$1" prefix=""
  while [[ "$rest" == */* ]]; do
    prefix="${prefix:+$prefix/}${rest%%/*}"
    rest="${rest#*/}"
    [[ -L "$PROXMATE_DIR/$prefix" ]] && return 0
  done
  return 1
}
# reclaim_paths <uid> <gid>: NUL-separated tracked paths on stdin; each path and
# its parent directories, when owned by someone else, go to <uid>:<gid>.
reclaim_paths() {
  local uid="$1" gid="$2" f p
  declare -A seen=()
  while IFS= read -r -d '' f; do
    p="$f"
    while [[ -n "$p" && -z "${seen[$p]:-}" ]]; do
      seen[$p]=1
      if ! has_linked_ancestor "$p" &&
         [[ -e "$PROXMATE_DIR/$p" || -L "$PROXMATE_DIR/$p" ]] &&
         [[ "$(stat -c %u "$PROXMATE_DIR/$p")" != "$uid" ]]; then
        chown -h "$uid:$gid" "$PROXMATE_DIR/$p" || return 1
      fi
      [[ "$p" == */* ]] || break
      p="${p%/*}"
    done
  done
}

GIT_OWNER=""
git() {
  if [[ -n "$GIT_OWNER" ]]; then
    HOME="${GIT_OWNER_HOME:-/}" runuser -u "$GIT_OWNER" -- \
      git -c safe.directory="$PROXMATE_DIR" "$@"
  else
    command git -c safe.directory="$PROXMATE_DIR" "$@"
  fi
}

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
  [[ -e "$REQUEST_FILE" || -L "$REQUEST_FILE" ]] || { echo "no pending update request"; FINISHED=1; exit 0; }
  # The request sits in the app-writable control dir, where the app can swap
  # it for a link, a FIFO or a directory at any moment. So first MOVE it into a
  # root-only directory next to the control dir (on the host, never mounted
  # into the container): a rename moves the entry itself, never what a link
  # points to, and once it is there nothing the app does can change it. Only
  # then check that it is a plain file and read it. `timeout` bounds the move
  # in case it has to fall back to copying (control dir on another filesystem).
  REQ_DIR="$(mktemp -d "$(dirname "$CONTROL_DIR")/.update-request.XXXXXX")" \
    || fail "could not create a private work directory next to the control dir"
  if ! timeout 20 mv -fT "$REQUEST_FILE" "$REQ_DIR/request" 2>/dev/null; then
    rm -rf "$REQUEST_FILE" 2>/dev/null || true
    fail "could not take the update request — ignored"
  fi
  if [[ -L "$REQ_DIR/request" || ! -f "$REQ_DIR/request" ]]; then
    fail "update request is not a regular file — ignored"
  fi
  TAG="$(head -c 4096 "$REQ_DIR/request" | sed -nE 's/.*"tag"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -1)"
  rm -rf "$REQ_DIR"
  REQ_DIR=""
elif [[ -n "${1:-}" ]]; then
  TAG="$1"
fi

# Decide who runs git (see above) — only now that there is an update to do.
if [[ $(id -u) -eq 0 ]] && command -v runuser >/dev/null 2>&1; then
  _owner_uid="$(stat -c %u "$PROXMATE_DIR" 2>/dev/null || echo 0)"
  _owner_gid="$(stat -c %g "$PROXMATE_DIR" 2>/dev/null || echo 0)"
  _owner="$(stat -c %U "$PROXMATE_DIR" 2>/dev/null || true)"
  # ...and only when the owner can actually reach and write the repository
  # (a checkout under a directory they cannot enter stays root's job), and
  # everything git will touch could be handed back to them first. Otherwise
  # this run uses git as root, as before.
  if [[ "$_owner_uid" != 0 && -n "$_owner" && "$_owner" != "UNKNOWN" ]] &&
     reclaim_for_owner "$_owner_uid" "$_owner_gid" 2>/dev/null &&
     runuser -u "$_owner" -- test -w "$PROXMATE_DIR/.git" 2>/dev/null; then
    GIT_OWNER="$_owner"
    GIT_OWNER_HOME="$(getent passwd "$_owner" 2>/dev/null | cut -d: -f6)"
  fi
fi

STEP="Fetching release tags"
git fetch --tags --prune origin

# Default to the newest semver tag when none was given.
if [[ -z "$TAG" ]]; then
  TAG="$(git tag -l 'v*' --sort=-v:refname | head -1)"
  [[ -n "$TAG" ]] || fail "no release tags found"
fi

# Validate the tag charset (defense in depth — it's passed to git checkout).
# Never echo a rejected value into the status: it is unvalidated text.
if [[ ! "$TAG" =~ ^v?[0-9A-Za-z][0-9A-Za-z._-]*$ ]]; then
  TAG=""
  fail "invalid tag (allowed: letters, digits, '.', '_' and '-')"
fi
git rev-parse -q --verify "refs/tags/$TAG^{commit}" >/dev/null 2>&1 || fail "unknown tag: $TAG"

# Never discard local edits to tracked files: a forced checkout would silently
# revert e.g. extra volume mounts added to docker-compose.yml, and the restart
# below would then bring the stack up without them. Local compose changes belong
# in docker-compose.override.yml (untracked, merged automatically by compose).
STEP="Checking for local changes"
dirty="$(git status --porcelain --untracked-files=no | sed -E 's/^.{3}//' | tr '\n' ' ' | sed 's/ $//')"
if [[ -n "$dirty" ]]; then
  fail "local changes to tracked files: ${dirty} — move compose customisations into docker-compose.override.yml (see DEPLOYMENT.md), then revert the rest (git checkout -- ${dirty}) and retry"
fi

echo "==> Updating ProxMate to $TAG"
STEP="Checking out $TAG"
status "running" "$STEP" "$TAG"
git checkout -q "refs/tags/$TAG"

# git can move HEAD and still exit 0 when it could not replace some files (for
# example in a directory it may not write to), leaving the old release's files
# on disk. Never build such a mixed tree: the checkout must be exactly the tag.
STEP="Verifying the checkout of $TAG"
head_commit="$(git rev-parse -q --verify HEAD)"
tag_commit="$(git rev-parse -q --verify "refs/tags/$TAG^{commit}")"
if [[ "$head_commit" != "$tag_commit" ]]; then
  fail "checkout of $TAG did not complete (HEAD is not the release commit) — $LOG_HINT"
fi
stale="$(git status --porcelain --untracked-files=no | sed -E 's/^.{3}//' | head -n 5 | tr '\n' ' ' | sed 's/ $//')"
if [[ -n "$stale" ]]; then
  fail "checkout of $TAG left files that do not match the release: ${stale} — nothing was built. Make them (and their directories) writable by the checkout owner ($(stat -c %U "$PROXMATE_DIR" 2>/dev/null || echo unknown)), then as the checkout owner run: git checkout -- ${stale} ; and retry the update"
fi

STEP="Building images"
status "running" "$STEP" "$TAG"
docker compose build

STEP="Restarting (applies DB migrations on boot)"
status "running" "$STEP" "$TAG"
docker compose up -d

# Prune the now-dangling previous image layers (best effort).
docker image prune -f >/dev/null 2>&1 || true

# Self-update switched on but the backend has no /control mount: the in-app
# "Install update" button is then broken. The usual cause is an update by an
# older updater, which force-checked-out the release over a docker-compose.yml
# that carried the mount. Say so (the update itself still succeeded).
WARNING=""
if compose_cfg="$(docker compose config 2>/dev/null)" &&
   grep -Eq '^[[:space:]]*SELF_UPDATE_ENABLED:[[:space:]]*"?true"?[[:space:]]*$' <<<"$compose_cfg" &&
   ! grep -Eq '^[[:space:]]*target:[[:space:]]*/control[[:space:]]*$' <<<"$compose_cfg"; then
  WARNING=" — warning: SELF_UPDATE_ENABLED is true but the backend has no /control mount, so in-app updates cannot be requested; add it to docker-compose.override.yml (DEPLOYMENT.md §14.3) and run docker compose up -d"
  echo "WARNING: SELF_UPDATE_ENABLED=true but no /control mount is configured for the backend." >&2
  echo "         Add - ./deploy/update-control:/control to docker-compose.override.yml (see DEPLOYMENT.md §14.3), then: docker compose up -d" >&2
fi

FINISHED=1
status "success" "Updated to $TAG$WARNING" "$TAG"
echo "==> ProxMate is now on $TAG"
