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
  PATH="$T/bin:$PATH" STUB_LOG="$T/docker.log" \
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
  [ "$(id -u)" -eq 0 ] || { skip "needs root"; return 0; }
  new_case
  chown -R 1000:1000 "$CHECKOUT"
  request v1.1.0
  run_update --from-request
  assert_eq "$RC" 0 "exit code (output: $(tr '\n' ' ' < "$T/out"))" &&
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

run_cases "$@"
