#!/bin/bash
# Off camera: a fresh KeePassXC database for alex with the two entries part three uses as authenticators,
# "ProxMate" (Alex's own account) and "Sam" (stands in for Sam's phone). No TOTP is set: that
# happens on camera. Close KeePassXC first. The master password comes from PMV_KDBX_PASSWORD (lab only).
# usage: PMV_KDBX_PASSWORD=... bash kdbx-reset.sh [db path, default /home/alex/Documents/Passwords.kdbx]
set -euo pipefail
DB=${1:-/home/alex/Documents/Passwords.kdbx}
: "${PMV_KDBX_PASSWORD:?set PMV_KDBX_PASSWORD}"
APP=${PROXMATE_URL:-http://192.168.1.50:3000}
pkill -u alex -x keepassxc 2>/dev/null && sleep 1 || true
rm -f "$DB"
run() { runuser -u alex -- keepassxc-cli "$@"; }
printf '%s\n%s\n' "$PMV_KDBX_PASSWORD" "$PMV_KDBX_PASSWORD" | run db-create -q -p "$DB" >/dev/null
printf '%s\n' "$PMV_KDBX_PASSWORD" | run add -q -u alex@example.com --url "$APP" "$DB" ProxMate
printf '%s\n' "$PMV_KDBX_PASSWORD" | run add -q -u sam@example.com --url "$APP" "$DB" Sam
chmod 600 "$DB"
printf '%s\n' "$PMV_KDBX_PASSWORD" | run ls -q "$DB"
