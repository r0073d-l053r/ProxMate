#!/usr/bin/env bash
#
# Tests for backend/docker-entrypoint.sh's root phase — plain bash.
#
#   bash deploy/test/entrypoint.test.sh
#
# The entrypoint normally runs as root inside the container, chowns what the
# unprivileged `node` user must write, then re-execs itself via su-exec. Here
# `id`, `mkdir`, `chown` and `su-exec` are stubs that only record their calls,
# so nothing on the test machine is changed.
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/test/lib.sh
. "$HERE/lib.sh"

ENTRYPOINT="$REPO_ROOT/backend/docker-entrypoint.sh"
REAL_ID="$(command -v id)"

new_case() {
  T="$(mktemp -d "$WORK/case.XXXXXX")"
  mkdir -p "$T/bin"
  for cmd in mkdir chown su-exec; do
    printf '#!/bin/sh\necho "%s $*" >> "%s/calls.log"\nexit 0\n' "$cmd" "$T" > "$T/bin/$cmd"
    chmod +x "$T/bin/$cmd"
  done
  # A fake `id -u` that reports root; anything else goes to the real id.
  # shellcheck disable=SC2016  # $1 / $@ belong to the generated stub
  printf '#!/bin/sh\n[ "$1" = "-u" ] && { echo 0; exit 0; }\nexec %s "$@"\n' "$REAL_ID" > "$T/bin/id"
  chmod +x "$T/bin/id"
  touch "$T/calls.log"
}

run_entrypoint() {
  PATH="$T/bin:$PATH" sh "$ENTRYPOINT" >"$T/out" 2>&1
  RC=$?
}

t_control_dir_handed_to_node() {
  new_case
  mkdir -p "$T/control"
  UPDATE_CONTROL_DIR="$T/control" run_entrypoint
  assert_eq "$RC" 0 "exit code" &&
    assert_grep "chown node:node $T/control" "$T/calls.log" &&
    assert_no_grep "chown -R node:node $T/control" "$T/calls.log"
}

t_no_control_dir_no_chown() {
  new_case
  UPDATE_CONTROL_DIR="$T/absent" run_entrypoint
  assert_eq "$RC" 0 "exit code" &&
    assert_no_grep "$T/absent" "$T/calls.log"
}

run_cases "$@"
