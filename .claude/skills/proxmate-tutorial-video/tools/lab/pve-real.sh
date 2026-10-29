#!/bin/bash
# Who answers at https://192.168.1.10:8006 ($PMV_PVE_URL, the node address the video uses):
#   pve-real.sh on   the real Proxmox VE on pve1 (over the lab tailnet, an ssh port forward), for the token chapter S03
#   pve-real.sh off  the lab stand-in (pve-lab.py), for every other chapter
# usage: pve-real.sh on|off   (as root; env PMV_PVE_URL, PMV_TS_DIR, PMV_PVE1_SSH_CONFIG, PMV_PVE_LAB_BIN default
#        /usr/local/sbin/pve-lab; logs in $PMV_WORK/logs)
HERE=$(dirname "$(readlink -f "$0")")
WORK=${PMV_WORK:-$HOME/pmv/work}; LOGS=$WORK/logs; mkdir -p "$LOGS"; LAB=${PMV_LAB:-$WORK/lab}
T=${PMV_TS_DIR:-$LAB/ts-lab}; CFG=${PMV_PVE1_SSH_CONFIG:-$T/ssh_config}
BIN=${PMV_PVE_LAB_BIN:-/usr/local/sbin/pve-lab}
PVE=${PMV_PVE_URL:-https://192.168.1.10:8006}; PVE=${PVE%/}; HP=${PVE#https://}   # host:port the forward binds
fwd_pids() { for p in $(pgrep -x ssh); do tr '\0' ' ' < /proc/$p/cmdline | grep -q "$HP:127.0.0.1:8006" && echo $p; done; }
shim_pids() { for p in $(pgrep -x python3); do grep -q "$BIN" /proc/$p/cmdline 2>/dev/null && echo $p; done; }
up() { for i in $(seq 1 30); do curl -sk --noproxy '*' -o /dev/null --max-time 5 $PVE/ && return 0; sleep 1; done; return 1; }
case "$1" in
  on)
    for p in $(shim_pids); do kill $p; done; sleep 1
    PMV_TS_DIR=$T bash $HERE/ts-lab/start.sh >/dev/null 2>&1
    [ -n "$(fwd_pids)" ] || (nohup ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -F $CFG -L $HP:127.0.0.1:8006 pve1-lab >> $LOGS/pve1-fwd.log 2>&1 &)
    up && curl -sk --noproxy '*' $PVE/ | grep -q "Proxmox Virtual Environment" && echo "real Proxmox at $HP" || { echo "real Proxmox NOT reachable"; exit 1; } ;;
  off)
    for p in $(fwd_pids); do kill $p; done; sleep 1
    [ -n "$(shim_pids)" ] || (nohup python3 -I $BIN > $LOGS/pve-lab.stdout 2>&1 &)
    sleep 2; up && [ -n "$(shim_pids)" ] && [ "$(curl -sk --noproxy '*' -o /dev/null -w '%{http_code}' $PVE/api2/json/version)" = 401 ] \
      && echo "lab stand-in at $HP" || { echo "stand-in NOT up"; exit 1; } ;;
  *) echo "usage: pve-real.sh on|off"; exit 2 ;;
esac
