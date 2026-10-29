#!/bin/bash
# Lab network: vmbr0 bridge = the "home LAN" (192.168.1.0/24).
#  .1  gateway/NAT for VMs     .10 pve1 (Proxmox VE API)     .50 proxmate (the ProxMate box)
#  VMs get DHCP .100-.199 from dnsmasq and reach the internet through NAT on eth0.
# usage: net.sh   (as root; idempotent; bring-up.sh runs it; dnsmasq logs to $PMV_WORK/logs/dnsmasq.log)
set -e
WORK=${PMV_WORK:-$HOME/pmv/work}; LOGS=$WORK/logs; mkdir -p "$LOGS"
ip link show vmbr0 >/dev/null 2>&1 || ip link add vmbr0 type bridge
ip link set vmbr0 up
for a in 192.168.1.1/24 192.168.1.10/24 192.168.1.50/24; do ip addr show dev vmbr0 | grep -q " ${a%/*}/" || ip addr add $a dev vmbr0; done
sysctl -qw net.ipv4.ip_forward=1
iptables -t nat -C POSTROUTING -s 192.168.1.0/24 ! -d 192.168.1.0/24 -o eth0 -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s 192.168.1.0/24 ! -d 192.168.1.0/24 -o eth0 -j MASQUERADE
iptables -C FORWARD -i vmbr0 -j ACCEPT 2>/dev/null || iptables -I FORWARD -i vmbr0 -j ACCEPT
iptables -C FORWARD -o vmbr0 -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || iptables -I FORWARD -o vmbr0 -m state --state RELATED,ESTABLISHED -j ACCEPT
# install.sh reports the address of the route to 1.1.1.1 as "this machine's address": make that the box's LAN IP.
GW=$(ip -4 route show default | awk '{print $3; exit}')
ip route replace 1.1.1.1/32 via $GW dev eth0 src 192.168.1.50
# Names, like a home router's DNS would provide.
grep -q " pve1$" /etc/hosts || echo "192.168.1.10 pve1" >> /etc/hosts
grep -q " proxmate$" /etc/hosts || echo "192.168.1.50 proxmate" >> /etc/hosts
# proxmate.host: see docs-mode.sh (official = the live site through the egress proxy; local = stand-in build)
# DHCP for VMs on vmbr0
if ! pgrep -x dnsmasq >/dev/null; then
  dnsmasq --interface=vmbr0 --bind-interfaces --except-interface=lo --listen-address=192.168.1.1 \
    --dhcp-range=192.168.1.100,192.168.1.199,12h --dhcp-option=option:router,192.168.1.1 \
    --dhcp-option=option:dns-server,8.8.8.8 --port=0 --dhcp-leasefile=/var/lib/misc/vmbr0.leases --log-dhcp \
    --log-facility=$LOGS/dnsmasq.log
fi
ip -4 -br addr show vmbr0; ip -4 route get 1.1.1.1 | head -1
