#!/bin/bash
# Restart the Proxmox stand-in (pve-lab.py) without touching its state, e.g. after editing it, then check the API answers.
# usage: restart-shim.sh   (as root; env PMV_PVE_LAB_BIN default /usr/local/sbin/pve-lab, PMV_PVE_URL; log in $PMV_WORK/logs)
WORK=${PMV_WORK:-$HOME/pmv/work}; LOGS=$WORK/logs; mkdir -p "$LOGS"
BIN=${PMV_PVE_LAB_BIN:-/usr/local/sbin/pve-lab}; PVE=${PMV_PVE_URL:-https://192.168.1.10:8006}; PVE=${PVE%/}
for p in $(pgrep -x python3); do grep -q "$BIN" /proc/$p/cmdline 2>/dev/null && kill $p; done
sleep 1
(nohup python3 -I $BIN > $LOGS/pve-lab.stdout 2>&1 &)
sleep 2; curl -sk --noproxy '*' $PVE/api2/json/version >/dev/null && echo "pve1 api up"
