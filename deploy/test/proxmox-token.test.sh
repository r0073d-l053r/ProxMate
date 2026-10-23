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

# new_case <pve-version> [existing...]: existing ∈ role poolroles user token pool
#   otherpool rootacl guestacl poolmembers
#   poolroles: the pool-mode roles exist; pool: the pool "proxmate" exists;
#   otherpool: only a pool "proxmate-old" exists; rootacl: the ProxMate role is
#   granted on / to the user and the token; guestacl: the token holds ProxMate-Guest
#   on /pool/proxmate; poolmembers: the pool holds a guest (pvesh); staleacl: the
#   token holds ProxMate-Guest on /pool/oldpool and ProxMate-Storage on /storage/old
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
  "role list"*)
    case "$existing" in
      *" poolroles "*) echo '[{"roleid":"ProxMate-Guest"},{"roleid":"ProxMate-Infra"},{"roleid":"ProxMate-Storage"},{"roleid":"ProxMate-Cluster"}]' ;;
      *" role "*) echo '[{"roleid":"ProxMate"}]' ;;
      *) echo '[]' ;;
    esac ;;
  "pool list"*)
    case "$existing" in
      *" pool "*) echo '[{"poolid":"proxmate"}]' ;;
      *" otherpool "*) echo '[{"poolid":"proxmate-old"}]' ;;
      *) echo '[]' ;;
    esac ;;
  "acl list"*)
    entries=""
    case "$existing" in *" rootacl "*) entries='{"path":"/","propagate":1,"roleid":"ProxMate","type":"user","ugid":"proxmate@pve"},{"path":"/","propagate":1,"roleid":"ProxMate","type":"token","ugid":"proxmate@pve!proxmate"}' ;; esac
    case "$existing" in *" guestacl "*) entries="\${entries:+\$entries,}"'{"path":"/pool/proxmate","propagate":1,"roleid":"ProxMate-Guest","type":"token","ugid":"proxmate@pve!proxmate"}' ;; esac
    case "$existing" in *" staleacl "*) entries="\${entries:+\$entries,}"'{"path":"/pool/proxmate","propagate":1,"roleid":"ProxMate-Guest","type":"token","ugid":"proxmate@pve!proxmate"},{"path":"/pool/oldpool","propagate":1,"roleid":"ProxMate-Guest","type":"token","ugid":"proxmate@pve!proxmate"},{"path":"/storage/old","propagate":1,"roleid":"ProxMate-Storage","type":"token","ugid":"proxmate@pve!proxmate"},{"path":"/storage/old","propagate":1,"roleid":"ProxMate-Storage","type":"user","ugid":"proxmate@pve"}' ;; esac
    echo "[\$entries]" ;;
  "user list"*) case "$existing" in *" user "*) echo '[{"userid":"proxmate@pve"}]' ;; *) echo '[]' ;; esac ;;
  "user token list") case "$existing" in *" token "*) echo '[{"tokenid":"proxmate"}]' ;; *) echo '[]' ;; esac ;;
  "user token add") echo '{"full-tokenid":"proxmate@pve!proxmate","info":{"privsep":"1"},"value":"11111111-2222-3333-4444-555555555555"}' ;;
esac
exit 0
EOF
  cat > "$T/bin/pvesh" <<EOF
#!/usr/bin/env bash
printf 'pvesh %s\n' "\$*" >> "\$STUB_LOG"
case "\$2" in
  /storage/local) echo '{"storage":"local","content":"iso,vztmpl,backup,snippets,import"}'; exit 0 ;;
  /storage/*) echo '{"storage":"x","content":"snippets"}'; exit 0 ;;
esac
case "$existing" in
  *" poolmembers "*) echo '[{"poolid":"proxmate","members":[{"type":"qemu","vmid":100}]}]' ;;
  *) echo '[{"poolid":"proxmate","members":[]}]' ;;
esac
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
  assert_match "$log" "VM.GuestAgent.FileWrite" "guest file writes by default" || return 1
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
  assert_match "$log" "VM.GuestAgent.FileWrite" "--with-ide still accepted" || return 1
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

# ─── --pool: guest privileges on /pool/<name>, the rest on the infra paths ───

# role_line <role>: the logged `pveum role add|modify <role> --privs …` call
role_line() { grep -E "^role (add|modify) $1 --privs" "$STUB_LOG"; }
# line_no <text>: the first log line containing <text> (0 when absent)
line_no() { grep -nF -- "$1" "$STUB_LOG" | head -n1 | cut -d: -f1 | grep . || echo 0; }

t_pool_fresh_splits_the_role_by_path() {
  new_case 9.0.6
  run_script --pool proxmate
  assert_eq "$RC" 0 "exit code" || return 1
  local log guest infra storage cluster
  log="$(cat "$STUB_LOG")"
  guest="$(role_line ProxMate-Guest)"; infra="$(role_line ProxMate-Infra)"
  storage="$(role_line ProxMate-Storage)"; cluster="$(role_line ProxMate-Cluster)"
  assert_match "$guest" "VM.Allocate" "guest role: VM privileges" || return 1
  assert_match "$guest" "VM.GuestAgent.Unrestricted" "guest role: guest agent" || return 1
  assert_match "$guest" "Pool.Audit,Pool.Allocate" "guest role: pool privileges" || return 1
  assert_no_match "$guest" "Datastore." "no storage privileges on the pool" || return 1
  assert_no_match "$guest" "Sys." "no system privileges on the pool" || return 1
  assert_match "$infra" "Datastore.AllocateSpace" "infra role: disk allocation" || return 1
  assert_no_match "$infra" "Datastore.Allocate," "no Datastore.Allocate on every storage" || return 1
  assert_match "$infra" "SDN.Use" "infra role: SDN" || return 1
  assert_match "$infra" "Sys.Audit" "infra role: node audit" || return 1
  assert_match "$infra" "Sys.AccessNetwork" "infra role: downloads without Sys.Modify (9.x)" || return 1
  assert_no_match "$infra" "VM." "no guest privileges outside the pool" || return 1
  assert_no_match "$infra" "Sys.Modify" "no Sys.Modify on /nodes" || return 1
  assert_eq "$storage" "" "no Datastore.Allocate anywhere unless asked for" || return 1
  assert_eq "$cluster" "role add ProxMate-Cluster --privs Sys.Audit" "cluster role: no Sys.Modify by default" || return 1
  assert_no_match "$log" "role add ProxMate --privs" "no full role in pool mode" || return 1
  assert_match "$log" "pool add proxmate" "creates the pool" || return 1
  local who
  for who in "--users proxmate@pve" "--tokens proxmate@pve!proxmate"; do
    assert_match "$log" "acl modify /pool/proxmate $who --roles ProxMate-Guest --propagate 1" "pool ACL ($who)" || return 1
    assert_match "$log" "acl modify /nodes $who --roles ProxMate-Infra --propagate 1" "nodes ACL ($who)" || return 1
    assert_match "$log" "acl modify /storage $who --roles ProxMate-Infra --propagate 1" "storage ACL ($who)" || return 1
    assert_match "$log" "acl modify /sdn/zones $who --roles ProxMate-Infra --propagate 1" "SDN ACL ($who)" || return 1
    assert_match "$log" "acl modify / $who --roles ProxMate-Cluster --propagate 0" "root ACL, this path only ($who)" || return 1
  done
  assert_no_match "$log" "acl modify /storage/" "no per-storage ACL by default" || return 1
  assert_no_match "$log" "--roles ProxMate --propagate" "nothing grants the full role" || return 1
  assert_no_match "$log" "/mapping" "no mapping ACL without passthrough" || return 1
  assert_grep "Sys.Modify on / is not granted: enable the cluster firewall once by hand" "$T/out" || return 1
  assert_grep "Token secret: 11111111-2222-3333-4444-555555555555" "$T/out" || return 1
  assert_grep 'Set "Proxmox pool" to proxmate in ProxMate' "$T/out"
}

t_pool_named_storages_get_datastore_allocate() {
  new_case 9.0.6
  run_script --pool proxmate --snippet-storage cephfs --import-storage nfs-iso
  assert_eq "$RC" 0 "exit code" || return 1
  local log s; log="$(cat "$STUB_LOG")"
  assert_eq "$(role_line ProxMate-Storage)" "role add ProxMate-Storage --privs Datastore.Allocate,Datastore.AllocateSpace,Datastore.AllocateTemplate,Datastore.Audit" "storage role" || return 1
  for s in cephfs nfs-iso; do
    assert_match "$log" "acl modify /storage/$s --tokens proxmate@pve!proxmate --roles ProxMate-Storage --propagate 1" "$s" || return 1
  done
  assert_no_grep "also holds" "$T/out"
}

t_pool_warns_when_a_named_storage_holds_volumes() {
  new_case 9.0.6
  run_script --pool proxmate --snippet-storage local --import-storage local
  assert_eq "$RC" 0 "exit code" || return 1
  [ "$(grep -c "acl modify /storage/local --tokens" "$STUB_LOG")" = 1 ] || fail_msg "one ACL for one storage named twice" || return 1
  assert_grep "Warning: storage local also holds iso,vztmpl,backup,snippets,import" "$T/out"
}

t_pool_removes_stale_acls_from_an_earlier_run() {
  new_case 9.0.6 poolroles user token pool staleacl
  run_script --pool proxmate
  assert_eq "$RC" 0 "exit code" || return 1
  local log; log="$(cat "$STUB_LOG")"
  assert_match "$log" "acl delete /pool/oldpool --tokens proxmate@pve!proxmate --roles ProxMate-Guest" "old pool grant" || return 1
  assert_match "$log" "acl delete /storage/old --tokens proxmate@pve!proxmate --roles ProxMate-Storage" "old storage grant (token)" || return 1
  assert_match "$log" "acl delete /storage/old --users proxmate@pve --roles ProxMate-Storage" "old storage grant (user)" || return 1
  assert_no_match "$log" "acl delete /pool/proxmate" "the current pool grant stays"
}

t_pool_dry_run_shows_stale_acl_removal() {
  new_case 9.0.6 poolroles user token pool staleacl
  run_script --dry-run --pool proxmate
  assert_eq "$RC" 0 "exit code" || return 1
  assert_no_match "$(cat "$STUB_LOG")" "acl delete" "nothing removed" || return 1
  assert_grep "pveum acl delete /pool/oldpool --tokens proxmate@pve!proxmate --roles ProxMate-Guest" "$T/out"
}

t_pool_cluster_firewall_is_opt_in() {
  new_case 9.0.6
  run_script --pool proxmate --with-cluster-firewall
  assert_eq "$RC" 0 "exit code" || return 1
  assert_eq "$(role_line ProxMate-Cluster)" "role add ProxMate-Cluster --privs Sys.Audit,Sys.Modify" "cluster role" || return 1
  assert_grep "the pool does" "$T/out" || return 1
  assert_grep "not fully contain it" "$T/out"
}

t_pool_before_8_2_falls_back_to_sys_modify() {
  new_case 8.1.4
  run_script --pool proxmate
  assert_eq "$RC" 0 "exit code" || return 1
  assert_no_match "$(role_line ProxMate-Infra)" "Sys.AccessNetwork" "no such privilege before 8.2" || return 1
  assert_eq "$(role_line ProxMate-Cluster)" "role add ProxMate-Cluster --privs Sys.Audit,Sys.Modify" "downloads need Sys.Modify on /" || return 1
  assert_grep "has no Sys.AccessNetwork" "$T/out" || return 1
  assert_match "$(role_line ProxMate-Guest)" "VM.Monitor" "PVE 8 guest agent on the pool"
}

t_pool_8_2_uses_access_network() {
  new_case 8.2.4
  run_script --pool proxmate
  assert_eq "$RC" 0 "exit code" || return 1
  assert_match "$(role_line ProxMate-Infra)" "Sys.AccessNetwork" "8.2 has it" || return 1
  assert_eq "$(role_line ProxMate-Cluster)" "role add ProxMate-Cluster --privs Sys.Audit" "no Sys.Modify needed"
}

t_pool_options_land_on_the_right_roles() {
  new_case 9.0.6
  run_script --pool proxmate --with-ide --with-passthrough
  assert_eq "$RC" 0 "exit code" || return 1
  assert_match "$(role_line ProxMate-Guest)" "VM.GuestAgent.FileWrite" "IDE file writes on the pool" || return 1
  assert_match "$(role_line ProxMate-Infra)" "Mapping.Audit,Mapping.Use" "mappings in the infra role" || return 1
  assert_no_match "$(role_line ProxMate-Guest)" "Mapping." "no mappings on the pool" || return 1
  assert_match "$(cat "$STUB_LOG")" "acl modify /mapping --tokens proxmate@pve!proxmate --roles ProxMate-Infra --propagate 1" "mapping ACL"
}

t_pool_existing_setup_is_updated_not_recreated() {
  new_case 9.0.6 poolroles user token pool
  run_script --pool proxmate
  assert_eq "$RC" 0 "exit code" || return 1
  local log; log="$(cat "$STUB_LOG")"
  assert_match "$log" "role modify ProxMate-Guest --privs" "updates the guest role" || return 1
  assert_match "$log" "role modify ProxMate-Cluster --privs" "updates the cluster role" || return 1
  assert_no_match "$log" "pool add" "keeps the pool" || return 1
  assert_no_match "$log" "token add" "never re-issues an existing token" || return 1
  assert_match "$log" "acl modify /pool/proxmate --tokens proxmate@pve!proxmate" "refreshes the token's pool ACL" || return 1
  assert_grep "already exists" "$T/out"
}

t_pool_name_must_match_exactly() {
  new_case 9.0.6 otherpool
  run_script --pool proxmate
  assert_eq "$RC" 0 "exit code" || return 1
  assert_match "$(cat "$STUB_LOG")" "pool add proxmate --comment" "a pool named proxmate-old is not proxmate"
}

t_pool_keeps_the_root_grant_until_asked() {
  new_case 9.0.6 role poolroles user token pool rootacl
  run_script --pool proxmate
  assert_eq "$RC" 0 "exit code" || return 1
  assert_no_match "$(cat "$STUB_LOG")" "acl delete" "the / grant stays" || return 1
  assert_grep "still granted on /, so the pool does not limit the token yet" "$T/out" || return 1
  assert_grep "--pool proxmate --drop-root-grant" "$T/out"
}

t_pool_drop_root_grant_after_the_new_acls() {
  new_case 9.0.6 role poolroles user token pool rootacl poolmembers
  run_script --pool proxmate --drop-root-grant
  assert_eq "$RC" 0 "exit code" || return 1
  local log; log="$(cat "$STUB_LOG")"
  assert_match "$log" "acl delete / --users proxmate@pve --roles ProxMate" "user's / grant removed" || return 1
  assert_match "$log" "acl delete / --tokens proxmate@pve!proxmate --roles ProxMate" "token's / grant removed" || return 1
  assert_no_match "$log" "role delete" "the old role itself is left alone" || return 1
  local granted dropped
  granted="$(line_no "acl modify / --tokens proxmate@pve!proxmate --roles ProxMate-Cluster")"
  dropped="$(line_no "acl delete / --users proxmate@pve")"
  [ "$granted" -gt 0 ] && [ "$dropped" -gt "$granted" ] \
    || fail_msg "the token's new ACLs (line $granted) come before the drop (line $dropped)" || return 1
  assert_no_grep "still granted on /" "$T/out" || return 1
  assert_no_grep "holds no guests yet" "$T/out"
}

t_pool_drop_root_grant_refuses_on_an_empty_pool() {
  new_case 9.0.6 role poolroles user token pool rootacl
  run_script --pool proxmate --drop-root-grant
  assert_eq "$RC" 0 "exit code" || return 1
  assert_no_match "$(cat "$STUB_LOG")" "acl delete /" "the / grant is kept" || return 1
  assert_grep "The pool proxmate holds no guests yet" "$T/out" || return 1
  assert_grep "re-run with --force" "$T/out"
}

t_pool_drop_root_grant_force_on_an_empty_pool() {
  new_case 9.0.6 role poolroles user token pool rootacl
  run_script --pool proxmate --drop-root-grant --force
  assert_eq "$RC" 0 "exit code" || return 1
  assert_match "$(cat "$STUB_LOG")" "acl delete / --tokens proxmate@pve!proxmate --roles ProxMate" "dropped anyway"
}

t_pool_drop_root_grant_is_a_noop_without_one() {
  new_case 9.0.6 poolroles user token pool
  run_script --pool proxmate --drop-root-grant
  assert_eq "$RC" 0 "exit code" || return 1
  assert_no_match "$(cat "$STUB_LOG")" "acl delete" "nothing to remove" || return 1
  assert_no_grep "holds no guests yet" "$T/out"
}

t_default_mode_warns_about_an_existing_pool_setup() {
  new_case 9.0.6 role user token guestacl
  run_script
  assert_eq "$RC" 0 "exit code" || return 1
  assert_grep "also holds ProxMate-Guest on a pool" "$T/out"
}

t_pool_dry_run_shows_the_plan_and_changes_nothing() {
  new_case 9.0.6 rootacl poolmembers
  run_script --dry-run --pool proxmate --drop-root-grant --snippet-storage local
  assert_eq "$RC" 0 "exit code" || return 1
  local log; log="$(cat "$STUB_LOG")"
  assert_no_match "$log" "role add" "no role created" || return 1
  assert_no_match "$log" "pool add" "no pool created" || return 1
  assert_no_match "$log" "acl modify" "no ACL changed" || return 1
  assert_no_match "$log" "acl delete" "no ACL removed" || return 1
  assert_no_match "$log" "token add" "no token issued" || return 1
  assert_grep "ACL plan (path -> role -> the privileges that apply there):" "$T/out" || return 1
  assert_grep "/pool/proxmate -> ProxMate-Guest -> VM.Allocate" "$T/out" || return 1
  assert_grep "/nodes -> ProxMate-Infra -> Sys.Audit Sys.AccessNetwork" "$T/out" || return 1
  assert_grep "/storage -> ProxMate-Infra -> Datastore.AllocateSpace Datastore.AllocateTemplate Datastore.Audit" "$T/out" || return 1
  assert_grep "/storage/local -> ProxMate-Storage -> Datastore.Allocate Datastore.AllocateSpace" "$T/out" || return 1
  assert_grep "/sdn/zones -> ProxMate-Infra -> SDN.Audit SDN.Use" "$T/out" || return 1
  assert_grep "/ (this path only) -> ProxMate-Cluster -> Sys.Audit" "$T/out" || return 1
  assert_grep "pveum pool add proxmate" "$T/out" || return 1
  assert_grep "pveum acl modify /pool/proxmate --tokens proxmate@pve!proxmate --roles ProxMate-Guest --propagate 1" "$T/out" || return 1
  assert_grep "pveum acl delete / --tokens proxmate@pve!proxmate --roles ProxMate" "$T/out"
}

t_pool_refuses_bad_input() {
  new_case 9.0.6
  run_script --pool 'bad name'
  assert_ne "$RC" 0 "pool name with a space refused" || return 1
  run_script --pool 'a/b'
  assert_ne "$RC" 0 "nested pool path refused" || return 1
  run_script --pool "$(printf 'p%.0s' $(seq 1 65))"
  assert_ne "$RC" 0 "over-long pool name refused" || return 1
  run_script --pool proxmate --snippet-storage 'a b'
  assert_ne "$RC" 0 "storage id with a space refused" || return 1
  run_script --pool proxmate --import-storage 'a..b'
  assert_ne "$RC" 0 "storage id with .. refused" || return 1
  run_script --pool proxmate --import-storage '-x'
  assert_ne "$RC" 0 "storage id starting with - refused" || return 1
  local opt
  for opt in --drop-root-grant --with-cluster-firewall --force "--snippet-storage x" "--import-storage x"; do
    # shellcheck disable=SC2086
    run_script $opt
    assert_ne "$RC" 0 "$opt without --pool refused" || return 1
  done
  assert_eq "$(cat "$STUB_LOG")" "" "nothing ran"
}

run_cases "$@"
