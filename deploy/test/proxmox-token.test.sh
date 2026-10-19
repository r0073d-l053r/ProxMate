#!/usr/bin/env bash
#
# Tests for deploy/proxmox-token.sh — plain bash, no test framework.
#
#   bash deploy/test/proxmox-token.test.sh
#
# Each case runs the real script with stub `pveum`, `pveversion` and `id` first on
# PATH; the stub pveum records every call in $STUB_LOG.
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/test/lib.sh
. "$HERE/lib.sh"

SCRIPT="$REPO_ROOT/deploy/proxmox-token.sh"

# new_case <pve-version> [existing...]: existing ∈ role user token
new_case() {
  T="$(mktemp -d "$WORK/case.XXXXXX")"
  mkdir -p "$T/bin"
  export STUB_LOG="$T/pveum.log"
  : > "$STUB_LOG"
  local version="$1"; shift
  local existing=" $* "
  cat > "$T/bin/pveversion" <<EOF
#!/usr/bin/env bash
echo "pve-manager/$version/abcdef (running kernel: 6.8.12-1-pve)"
EOF
  cat > "$T/bin/id" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = "-u" ] && { echo 0; exit 0; }
exec /usr/bin/id "$@"
EOF
  cat > "$T/bin/pveum" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "\$STUB_LOG"
case "\$1 \${2:-} \${3:-}" in
  "role list"*) case "$existing" in *" role "*) echo '[{"roleid":"ProxMate"}]' ;; *) echo '[]' ;; esac ;;
  "user list"*) case "$existing" in *" user "*) echo '[{"userid":"proxmate@pve"}]' ;; *) echo '[]' ;; esac ;;
  "user token list") case "$existing" in *" token "*) echo '[{"tokenid":"proxmate"}]' ;; *) echo '[]' ;; esac ;;
  "user token add") echo '{"full-tokenid":"proxmate@pve!proxmate","info":{"privsep":"1"},"value":"11111111-2222-3333-4444-555555555555"}' ;;
esac
exit 0
EOF
  chmod +x "$T/bin/"*
}

run_script() {
  PATH="$T/bin:$PATH" bash "$SCRIPT" "$@" > "$T/out" 2>&1
  RC=$?
}

t_fresh_pve9() {
  new_case 9.0.6
  run_script
  assert_eq "$RC" 0 "exit code" || return 1
  local log; log="$(cat "$STUB_LOG")"
  assert_match "$log" "role add ProxMate --privs" "creates the role" || return 1
  assert_match "$log" "VM.GuestAgent.Unrestricted" "PVE 9 guest-agent privilege" || return 1
  assert_no_match "$log" "VM.Monitor" "no VM.Monitor on PVE 9" || return 1
  assert_no_match "$log" "Mapping.Use" "no passthrough privileges by default" || return 1
  assert_match "$log" "user add proxmate@pve" "creates the user" || return 1
  assert_match "$log" "user token add proxmate@pve proxmate --privsep 1" "privsep token" || return 1
  assert_match "$log" "acl modify / --users proxmate@pve --roles ProxMate --propagate 1" "user ACL" || return 1
  assert_match "$log" "acl modify / --tokens proxmate@pve!proxmate --roles ProxMate --propagate 1" "token ACL" || return 1
  assert_grep "Token secret: 11111111-2222-3333-4444-555555555555" "$T/out"
}

t_pve8_uses_vm_monitor() {
  new_case 8.4.1
  run_script --with-ide
  assert_eq "$RC" 0 "exit code" || return 1
  local log; log="$(cat "$STUB_LOG")"
  assert_match "$log" "VM.Monitor" "PVE 8 guest-agent privilege" || return 1
  assert_no_match "$log" "VM.GuestAgent" "no PVE 9 names on PVE 8"
}

t_options_add_privileges() {
  new_case 9.0.6
  run_script --with-ide --with-passthrough
  local log; log="$(cat "$STUB_LOG")"
  assert_match "$log" "VM.GuestAgent.FileWrite" "IDE file writes" || return 1
  assert_match "$log" "Mapping.Audit,Mapping.Use" "passthrough mappings"
}

t_existing_setup_is_updated_not_recreated() {
  new_case 9.0.6 role user token
  run_script
  assert_eq "$RC" 0 "exit code" || return 1
  local log; log="$(cat "$STUB_LOG")"
  assert_match "$log" "role modify ProxMate --privs" "updates the role in place" || return 1
  assert_no_match "$log" "user add" "keeps the user" || return 1
  assert_no_match "$log" "token add" "never re-issues an existing token" || return 1
  assert_match "$log" "--tokens proxmate@pve!proxmate" "still refreshes the token ACL" || return 1
  assert_grep "already exists" "$T/out"
}

t_dry_run_changes_nothing() {
  new_case 9.0.6
  run_script --dry-run
  assert_eq "$RC" 0 "exit code" || return 1
  local log; log="$(cat "$STUB_LOG")"
  assert_no_match "$log" "role add" "no role created" || return 1
  assert_no_match "$log" "acl modify" "no ACL changed" || return 1
  assert_no_match "$log" "token add" "no token issued" || return 1
  assert_grep "pveum role add ProxMate" "$T/out"
}

t_refuses_old_releases_and_bad_names() {
  new_case 7.4.17
  run_script
  assert_ne "$RC" 0 "PVE 7 refused" || return 1
  new_case 9.0.6
  run_script --token 'bad name'
  assert_ne "$RC" 0 "bad token name refused" || return 1
  run_script --user proxmate
  assert_ne "$RC" 0 "user without realm refused"
}

run_cases "$@"
