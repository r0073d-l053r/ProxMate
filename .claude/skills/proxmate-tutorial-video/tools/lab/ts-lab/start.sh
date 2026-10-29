#!/bin/bash
# Start the lab's Tailscale device (claude-lab on the original rig), userspace mode, through the egress proxy:
# the path to the real Proxmox node pve1 (ssh pve1-lab, see ssh_config.example). Joining the tailnet is a one-time
# step (README.md); its state then lives in $PMV_TS_DIR/state.
# usage: start.sh   (env PMV_TS_DIR, default $PMV_LAB/ts-lab; PMV_TS_BIN, folder with the static tailscale and
#        tailscaled binaries, default $PMV_LAB/tailscale-bin; PMV_PROXY_CA, default /root/.ccr/ca-bundle.crt)
WORK=${PMV_WORK:-$HOME/pmv/work}; LAB=${PMV_LAB:-$WORK/lab}
T=${PMV_TS_DIR:-$LAB/ts-lab}; B=${PMV_TS_BIN:-$LAB/tailscale-bin}; mkdir -p "$T"
for p in $(pgrep -x tailscaled); do tr '\0' ' ' < /proc/$p/cmdline | grep -q "$T/tailscaled.sock" && { echo "already running ($p)"; exit 0; }; done
cd $T && SSL_CERT_FILE=${PMV_PROXY_CA:-/root/.ccr/ca-bundle.crt} HTTPS_PROXY=${HTTPS_PROXY} nohup $B/tailscaled --tun=userspace-networking --statedir=$T/state --socket=$T/tailscaled.sock --port=0 --no-logs-no-support --socks5-server=127.0.0.1:1080 --outbound-http-proxy-listen=127.0.0.1:1081 >> $T/tailscaled.log 2>&1 &
for i in $(seq 1 30); do $B/tailscale --socket=$T/tailscaled.sock status >/dev/null 2>&1 && break; sleep 1; done
$B/tailscale --socket=$T/tailscaled.sock status | head -5
