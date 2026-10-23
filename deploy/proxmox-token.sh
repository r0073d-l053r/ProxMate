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
# instead of on /, so Proxmox itself refuses the token every guest outside it. It
# creates the pool if it is missing and splits the role by the path Proxmox checks
# each privilege on:
#
#   /pool/<name>        ProxMate-Guest    every VM.* privilege, Pool.Audit, Pool.Allocate
#   /nodes              ProxMate-Infra    Sys.Audit (node status, capacity, tasks)
#   /storage            ProxMate-Infra    Datastore.* (disks, ISOs, snippets, backups)
#   /sdn/zones          ProxMate-Infra    SDN.Audit, SDN.Use (guest NICs, VNet listing)
#   /mapping            ProxMate-Infra    Mapping.* (only with --with-passthrough)
#   / (this path only)  ProxMate-Cluster  Sys.Audit, Sys.Modify (cluster firewall,
#                                         cluster status, cloud-image downloads)
#
# ProxMate-Infra is one role for all the infra paths; on each path only its own
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
#                         [--pool <name> [--drop-root-grant]]
#
#   --with-ide          accepted for older instructions; the guest-agent file
#                       write it used to add is now always part of the role
#   --with-passthrough  also allow GPU/PCI passthrough through resource mappings
#   --pool <name>       grant the guest privileges on /pool/<name> only (see above)
#   --drop-root-grant   with --pool: remove the ProxMate role's earlier grant on /
#
set -euo pipefail

USER_ID="proxmate@pve"
TOKEN_NAME="proxmate"
ROLE="ProxMate"
DRY_RUN=0
WITH_PASSTHROUGH=0
POOL=""
DROP_ROOT_GRANT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --with-ide) ;; # now always included; kept so older instructions still run
    --with-passthrough) WITH_PASSTHROUGH=1 ;;
    --user) USER_ID="${2:?--user needs a value}"; shift ;;
    --token) TOKEN_NAME="${2:?--token needs a value}"; shift ;;
    --pool) POOL="${2:?--pool needs a value}"; shift ;;
    --drop-root-grant) DROP_ROOT_GRANT=1 ;;
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
fi
if [ "$DROP_ROOT_GRANT" -eq 1 ] && [ -z "$POOL" ]; then
  echo "--drop-root-grant only applies with --pool <name>" >&2
  exit 2
fi

command -v pveum >/dev/null 2>&1 || { echo "pveum not found — run this on a Proxmox VE node." >&2; exit 1; }
if [ "$DRY_RUN" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (users, roles and ACLs need it), or use --dry-run to see the commands." >&2
  exit 1
fi

# "pve-manager/9.0.3/..." → 9
PVE_MAJOR="$(pveversion 2>/dev/null | sed -n 's#^pve-manager/\([0-9][0-9]*\)\..*#\1#p' | head -n1)"
if [ -z "$PVE_MAJOR" ]; then
  echo "Could not read the Proxmox VE version from pveversion." >&2
  exit 1
fi
if [ "$PVE_MAJOR" -lt 8 ]; then
  echo "Proxmox VE $PVE_MAJOR is not supported by this script (8 or later)." >&2
  exit 1
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
# /pool/<name>. Pool.Audit lets ProxMate see the pool; Pool.Allocate lets it add
# the guests it manages (Proxmox also wants VM.Allocate on each of them).
GUEST_PRIVS=""
INFRA_PRIVS=""
for p in $PRIVS; do
  case "$p" in
    VM.*) GUEST_PRIVS="$GUEST_PRIVS $p" ;;
    Sys.Modify) ;; # / only: on /nodes it would allow changing node configuration
    *) INFRA_PRIVS="$INFRA_PRIVS $p" ;;
  esac
done
GUEST_PRIVS="${GUEST_PRIVS# } Pool.Audit Pool.Allocate"
INFRA_PRIVS="${INFRA_PRIVS# }"
CLUSTER_PRIVS="Sys.Audit Sys.Modify"
GUEST_ROLE="$ROLE-Guest"
INFRA_ROLE="$ROLE-Infra"
CLUSTER_ROLE="$ROLE-Cluster"

# The ACL plan, one "<path> <role> <propagate>" per line.
if [ -n "$POOL" ]; then
  ACL_PLAN="/pool/$POOL $GUEST_ROLE 1
/nodes $INFRA_ROLE 1
/storage $INFRA_ROLE 1
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

has_acl() { # has_acl <path> <role> <user-or-token id>: true when that exact ACL entry exists
  pveum acl list --output-format json 2>/dev/null | tr -d '[:space:]' | tr '{}' '\n\n' \
    | grep -F "\"path\":\"$1\"" | grep -F "\"roleid\":\"$2\"" | grep -qF "\"ugid\":\"$3\""
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
  echo "Proxmox VE $PVE_MAJOR — setting up $TOKEN_ID scoped to the resource pool $POOL"
  echo "ACL plan (path -> role -> the privileges that apply there):"
  while read -r path role propagate; do
    case "$role" in
      "$GUEST_ROLE") privs="$GUEST_PRIVS" ;;
      "$CLUSTER_ROLE") privs="$CLUSTER_PRIVS" ;;
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
else
  echo "Proxmox VE $PVE_MAJOR — setting up $TOKEN_ID with role $ROLE"
fi
[ "$DRY_RUN" -eq 1 ] && echo "Dry run: these commands would run:"

if [ -n "$POOL" ]; then
  ensure_role "$GUEST_ROLE" "$GUEST_PRIVS"
  ensure_role "$INFRA_ROLE" "$INFRA_PRIVS"
  ensure_role "$CLUSTER_ROLE" "$CLUSTER_PRIVS"
  if ! exists pool "$POOL"; then
    run pveum pool add "$POOL" --comment "ProxMate guests"
  fi
else
  ensure_role "$ROLE" "$PRIVS"
fi

if ! exists user "$USER_ID"; then
  run pveum user add "$USER_ID" --comment "ProxMate service account (API token only)"
fi

grant_all --users "$USER_ID"

# Pool mode: an earlier grant of the full role on / still reaches every guest.
ROOT_GRANT_KEPT=0
if [ -n "$POOL" ]; then
  for kind in users tokens; do
    id="$USER_ID"
    [ "$kind" = tokens ] && id="$TOKEN_ID"
    has_acl / "$ROLE" "$id" || continue
    if [ "$DROP_ROOT_GRANT" -eq 1 ]; then
      run pveum acl delete / "--$kind" "$id" --roles "$ROLE"
    else
      ROOT_GRANT_KEPT=1
    fi
  done
fi

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
  pool_notes
  exit 0
fi

OUT="$(pveum user token add "$USER_ID" "$TOKEN_NAME" --privsep 1 --comment "ProxMate" --output-format json)"
SECRET="$(printf '%s' "$OUT" | sed -n 's/.*"value"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
grant_all --tokens "$TOKEN_ID"

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
