#!/usr/bin/env bash
#
# Tests for install.sh — plain bash, no test framework.
#
#   bash deploy/test/install.test.sh
#
# Each case runs the real install.sh with --yes --no-start against a throwaway
# checkout (cloned from a local "origin" with one release tag), with a stub
# `docker` first on PATH. --no-start stops before any build, so nothing outside
# the case's temp dir is touched.
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/test/lib.sh
. "$HERE/lib.sh"

INSTALL_SH="$REPO_ROOT/install.sh"

new_case() {
  T="$(mktemp -d "$WORK/case.XXXXXX")"
  git init -q --bare "$T/origin.git"
  git clone -q "$T/origin.git" "$T/seed" 2>/dev/null
  (
    cd "$T/seed" || exit 1
    printf 'name: proxmate\nservices: {}\n' > docker-compose.yml
    mkdir -p backend frontend && touch backend/.keep frontend/.keep
    git add -A && git commit -qm v1.0.0 && git tag v1.0.0
    git push -q origin HEAD:refs/heads/main --tags
  ) || { echo "fixture setup failed"; exit 2; }
  CHECKOUT="$T/checkout"
  git clone -q "$T/origin.git" "$CHECKOUT" 2>/dev/null
  make_stubs "$T/bin"
}

# run_install [args...]: output in $T/out, exit code in RC.
run_install() {
  (
    unset SUDO_USER SUDO_UID SUDO_GID
    cd "$T" || exit 1
    PATH="$T/bin:$PATH" STUB_LOG="$T/docker.log" NO_COLOR=1 PROXMATE_REPO_URL="$T/origin.git" \
      bash "$INSTALL_SH" --yes --no-start --dir "$CHECKOUT" "$@" </dev/null
  ) >"$T/out" 2>&1
  RC=$?
}

env_line() { grep -E "^$1=" "$CHECKOUT/.env" 2>/dev/null | tail -n1; }

t_local_install_writes_env() {
  new_case
  run_install --local --host 10.0.0.5
  assert_eq "$RC" 0 "exit code" &&
    assert_match "$(env_line ENCRYPTION_KEY)" "ENCRYPTION_KEY=" "key written" &&
    assert_eq "$(stat -c '%a' "$CHECKOUT/.env")" 600 ".env mode"
}

# ── BUG-042: no client-controlled audit IP header on a direct (--local) install ─
t_local_install_disables_real_ip_header() {
  new_case
  run_install --local --host 10.0.0.5
  assert_eq "$RC" 0 "exit code" &&
    assert_eq "$(env_line REAL_IP_HEADER)" "REAL_IP_HEADER=" "REAL_IP_HEADER is explicitly empty"
}

run_cases "$@"
