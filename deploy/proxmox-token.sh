#!/usr/bin/env bash
#
# Create a least-privilege Proxmox API token for ProxMate.
#
# Run as root on ONE node of the Proxmox VE cluster (users, roles and ACLs are
# cluster-wide). It creates, or brings up to date:
#
#   - a role "ProxMate" holding only the privileges ProxMate uses,
#   - a user proxmate@pve with no password (it can only be used through its token),
#   - an API token proxmate@pve!proxmate with privilege separation ON,
#   - ACLs on / for both the user and the token. A privilege-separated token's
#     effective permissions are the intersection of the user's and the token's,
#     so both need the role.
#
# With --pool <name> the guest privileges are granted on a Proxmox resource pool
# instead of on /, so Proxmox refuses the token guests outside it. It creates the
# pool if it is missing and splits the privileges by the path Proxmox checks each
# one on:
#
#   /pool/<name>        ProxMate-Guest    every VM.* privilege, Pool.Audit, Pool.Allocate
#   /nodes              ProxMate-Infra    Sys.Audit (node status, capacity, tasks), and
#                                         Sys.AccessNetwork on 8.2+ (cloud-image downloads)
#   /storage            ProxMate-Infra    Datastore.Audit, .AllocateSpace, .AllocateTemplate
#   /storage/<id>       ProxMate-Storage  the above plus Datastore.Allocate, only on the
#                                         storages named by --snippet-storage/--import-storage
#   /sdn/zones          ProxMate-Infra    SDN.Audit, SDN.Use (guest NICs, VNet listing)
#   /mapping            ProxMate-Infra    Mapping.* (only with --with-passthrough)
#   / (this path only)  ProxMate-Cluster  Sys.Audit (cluster status, firewall reads), and
#                                         Sys.Modify only with --with-cluster-firewall
#
# What the pool does NOT contain:
#   - Sys.Modify on / also allows cluster backup jobs, the cluster firewall's
#     groups, IP sets and options, and other cluster settings. ProxMate needs it
#     only to enable the cluster firewall and write its management rules, so it is
#     left out unless --with-cluster-firewall is given (do that step once as root
#     instead). Before Proxmox VE 8.2 cloud-image downloads need it too, so it is
#     granted there and the script says so.
#   - Datastore.Allocate deletes any volume and edits the storage definition, so it
#     is not granted at all unless asked for: --snippet-storage lets ProxMate turn on
#     the snippets content type (or do that once as root), --import-storage lets it
#     delete a downloaded cloud image after building a template (otherwise the file
#     stays under import/ for you to remove). The script warns when a named storage
#     also holds disk images, container volumes or backups.
#
# ProxMate-Infra is one role for the infra paths; on each path only its own
# privileges gate anything. Set the same pool in ProxMate (Admin -> Settings ->
# Proxmox connection) so every guest it creates lands in it. An earlier grant of
# the ProxMate role on / is kept until --drop-root-grant: while it exists,
# ProxMate can still move the guests it already manages into the pool.
#
# The token secret is printed once. Paste the token id and secret into the ProxMate
# setup wizard (or Admin → Settings → Proxmox connection) and run the connection
# test: it names any privilege that is still missing.
#
# This script is meant to be read before it is run. Nothing is changed with
# --dry-run, which prints the commands instead.
#
# Usage:
#   bash proxmox-token.sh [--dry-run] [--with-ide] [--with-passthrough]
#                         [--user proxmate@pve] [--token proxmate]
#                         [--pool <name> [--drop-root-grant] [--with-cluster-firewall]
#                          [--snippet-storage <id>] [--import-storage <id>] [--force]]
#
#   --with-ide               accepted for older instructions; the guest-agent file
#                            write it used to add is now always part of the role
#   --with-passthrough       also allow GPU/PCI passthrough through resource mappings
#   --pool <name>            grant the guest privileges on /pool/<name> only (see above)
#   --drop-root-grant        with --pool: remove the ProxMate role's earlier grant on /
#   --with-cluster-firewall  with --pool: also grant Sys.Modify on / so ProxMate can
#                            enable the cluster firewall (the pool then does not fully
#                            contain the token)
#   --snippet-storage <id>   with --pool: also grant Datastore.Allocate on this storage,
#                            so ProxMate can enable its snippets content type
#   --import-storage <id>    with --pool: also grant Datastore.Allocate on the storage
#                            cloud images are downloaded to, so ProxMate can delete them
#   --force                  with --drop-root-grant: drop it even though the pool holds
#                            no guests yet
#
set -euo pipefail

USER_ID="proxmate@pve"
TOKEN_NAME="proxmate"
ROLE="ProxMate"
DRY_RUN=0
WITH_PASSTHROUGH=0
POOL=""
DROP_ROOT_GRANT=0
WITH_CLUSTER_FIREWALL=0
SNIPPET_STORAGE=""
IMPORT_STORAGE=""
FORCE=0
POOL_ONLY_OPTION=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --with-ide) ;; # now always included; kept so older instructions still run
    --with-passthrough) WITH_PASSTHROUGH=1 ;;
    --user) USER_ID="${2:?--user needs a value}"; shift ;;
    --token) TOKEN_NAME="${2:?--token needs a value}"; shift ;;
    --pool) POOL="${2:?--pool needs a value}"; shift ;;
    --drop-root-grant) DROP_ROOT_GRANT=1; POOL_ONLY_OPTION="$1" ;;
    --with-cluster-firewall) WITH_CLUSTER_FIREWALL=1; POOL_ONLY_OPTION="$1" ;;
    --snippet-storage) SNIPPET_STORAGE="${2:?--snippet-storage needs a value}"; POOL_ONLY_OPTION="$1"; shift ;;
    --import-storage) IMPORT_STORAGE="${2:?--import-storage needs a value}"; POOL_ONLY_OPTION="$1"; shift ;;
    --force) FORCE=1; POOL_ONLY_OPTION="$1" ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

case "$USER_ID" in *@*) ;; *) echo "--user must be user@realm, e.g. proxmate@pve" >&2; exit 2 ;; esac
case "$TOKEN_NAME" in *[!A-Za-z0-9_-]*|'') echo "--token may only contain letters, digits, - and _" >&2; exit 2 ;; esac
if [ -n "$POOL" ]; then
  case "$POOL" in *[!A-Za-z0-9_-]*) echo "--pool may only contain letters, digits, - and _" >&2; exit 2 ;; esac
  [ "${#POOL}" -le 64 ] || { echo "--pool is at most 64 characters" >&2; exit 2; }
  for s in "$SNIPPET_STORAGE" "$IMPORT_STORAGE"; do
    [ -n "$s" ] || continue
    case "$s" in
      [!A-Za-z]*|*[!A-Za-z0-9._-]*|*..*) echo "a storage id starts with a letter and uses only letters, digits, ., - and _: $s" >&2; exit 2 ;;
    esac
  done
fi
if [ -n "$POOL_ONLY_OPTION" ] && [ -z "$POOL" ]; then
  echo "$POOL_ONLY_OPTION only applies with --pool <name>" >&2
  exit 2
fi

command -v pveum >/dev/null 2>&1 || { echo "pveum not found — run this on a Proxmox VE node." >&2; exit 1; }
if [ "$DRY_RUN" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (users, roles and ACLs need it), or use --dry-run to see the commands." >&2
  exit 1
fi

# "pve-manager/9.0.3/..." → 9 and 0
PVE_VERSION="$(pveversion 2>/dev/null | sed -n 's#^pve-manager/\([0-9][0-9]*\.[0-9][0-9]*\).*#\1#p' | head -n1)"
PVE_MAJOR="${PVE_VERSION%%.*}"
PVE_MINOR="${PVE_VERSION#*.}"
if [ -z "$PVE_VERSION" ]; then
  echo "Could not read the Proxmox VE version from pveversion." >&2
  exit 1
fi
if [ "$PVE_MAJOR" -lt 8 ]; then
  echo "Proxmox VE $PVE_MAJOR is not supported by this script (8 or later)." >&2
  exit 1
fi
# Sys.AccessNetwork on /nodes/<node> (8.2+) lets download-url run without Sys.Modify on /.
HAS_ACCESS_NETWORK=0
if [ "$PVE_MAJOR" -ge 9 ] || { [ "$PVE_MAJOR" -eq 8 ] && [ "$PVE_MINOR" -ge 2 ]; }; then
  HAS_ACCESS_NETWORK=1
fi

PRIVS="VM.Allocate VM.Audit VM.Backup VM.Clone VM.Console VM.Migrate VM.PowerMgmt"
PRIVS="$PRIVS VM.Snapshot VM.Snapshot.Rollback"
PRIVS="$PRIVS VM.Config.CDROM VM.Config.CPU VM.Config.Cloudinit VM.Config.Disk VM.Config.HWType"
PRIVS="$PRIVS VM.Config.Memory VM.Config.Network VM.Config.Options"
PRIVS="$PRIVS Datastore.Allocate Datastore.AllocateSpace Datastore.AllocateTemplate Datastore.Audit"
PRIVS="$PRIVS SDN.Audit SDN.Use Sys.Audit Sys.Modify"
# Guest agent: Proxmox VE 9 replaced VM.Monitor with the VM.GuestAgent.* privileges.
if [ "$PVE_MAJOR" -ge 9 ]; then
  # FileWrite: the IDE bootstrap and pushing a file into a VM use agent/file-write.
  # Unrestricted already covers it on 9.2; older 9.x may check FileWrite itself.
  PRIVS="$PRIVS VM.GuestAgent.Audit VM.GuestAgent.Unrestricted VM.GuestAgent.FileWrite"
else
  PRIVS="$PRIVS VM.Monitor"
fi
[ "$WITH_PASSTHROUGH" -eq 1 ] && PRIVS="$PRIVS Mapping.Audit Mapping.Use"

# Pool mode: the same privileges, split by the ACL path Proxmox checks them on.
# Guest privileges are checked on /vms/<vmid>, which a pool member inherits from
# /pool/<name>. Pool.Audit lets ProxMate see the pool. Pool.Allocate is checked
# when a container is created into the pool, and when ProxMate adds a guest it
# manages to it (Proxmox also wants VM.Allocate on that guest).
GUEST_PRIVS=""
INFRA_PRIVS=""
for p in $PRIVS; do
  case "$p" in
    VM.*) GUEST_PRIVS="$GUEST_PRIVS $p" ;;
    Sys.Modify) ;; # / only, and opt-in: on /nodes it would allow changing node configuration
    Datastore.Allocate) ;; # only on the storages that need it (ProxMate-Storage)
    *) INFRA_PRIVS="$INFRA_PRIVS $p" ;;
  esac
done
GUEST_PRIVS="${GUEST_PRIVS# } Pool.Audit Pool.Allocate"
INFRA_PRIVS="${INFRA_PRIVS# }"
[ "$HAS_ACCESS_NETWORK" -eq 1 ] && INFRA_PRIVS="$INFRA_PRIVS Sys.AccessNetwork"
STORAGE_PRIVS="Datastore.Allocate Datastore.AllocateSpace Datastore.AllocateTemplate Datastore.Audit"
CLUSTER_PRIVS="Sys.Audit"
CLUSTER_MODIFY_REASON=""
if [ "$WITH_CLUSTER_FIREWALL" -eq 1 ]; then
  CLUSTER_PRIVS="Sys.Audit Sys.Modify"
  CLUSTER_MODIFY_REASON="--with-cluster-firewall"
elif [ "$HAS_ACCESS_NETWORK" -eq 0 ]; then
  CLUSTER_PRIVS="Sys.Audit Sys.Modify"
  CLUSTER_MODIFY_REASON="Proxmox VE $PVE_VERSION has no Sys.AccessNetwork, so cloud-image downloads need it"
fi
GUEST_ROLE="$ROLE-Guest"
INFRA_ROLE="$ROLE-Infra"
STORAGE_ROLE="$ROLE-Storage"
CLUSTER_ROLE="$ROLE-Cluster"

# The ACL plan, one "<path> <role> <propagate>" per line.
if [ -n "$POOL" ]; then
  ACL_PLAN="/pool/$POOL $GUEST_ROLE 1
/nodes $INFRA_ROLE 1
/storage $INFRA_ROLE 1"
  # A more specific ACL replaces what /storage passes down, so this role carries
  # the whole Datastore set, not just Datastore.Allocate.
  STORAGES=""
  for s in "$SNIPPET_STORAGE" "$IMPORT_STORAGE"; do
    [ -n "$s" ] || continue
    case " $STORAGES " in *" $s "*) continue ;; esac
    STORAGES="$STORAGES $s"
    ACL_PLAN="$ACL_PLAN
/storage/$s $STORAGE_ROLE 1"
  done
  ACL_PLAN="$ACL_PLAN
/sdn/zones $INFRA_ROLE 1
/ $CLUSTER_ROLE 0"
  if [ "$WITH_PASSTHROUGH" -eq 1 ]; then
    ACL_PLAN="$ACL_PLAN
/mapping $INFRA_ROLE 1"
  fi
else
  ACL_PLAN="/ $ROLE 1"
fi

TOKEN_ID="${USER_ID}!${TOKEN_NAME}"

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  %s\n' "$*"
  else
    "$@"
  fi
}

exists() { # exists <kind> <id>: true when `pveum <kind> list` mentions the id
  pveum "$1" list --output-format json 2>/dev/null | grep -qF "\"$2\""
}

pool_exists() { # pool_exists <pool>: an entry whose poolid is exactly <pool>
  pveum pool list --output-format json 2>/dev/null | tr -d '[:space:]' | grep -qF "\"poolid\":\"$1\""
}

acl_entries() { # one ACL entry per line, whitespace removed
  pveum acl list --output-format json 2>/dev/null | tr -d '[:space:]' | tr '{}' '\n\n'
}

has_acl() { # has_acl <path> <role> <user-or-token id>: true when that exact ACL entry exists
  acl_entries | grep -F "\"path\":\"$1\"" | grep -F "\"roleid\":\"$2\"" | grep -qF "\"ugid\":\"$3\""
}

has_role_acl() { # has_role_acl <role> <user-or-token id>: that role is granted anywhere
  acl_entries | grep -F "\"roleid\":\"$1\"" | grep -qF "\"ugid\":\"$2\""
}

pool_has_guests() { # pool_has_guests <pool>: the pool lists at least one guest
  local out
  out="$(pvesh get /pools --poolid "$1" --output-format json 2>/dev/null \
    || pvesh get "/pools/$1" --output-format json 2>/dev/null || true)"
  printf '%s' "$out" | tr -d '[:space:]' | grep -q '"vmid":'
}

storage_content() { # storage_content <id>: its content types, comma-separated (empty if unknown)
  pvesh get "/storage/$1" --output-format json 2>/dev/null | tr -d '[:space:]' \
    | sed -n 's/.*"content":"\([^"]*\)".*/\1/p'
}

stale_acls() { # stale_acls <user-or-token id>: "<path> <role>" of ProxMate-* grants not in the plan
  local entry path role
  acl_entries | grep -F "\"ugid\":\"$1\"" | grep -F "\"roleid\":\"$ROLE-" | while read -r entry; do
    path="$(printf '%s' "$entry" | sed -n 's/.*"path":"\([^"]*\)".*/\1/p')"
    role="$(printf '%s' "$entry" | sed -n 's/.*"roleid":"\([^"]*\)".*/\1/p')"
    [ -n "$path" ] && [ -n "$role" ] || continue
    printf '%s\n' "$ACL_PLAN" | grep -qxF -e "$path $role 1" -e "$path $role 0" || printf '%s %s\n' "$path" "$role"
  done
}

remove_stale_acls() { # remove_stale_acls --users|--tokens <id>
  local path role
  while read -r path role; do
    [ -n "$path" ] || continue
    run pveum acl delete "$path" "$1" "$2" --roles "$role"
  done <<< "$(stale_acls "$2")"
}

ensure_role() { # ensure_role <role> <space-separated privileges>
  local csv
  csv="$(printf '%s' "$2" | tr ' ' ',')"
  if exists role "$1"; then
    # Without --append this replaces the list, so the role always matches this script.
    run pveum role modify "$1" --privs "$csv"
  else
    run pveum role add "$1" --privs "$csv"
  fi
}

grant_all() { # grant_all --users|--tokens <id>: every ACL in the plan
  local path role propagate
  while read -r path role propagate; do
    run pveum acl modify "$path" "$1" "$2" --roles "$role" --propagate "$propagate"
  done <<< "$ACL_PLAN"
}

if [ -n "$POOL" ]; then
  echo "Proxmox VE $PVE_VERSION — setting up $TOKEN_ID scoped to the resource pool $POOL"
  echo "ACL plan (path -> role -> the privileges that apply there):"
  while read -r path role propagate; do
    case "$role" in
      "$GUEST_ROLE") privs="$GUEST_PRIVS" ;;
      "$CLUSTER_ROLE") privs="$CLUSTER_PRIVS" ;;
      "$STORAGE_ROLE") privs="$STORAGE_PRIVS" ;;
      *)
        case "$path" in
          /nodes) want="Sys." ;;
          /storage) want="Datastore." ;;
          /sdn/*) want="SDN." ;;
          *) want="Mapping." ;;
        esac
        privs=""
        for p in $INFRA_PRIVS; do
          case "$p" in "$want"*) privs="$privs $p" ;; esac
        done
        privs="${privs# }"
        ;;
    esac
    [ "$propagate" = 0 ] && path="$path (this path only)"
    printf '  %s -> %s -> %s\n' "$path" "$role" "$privs"
  done <<< "$ACL_PLAN"
  if [ -n "$CLUSTER_MODIFY_REASON" ]; then
    echo "Sys.Modify on / is granted ($CLUSTER_MODIFY_REASON). While the token holds it the pool does"
    echo "not fully contain it: Proxmox also lets it manage cluster backup jobs, the cluster"
    echo "firewall's groups, IP sets and options, and other cluster settings."
  else
    echo "Sys.Modify on / is not granted: enable the cluster firewall once by hand as root"
    echo "(Datacenter → Firewall), or re-run with --with-cluster-firewall to let ProxMate do it."
  fi
  for s in $STORAGES; do
    content="$(storage_content "$s")"
    case ",$content," in
      *,images,*|*,rootdir,*|*,backup,*)
        echo "Warning: storage $s also holds $content. Datastore.Allocate there lets the token delete"
        echo "those volumes too, guests outside the pool included." ;;
    esac
  done
else
  echo "Proxmox VE $PVE_MAJOR — setting up $TOKEN_ID with role $ROLE"
fi
[ "$DRY_RUN" -eq 1 ] && echo "Dry run: these commands would run:"

if [ -n "$POOL" ]; then
  ensure_role "$GUEST_ROLE" "$GUEST_PRIVS"
  ensure_role "$INFRA_ROLE" "$INFRA_PRIVS"
  [ -n "$STORAGES" ] && ensure_role "$STORAGE_ROLE" "$STORAGE_PRIVS"
  ensure_role "$CLUSTER_ROLE" "$CLUSTER_PRIVS"
  if ! pool_exists "$POOL"; then
    run pveum pool add "$POOL" --comment "ProxMate guests"
  fi
else
  ensure_role "$ROLE" "$PRIVS"
  if has_role_acl "$ROLE-Guest" "$TOKEN_ID"; then
    echo "Note: $TOKEN_ID also holds $ROLE-Guest on a pool. Granting $ROLE on / again means the"
    echo "pool no longer limits it; run with --pool <name> to keep the pool-scoped setup."
  fi
fi

if ! exists user "$USER_ID"; then
  run pveum user add "$USER_ID" --comment "ProxMate service account (API token only)"
fi

grant_all --users "$USER_ID"
# Pool mode: ProxMate-* grants left by an earlier run (another pool, another storage).
[ -n "$POOL" ] && remove_stale_acls --users "$USER_ID"

# Pool mode: an earlier grant of the full role on / still reaches every guest. It
# is removed (with --drop-root-grant) only after the token's new ACLs are in place.
ROOT_GRANT_KEPT=0
drop_root_grant() {
  [ -n "$POOL" ] || return 0
  local kind id ids=""
  for kind in users tokens; do
    id="$USER_ID"
    [ "$kind" = tokens ] && id="$TOKEN_ID"
    has_acl / "$ROLE" "$id" && ids="$ids $kind:$id"
  done
  [ -n "$ids" ] || return 0
  if [ "$DROP_ROOT_GRANT" -eq 0 ]; then
    ROOT_GRANT_KEPT=1
    return 0
  fi
  if ! pool_has_guests "$POOL" && [ "$FORCE" -eq 0 ]; then
    echo "The pool $POOL holds no guests yet, so dropping the grant on / would put every guest"
    echo "ProxMate manages out of the token's reach. Move them in first (\"Move managed guests into"
    echo "the pool\" in ProxMate), or re-run with --force. The grant on / was kept."
    ROOT_GRANT_KEPT=1
    return 0
  fi
  for id in $ids; do
    run pveum acl delete / "--${id%%:*}" "${id#*:}" --roles "$ROLE"
  done
}

pool_notes() {
  [ -n "$POOL" ] || return 0
  echo
  echo "Set \"Proxmox pool\" to $POOL in ProxMate (Admin → Settings → Proxmox connection)."
  if [ "$ROOT_GRANT_KEPT" -eq 1 ]; then
    echo "The role $ROLE is still granted on /, so the pool does not limit the token yet."
    echo "Run the connection test, use \"Move managed guests into the pool\", then:"
    echo "  bash $0 --pool $POOL --drop-root-grant"
  fi
}

TOKEN_EXISTS=0
if pveum user token list "$USER_ID" --output-format json 2>/dev/null | grep -qF "\"$TOKEN_NAME\""; then
  TOKEN_EXISTS=1
fi

if [ "$TOKEN_EXISTS" -eq 1 ]; then
  grant_all --tokens "$TOKEN_ID"
  [ -n "$POOL" ] && remove_stale_acls --tokens "$TOKEN_ID"
  drop_root_grant
  echo
  echo "The token $TOKEN_ID already exists; its role and ACLs are now up to date."
  echo "Its secret can't be shown again. To issue a new one:"
  echo "  pveum user token remove $USER_ID $TOKEN_NAME && bash $0"
  pool_notes
  exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
  run pveum user token add "$USER_ID" "$TOKEN_NAME" --privsep 1 --comment "ProxMate"
  grant_all --tokens "$TOKEN_ID"
  [ -n "$POOL" ] && remove_stale_acls --tokens "$TOKEN_ID"
  drop_root_grant
  pool_notes
  exit 0
fi

OUT="$(pveum user token add "$USER_ID" "$TOKEN_NAME" --privsep 1 --comment "ProxMate" --output-format json)"
SECRET="$(printf '%s' "$OUT" | sed -n 's/.*"value"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
grant_all --tokens "$TOKEN_ID"
[ -n "$POOL" ] && remove_stale_acls --tokens "$TOKEN_ID"
drop_root_grant

echo
echo "Done. Enter these in ProxMate (setup wizard, or Admin → Settings → Proxmox connection):"
echo "  Token ID:     $TOKEN_ID"
if [ -n "$SECRET" ]; then
  echo "  Token secret: $SECRET"
else
  echo "  Token secret: (could not parse it — here is what Proxmox returned)"
  printf '%s\n' "$OUT"
fi
echo
echo "The secret is shown only this once. Then run the connection test in ProxMate."
pool_notes
