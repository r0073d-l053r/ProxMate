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
#
#   --with-ide          also allow the ProxMate IDE's guest-agent file writes
#                       (Proxmox VE 9; on 8 the guest-agent privilege already covers it)
#   --with-passthrough  also allow GPU/PCI passthrough through resource mappings
#
set -euo pipefail

USER_ID="proxmate@pve"
TOKEN_NAME="proxmate"
ROLE="ProxMate"
DRY_RUN=0
WITH_IDE=0
WITH_PASSTHROUGH=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --with-ide) WITH_IDE=1 ;;
    --with-passthrough) WITH_PASSTHROUGH=1 ;;
    --user) USER_ID="${2:?--user needs a value}"; shift ;;
    --token) TOKEN_NAME="${2:?--token needs a value}"; shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

case "$USER_ID" in *@*) ;; *) echo "--user must be user@realm, e.g. proxmate@pve" >&2; exit 2 ;; esac
case "$TOKEN_NAME" in *[!A-Za-z0-9_-]*|'') echo "--token may only contain letters, digits, - and _" >&2; exit 2 ;; esac

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
  PRIVS="$PRIVS VM.GuestAgent.Audit VM.GuestAgent.Unrestricted"
  [ "$WITH_IDE" -eq 1 ] && PRIVS="$PRIVS VM.GuestAgent.FileWrite"
else
  PRIVS="$PRIVS VM.Monitor"
fi
[ "$WITH_PASSTHROUGH" -eq 1 ] && PRIVS="$PRIVS Mapping.Audit Mapping.Use"
PRIVS_CSV="$(printf '%s' "$PRIVS" | tr ' ' ',')"

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

echo "Proxmox VE $PVE_MAJOR — setting up $TOKEN_ID with role $ROLE"
[ "$DRY_RUN" -eq 1 ] && echo "Dry run: these commands would run:"

if exists role "$ROLE"; then
  # Without --append this replaces the list, so the role always matches this script.
  run pveum role modify "$ROLE" --privs "$PRIVS_CSV"
else
  run pveum role add "$ROLE" --privs "$PRIVS_CSV"
fi

if ! exists user "$USER_ID"; then
  run pveum user add "$USER_ID" --comment "ProxMate service account (API token only)"
fi

run pveum acl modify / --users "$USER_ID" --roles "$ROLE" --propagate 1

TOKEN_EXISTS=0
if pveum user token list "$USER_ID" --output-format json 2>/dev/null | grep -qF "\"$TOKEN_NAME\""; then
  TOKEN_EXISTS=1
fi

if [ "$TOKEN_EXISTS" -eq 1 ]; then
  run pveum acl modify / --tokens "$TOKEN_ID" --roles "$ROLE" --propagate 1
  echo
  echo "The token $TOKEN_ID already exists; its role and ACLs are now up to date."
  echo "Its secret can't be shown again. To issue a new one:"
  echo "  pveum user token remove $USER_ID $TOKEN_NAME && bash $0"
  exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
  run pveum user token add "$USER_ID" "$TOKEN_NAME" --privsep 1 --comment "ProxMate"
  run pveum acl modify / --tokens "$TOKEN_ID" --roles "$ROLE" --propagate 1
  exit 0
fi

OUT="$(pveum user token add "$USER_ID" "$TOKEN_NAME" --privsep 1 --comment "ProxMate" --output-format json)"
SECRET="$(printf '%s' "$OUT" | sed -n 's/.*"value"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
pveum acl modify / --tokens "$TOKEN_ID" --roles "$ROLE" --propagate 1

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
