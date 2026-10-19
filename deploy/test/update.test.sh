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

UPDATE_SH="$REPO_ROOT/deploy/update.sh"

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
    git add -A && git commit -qm v1.0.0 && git tag v1.0.0
    echo 1.1.0 > VERSION
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
    assert_eq "$(cat "$CHECKOUT/docker-compose.yml")" "$(cat "$T/compose.expected")" "local edit preserved" &&
    assert_eq "$(version)" 1.0.0 "checkout must not move" &&
    assert_no_grep "compose build" "$T/docker.log"
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
