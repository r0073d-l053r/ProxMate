#!/usr/bin/env bash
#
# Tests for deploy/update.sh — plain bash, no test framework.
#
#   bash deploy/test/update.test.sh
#
# Each case builds a throwaway "origin" repo with two release tags, a checkout
# of it, and a control dir, and puts a stub `docker` first on PATH, so the real
# update.sh runs end to end without touching Docker or the real checkout.
# Cases that need root (ownership checks) are skipped when not run as root.
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/test/lib.sh
. "$HERE/lib.sh"

UPDATE_SH="${UPDATE_SH:-$REPO_ROOT/deploy/update.sh}"

# ── fixture ──────────────────────────────────────────────────────────────────
# new_case: sets T (case dir), CHECKOUT, CONTROL; checkout starts on v1.0.0.
new_case() {
  T="$(mktemp -d "$WORK/case.XXXXXX")"
  git init -q --bare "$T/origin.git"
  git clone -q "$T/origin.git" "$T/seed" 2>/dev/null
  (
    cd "$T/seed" || exit 1
    printf 'services:\n  backend:\n    image: proxmate-backend\n' > docker-compose.yml
    echo 1.0.0 > VERSION
    mkdir -p app && echo 1.0.0 > app/data.txt
    git add -A && git commit -qm v1.0.0 && git tag v1.0.0
    echo 1.1.0 > VERSION
    echo 1.1.0 > app/data.txt
    git commit -qam v1.1.0 && git tag v1.1.0
    git push -q origin HEAD:refs/heads/main --tags
  ) || { echo "fixture setup failed"; exit 2; }
  CHECKOUT="$T/checkout"
  git clone -q "$T/origin.git" "$CHECKOUT" 2>/dev/null
  git -C "$CHECKOUT" checkout -q v1.0.0
  CONTROL="$CHECKOUT/deploy/update-control"
  mkdir -p "$CONTROL"
  make_stubs "$T/bin"
}

# run_update [args...]: runs the real update.sh; output in $T/out, exit code in RC.
run_update() {
  PATH="$T/bin:${BASE_PATH:-$PATH}" STUB_LOG="$T/docker.log" \
    PROXMATE_DIR="$CHECKOUT" UPDATE_CONTROL_DIR="$CONTROL" \
    bash "$UPDATE_SH" "$@" >"$T/out" 2>&1
  RC=$?
}

request() { printf '{"tag":"%s","requestedBy":"admin@example.com"}\n' "$1" > "$CONTROL/update-request.json"; }
status_field() { sed -nE "s/.*\"$1\":\"(([^\"\\\\]|\\\\.)*)\".*/\\1/p" "$CONTROL/update-status.json" 2>/dev/null; }
version() { cat "$CHECKOUT/VERSION"; }

# ── BUG-031: every failure ends as a visible error status ────────────────────
t_success() {
  new_case
  request v1.1.0
  printf '{"state":"queued","tag":"v1.1.0"}\n' > "$CONTROL/update-status.json"
  run_update --from-request
  assert_eq "$RC" 0 "exit code" &&
    assert_eq "$(status_field state)" success "state" &&
    assert_eq "$(version)" 1.1.0 "checked-out version" &&
    assert_file_missing "$CONTROL/update-request.json" &&
    assert_grep "compose build" "$T/docker.log" &&
    assert_grep "compose up -d" "$T/docker.log"
}

t_fetch_failure_reports_error() {
  new_case
  request v1.1.0
  printf '{"state":"queued","tag":"v1.1.0"}\n' > "$CONTROL/update-status.json"
  rm -rf "$T/origin.git"            # origin unreachable → git fetch fails
  run_update --from-request
  assert_ne "$RC" 0 "exit code" &&
    assert_eq "$(status_field state)" error "state" &&
    assert_match "$(status_field message)" "journalctl" "message points at the logs"
}

t_build_failure_reports_error() {
  new_case
  request v1.1.0
  STUB_DOCKER_FAIL="compose build" run_update --from-request
  assert_ne "$RC" 0 "exit code" &&
    assert_eq "$(status_field state)" error "state" &&
    assert_match "$(status_field message)" "Building images" "message names the failed step"
}

t_up_failure_reports_error() {
  new_case
  request v1.1.0
  STUB_DOCKER_FAIL="compose up" run_update --from-request
  assert_ne "$RC" 0 "exit code" &&
    assert_eq "$(status_field state)" error "state" &&
    assert_match "$(status_field message)" "Restarting" "message names the failed step"
}

t_checkout_owned_by_another_user() {
  # The systemd unit runs as root; install.sh hands the checkout to the human
  # who ran it. git refuses such a repo unless told it is safe.
  [ "$(id -u)" -eq 0 ] || skip "needs root"
  new_case
  chown -R 1000:1000 "$CHECKOUT"
  request v1.1.0
  run_update --from-request
  assert_eq "$RC" 0 "exit code (output: $(tr '\n' ' ' < "$T/out"))" &&
    assert_eq "$(status_field state)" success "state" &&
    assert_eq "$(version)" 1.1.0 "checked-out version"
}

t_git_runs_as_checkout_owner() {
  # Run as root, git would leave root-owned objects and refs in a checkout that
  # belongs to the human who installed it, breaking their own git use later.
  [ "$(id -u)" -eq 0 ] || skip "needs root"
  getent passwd 1000 >/dev/null 2>&1 || skip "needs a named user with uid 1000"
  command -v runuser >/dev/null 2>&1 || skip "needs runuser"
  new_case
  chmod 0755 "$WORK" "$T"
  chown -R 1000:1000 "$T/origin.git"   # a real origin is remote; here the owner must read it
  chown -R 1000:1000 "$CHECKOUT"
  request v1.1.0
  run_update --from-request
  local root_owned
  root_owned="$(find "$CHECKOUT" -path "$CONTROL" -prune -o -user 0 -print | head -5)"
  assert_eq "$RC" 0 "exit code" &&
    assert_eq "$(version)" 1.1.0 "checked-out version" &&
    assert_eq "$root_owned" "" "root-owned paths left in the checkout"
}

# owner_case: a checkout owned by uid 1000 that the owner can reach.
owner_case() {
  [ "$(id -u)" -eq 0 ] || skip "needs root"
  getent passwd 1000 >/dev/null 2>&1 || skip "needs a named user with uid 1000"
  command -v runuser >/dev/null 2>&1 || skip "needs runuser"
  new_case
  chmod 0755 "$WORK" "$T"
  chown -R 1000:1000 "$T/origin.git"   # a real origin is remote; here the owner must read it
  chown -R 1000:1000 "$CHECKOUT"
}
root_owned_in_checkout() { find "$CHECKOUT" -path "$CONTROL" -prune -o -user 0 -print | head -5; }

t_root_owned_fetch_head_left_by_sudo_run() {
  # A previous `sudo ./deploy/update.sh` (1.0.x) or `sudo git pull` leaves
  # root-owned files in .git that the owner cannot overwrite.
  owner_case
  printf '' > "$CHECKOUT/.git/FETCH_HEAD"
  chown 0:0 "$CHECKOUT/.git/FETCH_HEAD"
  chmod 0644 "$CHECKOUT/.git/FETCH_HEAD"
  request v1.1.0
  run_update --from-request
  assert_eq "$RC" 0 "exit code" &&
    assert_eq "$(status_field state)" success "state" &&
    assert_eq "$(version)" 1.1.0 "checked-out version" &&
    assert_eq "$(root_owned_in_checkout)" "" "root-owned paths left in the checkout"
}

t_root_owned_tracked_dir_updated_correctly() {
  # A root-owned directory of tracked files that change between the tags: the
  # owner cannot replace them, so without care the checkout "succeeds" with
  # HEAD at the new tag and the old files on disk.
  owner_case
  chown -R 0:0 "$CHECKOUT/app"
  request v1.1.0
  run_update --from-request
  assert_eq "$RC" 0 "exit code" &&
    assert_eq "$(status_field state)" success "state" &&
    assert_eq "$(cat "$CHECKOUT/app/data.txt")" 1.1.0 "tracked file content" &&
    assert_eq "$(root_owned_in_checkout)" "" "root-owned paths left in the checkout"
}

t_untracked_files_ownership_untouched() {
  owner_case
  printf 'x\n' > "$CHECKOUT/docker-compose.override.yml"
  printf 'K=v\n' > "$CHECKOUT/.env"
  chown 0:0 "$CHECKOUT/docker-compose.override.yml" "$CHECKOUT/.env"
  chown -R 0:0 "$CHECKOUT/app"
  request v1.1.0
  run_update --from-request
  assert_eq "$(stat -c %u "$CHECKOUT/docker-compose.override.yml")" 0 "override owner" &&
    assert_eq "$(stat -c %u "$CHECKOUT/.env")" 0 ".env owner"
}

t_reclaim_never_follows_links_out_of_checkout() {
  owner_case
  make_victim
  rm -f "$CHECKOUT/VERSION"
  ln -s "$VICTIM" "$CHECKOUT/VERSION"
  chown -h 0:0 "$CHECKOUT/VERSION"
  ln -s "$T" "$CHECKOUT/.git/outside-link"
  chown -h 0:0 "$CHECKOUT/.git/outside-link"
  # A tracked DIRECTORY replaced by a link to a root-owned directory outside the
  # checkout: the files reached through it must not be handed over either.
  mkdir -p "$T/outside"
  printf 'secret\n' > "$T/outside/data.txt"
  chmod 0600 "$T/outside/data.txt"
  chmod 0700 "$T/outside"
  rm -rf "$CHECKOUT/app"
  ln -s "$T/outside" "$CHECKOUT/app"
  chown -h 0:0 "$CHECKOUT/app"
  request v1.1.0
  run_update --from-request
  assert_victim_untouched &&
    assert_eq "$(stat -c %u "$T")" 0 "directory outside the checkout keeps its owner" &&
    assert_eq "$(stat -c '%u:%g %a' "$T/outside")" "0:0 700" "linked-to directory owner/mode" &&
    assert_eq "$(stat -c '%u:%g %a' "$T/outside/data.txt")" "0:0 600" "file behind the linked directory"
}

t_stale_checkout_reported_not_built() {
  # Run as the (non-root) owner, nothing can reclaim a root-owned directory:
  # the update must stop with a clear error, never build a mixed tree.
  owner_case
  chown -R 0:0 "$CHECKOUT/app"
  chmod 0755 "$T/bin"
  touch "$T/docker.log" "$T/out" && chown 1000:1000 "$T/docker.log" "$T/out"
  runuser -u "$(getent passwd 1000 | cut -d: -f1)" -- env PATH="$T/bin:$PATH" STUB_LOG="$T/docker.log" HOME=/ \
    PROXMATE_DIR="$CHECKOUT" UPDATE_CONTROL_DIR="$CONTROL" bash "$UPDATE_SH" v1.1.0 >"$T/out" 2>&1
  RC=$?
  assert_ne "$RC" 0 "exit code" &&
    assert_eq "$(status_field state)" error "state" &&
    assert_match "$(status_field message)" "app/data.txt" "message names the stale file" &&
    assert_match "$(status_field message)" "git checkout -- app/data.txt" "message names the recovery command" &&
    assert_match "$(status_field message)" "checkout owner" "message says who runs it" &&
    assert_no_grep "compose build" "$T/docker.log"
}

t_no_reclaim_without_an_update_to_do() {
  # --mark-failed (run after every service stop) and a trigger with no pending
  # request must not walk or chown the checkout.
  owner_case
  printf '' > "$CHECKOUT/.git/FETCH_HEAD"
  chown 0:0 "$CHECKOUT/.git/FETCH_HEAD"
  SERVICE_RESULT=success run_update --mark-failed
  assert_eq "$(stat -c %u "$CHECKOUT/.git/FETCH_HEAD")" 0 "owner after --mark-failed" || return 1
  run_update --from-request
  assert_match "$(cat "$T/out")" "no pending update request" "no-request exit" &&
    assert_eq "$(stat -c %u "$CHECKOUT/.git/FETCH_HEAD")" 0 "owner after a no-request run"
}

t_git_falls_back_without_runuser() {
  # runuser lives in sbin; without it the update still works (as root, with
  # the checkout declared safe).
  [ "$(id -u)" -eq 0 ] || skip "needs root"
  new_case
  chown -R 1000:1000 "$CHECKOUT"
  request v1.1.0
  BASE_PATH="/usr/bin:/bin" run_update --from-request
  assert_eq "$RC" 0 "exit code" &&
    assert_eq "$(status_field state)" success "state" &&
    assert_eq "$(version)" 1.1.0 "checked-out version"
}

t_mark_failed_after_kill() {
  # systemd's ExecStopPost calls --mark-failed when the run was killed (OOM,
  # timeout, reboot) and no trap got to write a status.
  new_case
  printf '{"state":"running","message":"Building images","tag":"v1.1.0"}\n' > "$CONTROL/update-status.json"
  SERVICE_RESULT=signal run_update --mark-failed
  assert_eq "$(status_field state)" error "state" &&
    assert_match "$(status_field message)" "signal" "message carries the systemd result"
}

t_mark_failed_leaves_finished_status_alone() {
  new_case
  printf '{"state":"success","message":"Updated to v1.1.0","tag":"v1.1.0"}\n' > "$CONTROL/update-status.json"
  SERVICE_RESULT=success run_update --mark-failed
  assert_eq "$(status_field state)" success "state"
}

# ── BUG-032: files in the app-writable control dir are never followed ────────
# victim: a root-owned 0600 file outside the control dir.
make_victim() {
  VICTIM="$T/victim"
  printf 'precious\n' > "$VICTIM"
  chmod 0600 "$VICTIM"
  VICTIM_STAT="$(stat -c '%u:%g %a' "$VICTIM")"
}
assert_victim_untouched() {
  assert_eq "$(cat "$VICTIM")" precious "victim contents" &&
    assert_eq "$(stat -c '%u:%g %a' "$VICTIM")" "$VICTIM_STAT" "victim owner/mode"
}

t_symlinked_status_not_followed_on_error() {
  new_case
  make_victim
  [ "$(id -u)" -eq 0 ] && chown 1000:1000 "$CONTROL"
  ln -s "$VICTIM" "$CONTROL/update-status.json"
  request vDOESNOTEXIST
  run_update --from-request
  assert_victim_untouched &&
    assert_regular_file "$CONTROL/update-status.json" &&
    assert_eq "$(status_field state)" error "state"
}

t_symlinked_status_not_followed_on_success() {
  new_case
  make_victim
  [ "$(id -u)" -eq 0 ] && chown 1000:1000 "$CONTROL"
  ln -s "$VICTIM" "$CONTROL/update-status.json"
  request v1.1.0
  run_update --from-request
  assert_victim_untouched &&
    assert_regular_file "$CONTROL/update-status.json" &&
    assert_eq "$(status_field state)" success "state"
}

t_dangling_status_symlink_not_followed() {
  new_case
  ln -s "$T/created-by-updater" "$CONTROL/update-status.json"
  request v1.1.0
  run_update --from-request
  assert_file_missing "$T/created-by-updater" &&
    assert_regular_file "$CONTROL/update-status.json"
}

t_status_handed_to_control_dir_owner() {
  [ "$(id -u)" -eq 0 ] || skip "needs root"
  new_case
  chown 1000:1000 "$CONTROL"
  request v1.1.0
  run_update --from-request
  assert_eq "$(stat -c '%u:%g %a' "$CONTROL/update-status.json")" "1000:1000 664" "status owner/mode"
}

t_symlinked_request_not_read() {
  new_case
  make_victim
  printf '{"tag":"v1.1.0"}\n' > "$VICTIM"
  VICTIM_STAT="$(stat -c '%u:%g %a' "$VICTIM")"
  ln -s "$VICTIM" "$CONTROL/update-request.json"
  run_update --from-request
  assert_eq "$(version)" 1.0.0 "checkout must not move" &&
    assert_eq "$(cat "$VICTIM")" '{"tag":"v1.1.0"}' "victim contents" &&
    assert_eq "$(status_field state)" error "state"
}

t_fifo_request_does_not_hang() {
  new_case
  mkfifo "$CONTROL/update-request.json"
  PATH="$T/bin:$PATH" STUB_LOG="$T/docker.log" PROXMATE_DIR="$CHECKOUT" UPDATE_CONTROL_DIR="$CONTROL" \
    timeout 30 bash "$UPDATE_SH" --from-request >"$T/out" 2>&1
  RC=$?
  assert_ne "$RC" 124 "updater hung on a FIFO request" &&
    assert_eq "$(status_field state)" error "state" &&
    assert_file_missing "$CONTROL/update-request.json" &&
    assert_eq "$(version)" 1.0.0 "checkout must not move"
}

t_request_moved_out_of_control_dir_before_reading() {
  # The request is taken out of the app-writable directory before it is
  # inspected, so nothing the app does afterwards can change what is read.
  new_case
  request v1.1.0
  run_update --from-request
  assert_eq "$(status_field state)" success "state" &&
    assert_file_missing "$CONTROL/update-request.json" &&
    assert_eq "$(find "$CHECKOUT/deploy" -maxdepth 1 -name '.update-request.*' | wc -l)" 0 "private work dir cleaned up"
}

t_request_swapped_for_symlink_never_followed() {
  # Stress: while the updater runs, keep swapping the request between a plain
  # file (unknown tag) and a link to a host file that names a real tag. The
  # updater must never act on the linked file's contents.
  new_case
  make_victim
  printf '{"tag":"v1.1.0"}\n' > "$VICTIM"
  printf '{"tag":"vDOESNOTEXIST"}\n' > "$T/plain.json"
  request vDOESNOTEXIST
  (
    end=$((SECONDS + 3))
    while [ "$SECONDS" -lt "$end" ]; do
      ln -sfn "$VICTIM" "$CONTROL/.swap" && mv -fT "$CONTROL/.swap" "$CONTROL/update-request.json" 2>/dev/null
      cp "$T/plain.json" "$CONTROL/.swap2" && mv -fT "$CONTROL/.swap2" "$CONTROL/update-request.json" 2>/dev/null
    done
  ) &
  local swapper=$!
  local _
  for _ in 1 2 3 4 5; do
    run_update --from-request
    [ "$(version)" = 1.0.0 ] || break
  done
  wait "$swapper"
  assert_eq "$(version)" 1.0.0 "checkout must never move to the linked file's tag"
}

t_invalid_request_tag_not_echoed() {
  new_case
  # shellcheck disable=SC2016  # the literal text is the point
  request 'v1;$(reboot)'
  run_update --from-request
  assert_eq "$(status_field state)" error "state" &&
    assert_no_match "$(cat "$CONTROL/update-status.json")" 'reboot' "status echoes the raw tag"
}

t_status_message_is_valid_json() {
  command -v python3 >/dev/null 2>&1 || skip "needs python3 to parse JSON"
  new_case
  run_update 'v1"; echo'
  python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$CONTROL/update-status.json" ||
    fail_msg "status file is not valid JSON: $(cat "$CONTROL/update-status.json")"
}

# ── BUG-033: an update never throws away the operator's local configuration ──
t_override_file_survives_update() {
  new_case
  printf 'services:\n  backend:\n    volumes:\n      - ./deploy/update-control:/control\n' \
    > "$CHECKOUT/docker-compose.override.yml"
  cp "$CHECKOUT/docker-compose.override.yml" "$T/override.expected"
  request v1.1.0
  run_update --from-request
  assert_eq "$(status_field state)" success "state" &&
    assert_eq "$(version)" 1.1.0 "checked-out version" &&
    assert_eq "$(cat "$CHECKOUT/docker-compose.override.yml")" "$(cat "$T/override.expected")" "override contents"
}

t_edited_tracked_file_blocks_update() {
  new_case
  printf '      - ./deploy/pve-ca.pem:/certs/pve-ca.pem:ro\n' >> "$CHECKOUT/docker-compose.yml"
  cp "$CHECKOUT/docker-compose.yml" "$T/compose.expected"
  request v1.1.0
  run_update --from-request
  assert_ne "$RC" 0 "exit code" &&
    assert_eq "$(status_field state)" error "state" &&
    assert_match "$(status_field message)" "docker-compose.override.yml" "message says where local edits belong" &&
    assert_match "$(status_field message)" "git checkout -- docker-compose.yml" "message says how to revert" &&
    assert_no_match "$(status_field message)" "commit" "message must not suggest committing" &&
    assert_eq "$(cat "$CHECKOUT/docker-compose.yml")" "$(cat "$T/compose.expected")" "local edit preserved" &&
    assert_eq "$(version)" 1.0.0 "checkout must not move" &&
    assert_no_grep "compose build" "$T/docker.log"
}

# An update made by an OLDER updater (which force-checked-out the release) can
# have discarded a /control mount added to docker-compose.yml. The next run of
# this updater says so instead of leaving the in-app button silently broken.
compose_config() { # <self_update true|false> <with_control_mount yes|no>
  {
    printf 'services:\n  backend:\n    environment:\n      SELF_UPDATE_ENABLED: "%s"\n    volumes:\n' "$1"
    printf '      - type: volume\n        source: proxmate-data\n        target: /data\n'
    [ "$2" = yes ] && printf '      - type: bind\n        source: %s\n        target: /control\n' "$CONTROL"
  } > "$T/compose-config.yml"
}

t_warns_when_self_update_enabled_but_control_not_mounted() {
  new_case
  compose_config true no
  STUB_COMPOSE_CONFIG="$T/compose-config.yml" run_update v1.1.0
  assert_eq "$RC" 0 "exit code" &&
    assert_eq "$(status_field state)" success "state" &&
    assert_match "$(status_field message)" "/control" "status names the missing mount" &&
    assert_grep "docker-compose.override.yml" "$T/out"
}

t_no_mount_warning_when_control_mounted() {
  new_case
  compose_config true yes
  STUB_COMPOSE_CONFIG="$T/compose-config.yml" run_update v1.1.0
  assert_eq "$(status_field message)" "Updated to v1.1.0" "message"
}

t_no_mount_warning_when_self_update_disabled() {
  new_case
  compose_config false no
  STUB_COMPOSE_CONFIG="$T/compose-config.yml" run_update v1.1.0
  assert_eq "$(status_field message)" "Updated to v1.1.0" "message"
}

# ── BUG-066: a control dir the updater creates is writable by the app ────────
t_missing_control_dir_created_for_app_user() {
  [ "$(id -u)" -eq 0 ] || skip "needs root"
  new_case
  rm -rf "$CONTROL"
  run_update v1.1.0
  assert_eq "$(stat -c '%u:%g' "$CONTROL")" 1000:1000 "control dir owner" &&
    assert_eq "$(status_field state)" success "state"
}

t_existing_control_dir_ownership_kept() {
  [ "$(id -u)" -eq 0 ] || skip "needs root"
  new_case
  chown 1234:1234 "$CONTROL"
  run_update v1.1.0
  assert_eq "$(stat -c '%u:%g' "$CONTROL")" 1234:1234 "control dir owner"
}

run_cases "$@"
