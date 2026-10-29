#!/bin/bash
# Bring the whole lab back after a container restart (files persist, processes do not): the lab LAN, the guests'
# apt cache, Docker and its proxy relay, lxcfs, the two lab hosts' sshd, the desktop, Chromium's docs mode, then checks.
# The Proxmox stand-in is not started here: run pve-real.sh off (or reset-world.sh) next.
# usage: bring-up.sh   (as root, with HTTPS_PROXY set to the egress proxy; env PMV_WORK, PMV_DISPLAY; logs in $PMV_WORK/logs)
HERE=$(dirname "$(readlink -f "$0")"); TOOLS=$(dirname "$HERE")
WORK=${PMV_WORK:-$HOME/pmv/work}; LOGS=$WORK/logs; mkdir -p "$LOGS"
PP=$(python3 -c "import os,urllib.parse as u;print(u.urlparse(os.environ['HTTPS_PROXY']).port)")
echo "== lab LAN (vmbr0, NAT, DHCP, names)"; bash $HERE/net.sh
# Guests' plain-HTTP traffic (apt) goes to squid's intercept port.
iptables -t nat -C PREROUTING -i vmbr0 -s 192.168.1.0/24 ! -d 192.168.1.0/24 -p tcp --dport 80 -j REDIRECT --to-ports 3129 2>/dev/null || \
  iptables -t nat -I PREROUTING -i vmbr0 -s 192.168.1.0/24 ! -d 192.168.1.0/24 -p tcp --dport 80 -j REDIRECT --to-ports 3129
echo "== apt cache for guests"; pgrep -x squid >/dev/null || squid; sleep 1
echo "== docker"
# After a container restart the old pid files point at PIDs that no longer exist (or belong to something else).
for pf in /var/run/docker.pid:dockerd /var/run/docker/containerd/containerd.pid:containerd /run/containerd/containerd.pid:containerd; do
  f=${pf%%:*}; want=${pf##*:}; [ -f "$f" ] && [ "$(cat /proc/$(cat $f)/comm 2>/dev/null)" != "$want" ] && rm -f "$f"
done
if ! pgrep -x dockerd >/dev/null; then
  (HTTP_PROXY=$HTTPS_PROXY HTTPS_PROXY=$HTTPS_PROXY NO_PROXY="localhost,127.0.0.1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12" nohup dockerd > $LOGS/dockerd.log 2>&1 &)
  for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
fi
docker info --format 'docker {{.ServerVersion}}' 2>&1 | tail -1
for i in $(seq 1 20); do ip -4 addr show docker0 2>/dev/null | grep -q 172.17.0.1 && break; sleep 0.5; done
# Containers (image builds) reach the egress proxy through the relay on 172.17.0.1:3128.
pgrep -f "basefix/relay.py" >/dev/null && pkill -f "basefix/relay\.py"; sleep 0.5
(nohup python3 -I $HERE/basefix/relay.py 3128 $PP > $LOGS/relay.log 2>&1 &)
echo "== lxcfs"; pgrep -x lxcfs >/dev/null || { mkdir -p /var/lib/lxcfs; (nohup lxcfs /var/lib/lxcfs > $LOGS/lxcfs.log 2>&1 &); sleep 1.5; }
echo "== lab hosts (sshd for proxmate and pve1)"
for h in proxmate pve1; do
  pgrep -f "sshd -D -f /etc/ssh/lab/$h/" >/dev/null || (nohup unshare --uts bash -c "hostname $h; exec /usr/sbin/sshd -D -f /etc/ssh/lab/$h/sshd_config" > $LOGS/sshd-$h.log 2>&1 &)
done
sleep 1
echo "== desktop"; pgrep -x gnome-shell >/dev/null || { bash $TOOLS/record/start-desktop.sh; for i in $(seq 1 40); do pgrep -x gnome-shell >/dev/null && break; sleep 0.5; done; sleep 6; }
echo "== Chromium uses the live proxmate.host through the egress proxy"; bash $HERE/docs-mode.sh official
echo "== checks"
runuser -u alex -- ssh -o BatchMode=yes -o ConnectTimeout=5 alex@proxmate 'echo "ssh proxmate: $(hostname)"; docker version --format "docker from box: {{.Server.Version}}"'
runuser -u alex -- ssh -o BatchMode=yes -o ConnectTimeout=5 alex@proxmate 'sudo ssh -o BatchMode=yes root@pve1 hostname' | sed 's/^/ssh pve1 from box: /'
pgrep -x gnome-shell >/dev/null && echo "gnome-shell up"
