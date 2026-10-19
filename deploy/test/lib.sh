# Shared helpers for the plain-bash deploy tests. Sourced, not executed.
# shellcheck shell=bash

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export REPO_ROOT

WORK="$(mktemp -d "${TMPDIR:-/tmp}/proxmate-deploy-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# Keep the developer's own git config out of the fixtures, and give the fixture
# commits an identity.
export HOME="$WORK/home"
mkdir -p "$HOME"
export GIT_CONFIG_NOSYSTEM=1
git config --global user.name "deploy-test"
git config --global user.email "deploy-test@example.invalid"
git config --global init.defaultBranch main
git config --global advice.detachedHead false

PASSED=0
FAILED=0
SKIPPED=0

fail_msg() { printf '    %s\n' "$*"; return 1; }
# skip <reason>: ends the current case (cases run in a subshell) as skipped.
skip() { printf '    skipped: %s\n' "$*"; exit 77; }

assert_eq() { [ "$1" = "$2" ] || fail_msg "$3: expected '$2', got '$1'"; }
assert_ne() { [ "$1" != "$2" ] || fail_msg "$3: expected anything but '$2'"; }
assert_match() { case "$1" in *"$2"*) return 0 ;; esac; fail_msg "$3: '$1' does not contain '$2'"; }
assert_no_match() { case "$1" in *"$2"*) fail_msg "$3: '$1' contains '$2'"; return 1 ;; esac; return 0; }
assert_grep() { grep -qF -- "$1" "$2" 2>/dev/null || fail_msg "'$1' not found in $2"; }
assert_no_grep() { ! grep -qF -- "$1" "$2" 2>/dev/null || fail_msg "'$1' unexpectedly found in $2"; }
assert_file_missing() { [ ! -e "$1" ] && [ ! -L "$1" ] || fail_msg "$1 should not exist"; }
assert_regular_file() { [ -f "$1" ] && [ ! -L "$1" ] || fail_msg "$1 should be a regular file (not a symlink)"; }

# make_stubs <dir>: a fake `docker` that records every call in $STUB_LOG.
#   STUB_DOCKER_FAIL=<text>  calls whose arguments contain <text> exit 1
#   STUB_VOLUMES="a b"       `docker volume inspect <name>` succeeds for these
#   STUB_COMPOSE_CONFIG=<f>  `docker compose config` prints file <f>
make_stubs() {
  mkdir -p "$1"
  cat > "$1/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${STUB_LOG:-/dev/null}"
if [ -n "${STUB_DOCKER_FAIL:-}" ]; then
  case "$*" in *"$STUB_DOCKER_FAIL"*) echo "stub docker: failing '$*'" >&2; exit 1 ;; esac
fi
case "$1 ${2:-}" in
  "compose version") [ "${3:-}" = "--short" ] && echo 2.29.0 || echo "Docker Compose version v2.29.0" ;;
  "compose config") [ -n "${STUB_COMPOSE_CONFIG:-}" ] && cat "$STUB_COMPOSE_CONFIG" ;;
  "volume inspect")
    for v in ${STUB_VOLUMES:-}; do [ "$v" = "${3:-}" ] && { echo '[{}]'; exit 0; }; done
    echo "Error response from daemon: get ${3:-}: no such volume" >&2; exit 1 ;;
esac
exit 0
EOF
  chmod +x "$1/docker"
}

# run_cases [name...]: run the named cases, or every t_* function. Each case
# runs in its own subshell, so fixtures and env tweaks never leak between cases.
run_cases() {
  local cases=("$@") c rc
  if [ ${#cases[@]} -eq 0 ]; then
    mapfile -t cases < <(declare -F | awk '{print $3}' | grep '^t_')
  fi
  for c in "${cases[@]}"; do
    (
      T=""
      if "$c"; then exit 0; fi
      if [ -n "$T" ] && [ -f "$T/out" ]; then
        echo "    script output:"
        sed 's/^/    | /' "$T/out" | tail -n 15
      fi
      exit 1
    )
    rc=$?
    case "$rc" in
      0)  printf 'ok    %s\n' "$c"; PASSED=$((PASSED + 1)) ;;
      77) printf 'SKIP  %s\n' "$c"; SKIPPED=$((SKIPPED + 1)) ;;
      *)  printf 'FAIL  %s\n' "$c"; FAILED=$((FAILED + 1)) ;;
    esac
  done
  printf '\n%d passed, %d failed, %d skipped\n' "$PASSED" "$FAILED" "$SKIPPED"
  [ "$FAILED" -eq 0 ]
}
