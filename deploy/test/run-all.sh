#!/usr/bin/env bash
#
# Run every plain-bash deploy test (update.sh, install.sh, docker-entrypoint.sh).
#   bash deploy/test/run-all.sh
# Needs only bash, coreutils and git. Run as root to include the ownership cases.
#
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rc=0
for t in "$HERE"/*.test.sh; do
  printf '── %s\n' "$(basename "$t")"
  bash "$t" || rc=1
  echo
done
exit "$rc"
