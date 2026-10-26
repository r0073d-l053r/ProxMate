#!/usr/bin/env bash
#
# Keep ProxMate's per-VM firewall enforced on a Proxmox node that is also a
# Tailscale subnet router.
#
# Run as root on EACH node that runs Tailscale with advertised routes (the
# "subnet router"). Nodes that don't route tailnet traffic to the LAN don't need
# it, but it does nothing harmful there.
#
# The problem. Tailscale marks every packet it forwards from the tailnet with
# fwmark 0x40000. When the destination is a guest on the same node, the packet
# is routed onto the LAN bridge and then crosses the guest's firewall bridge
# (fwbrNNNi0), and with br_netfilter it goes through iptables a second time,
# still carrying the mark. On that second pass:
#
#   - Tailscale's `ts-forward` chain, which runs before PVEFW-FORWARD, ACCEPTs
#     anything with the mark, so the guest's firewall is never evaluated: a
#     tailnet device can reach every port of every guest on this node, whatever
#     ProxMate's isolation rules say.
#   - Tailscale's `ts-postrouting` MASQUERADEs it again, to this node's tailnet
#     address, so the guest replies to 100.x and the reply is lost. The ProxMate
#     IDE (and anything else reached over the subnet route) times out.
#
# Guests on other nodes are not affected: their traffic arrives over the wire,
# without the mark.
#
# The fix is one mangle rule that clears Tailscale's mark on bridged frames,
# before either chain sees them. Routed traffic keeps the mark, so the subnet
# route itself works as before. This script installs it as
#
#   /usr/local/sbin/proxmate-ts-bridge-guard        adds the rule if it is missing
#   proxmate-ts-bridge-guard.service                runs it at boot and with tailscaled
#   proxmate-ts-bridge-guard.timer                  re-checks it every 2 minutes
#
# Usage:
#   ./proxmox-tailscale-guard.sh             install (idempotent) and apply now
#   ./proxmox-tailscale-guard.sh --check     report whether this node needs and has it
#   ./proxmox-tailscale-guard.sh --uninstall remove the units and the rule
#
# Expect one change in behaviour: tailnet devices reach guests on this node only
# through ports the guest's firewall allows, as guests on other nodes already do.

set -euo pipefail

GUARD=/usr/local/sbin/proxmate-ts-bridge-guard
UNIT=/etc/systemd/system/proxmate-ts-bridge-guard.service
TIMER=/etc/systemd/system/proxmate-ts-bridge-guard.timer
RULE=(-m physdev --physdev-is-in -m mark --mark 0x40000/0xff0000
      -m comment --comment proxmate-ts-bridge-guard -j MARK --set-xmark 0x0/0xff0000)

die() { echo "error: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root on the Proxmox node"
command -v iptables >/dev/null || die "iptables not found"

rule_present() { iptables -t mangle -C PREROUTING "${RULE[@]}" 2>/dev/null; }

advertised_routes() {
  command -v tailscale >/dev/null || return 0
  tailscale debug prefs 2>/dev/null | tr -d ' \n' | grep -o '"AdvertiseRoutes":\[[^]]*\]' | grep -o '"[0-9a-f:.]*/[0-9]*"' | tr -d '"' | tr '\n' ' ' || true
}

check() {
  local routes; routes=$(advertised_routes)
  if systemctl is-active --quiet tailscaled 2>/dev/null; then
    echo "tailscaled:        running"
  else
    echo "tailscaled:        not running"
  fi
  echo "advertised routes: ${routes:-none}"
  if rule_present; then echo "guard rule:        present"; else echo "guard rule:        MISSING"; fi
  if [ -x "$GUARD" ] && systemctl is-enabled --quiet proxmate-ts-bridge-guard.timer 2>/dev/null; then
    echo "guard units:       installed"
  else
    echo "guard units:       not installed"
  fi
  if [ -n "$routes" ] && ! rule_present; then
    echo
    echo "This node routes tailnet traffic to its LAN without the guard: guests on it are"
    echo "reachable from the tailnet on every port. Run this script without arguments to fix it."
    return 1
  fi
}

uninstall() {
  systemctl disable --now proxmate-ts-bridge-guard.timer proxmate-ts-bridge-guard.service 2>/dev/null || true
  rm -f "$GUARD" "$UNIT" "$TIMER"
  systemctl daemon-reload
  while rule_present; do iptables -t mangle -D PREROUTING "${RULE[@]}"; done
  echo "Removed the guard. Guests on this node are again reachable from the tailnet past their firewall."
}

install() {
  cat > "$GUARD" <<'EOF'
#!/bin/sh
# ProxMate: clear Tailscale's 0x40000 fwmark on bridged frames, so the PVE guest
# firewall is evaluated for tailnet traffic and it is not masqueraded twice.
# Installed by deploy/proxmox-tailscale-guard.sh. Idempotent.
set -e
RULE="-m physdev --physdev-is-in -m mark --mark 0x40000/0xff0000 -m comment --comment proxmate-ts-bridge-guard -j MARK --set-xmark 0x0/0xff0000"
iptables -t mangle -C PREROUTING $RULE 2>/dev/null || iptables -t mangle -A PREROUTING $RULE
EOF
  chmod 755 "$GUARD"

  cat > "$UNIT" <<EOF
[Unit]
Description=ProxMate: keep PVE guest firewalls enforced for Tailscale-routed traffic
After=network-online.target tailscaled.service pve-firewall.service
PartOf=tailscaled.service

[Service]
Type=oneshot
ExecStart=$GUARD

[Install]
WantedBy=multi-user.target tailscaled.service
EOF

  cat > "$TIMER" <<'EOF'
[Unit]
Description=ProxMate: re-check the Tailscale bridge guard rule

[Timer]
OnBootSec=30s
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload
  systemctl enable --now proxmate-ts-bridge-guard.service proxmate-ts-bridge-guard.timer
  rule_present || die "the guard rule is not in place after install"
  echo "Installed. Guests on this node now get their own firewall for tailnet traffic."
  echo
  check || true
}

case "${1:-}" in
  "") install ;;
  --check) check ;;
  --uninstall) uninstall ;;
  -h|--help) sed -n '2,41p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "unknown option: $1 (use --check, --uninstall or --help)" ;;
esac
