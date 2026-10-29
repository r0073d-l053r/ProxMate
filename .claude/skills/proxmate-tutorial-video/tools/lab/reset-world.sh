#!/bin/bash
# Put the whole lab back to "before the tutorial":
#   - ProxMate box: no ProxMate checkout, no containers or data volume, sshfs not installed, nothing mounted
#   - pve1 (the stand-in): an empty node (no guests, no images, no snippets, cluster firewall off)
#   - alex's desktop: Chromium and Terminal closed, browsing history/cookies cleared, empty clipboard
# usage: reset-world.sh   (as root; KEEP_BUILD_CACHE=1 keeps ProxMate's images and Docker's build cache;
#        env PMV_PVE_LAB_BIN default /usr/local/sbin/pve-lab, PMV_PVE_URL; log in $PMV_WORK/logs)
set -u
WORK=${PMV_WORK:-$HOME/pmv/work}; LOGS=$WORK/logs; mkdir -p "$LOGS"
BIN=${PMV_PVE_LAB_BIN:-/usr/local/sbin/pve-lab}; PVE=${PMV_PVE_URL:-https://192.168.1.10:8006}; PVE=${PVE%/}
echo "== box"
runuser -u alex -- ssh -o BatchMode=yes alex@proxmate '
  if [ -d ~/proxmate ]; then (cd ~/proxmate && docker compose down -v --remove-orphans >/dev/null 2>&1); fi
  mountpoint -q /mnt/pve-snippets && sudo umount /mnt/pve-snippets
  sudo rmdir /mnt/pve-snippets 2>/dev/null
  sudo apt-get remove -y sshfs >/dev/null 2>&1
  sudo rm -rf ~/proxmate; rm -rf ~/install.sh ~/.bash_history ~/.lesshst
  sudo rm -f /root/.ssh/known_hosts.old
  echo box clean'
docker volume rm proxmate_proxmate-data >/dev/null 2>&1
# A first install builds from nothing: drop ProxMate's images and the build cache (base images stay).
[ "${KEEP_BUILD_CACHE:-0}" = 1 ] || { docker image rm -f proxmate-backend proxmate-frontend >/dev/null 2>&1; docker builder prune -af >/dev/null 2>&1; echo "build cache cleared"; }

echo "== pve1"
pkill -f "$BIN"; sleep 1
for c in $(lxc-ls 2>/dev/null); do lxc-stop -k -n "$c" >/dev/null 2>&1; done
for m in $(findmnt -rn -o TARGET | grep '^/var/lib/pve-lab/mnt/' | sort -r); do umount -l "$m"; done
for l in $(losetup -a | grep -E '/var/lib/vz/images/' | cut -d: -f1); do losetup -d "$l"; done
rm -rf /var/lib/pve-lab/qemu/*.json /var/lib/pve-lab/storage.json /var/lib/pve-lab/cluster-fw.json /var/lib/pve-lab/mnt/*
rm -rf /var/lib/vz/images/* /var/lib/vz/import/* /var/lib/vz/snippets/* /var/lib/vz/template/iso/* 2>/dev/null
for c in /var/lib/lxc/vm*; do [ -d "$c" ] && rm -rf "$c"; done
: > /var/log/pve-lab.log
(nohup python3 -I $BIN > $LOGS/pve-lab.stdout 2>&1 &); sleep 2
curl -sk --noproxy '*' $PVE/api2/json/version >/dev/null && echo "pve1 api up"

echo "== desktop"
pkill -x chrome; pkill -x gnome-terminal-; sleep 2
rm -rf /home/alex/.cache/chromium-alex   # cached pages from earlier sessions
P=/home/alex/.config/chromium-alex/Default
# Fresh browsing state: keep only the profile's settings (Preferences), drop history, cookies, site storage, caches.
find "$P" -mindepth 1 -maxdepth 1 ! -name Preferences ! -name 'Secure Preferences' -exec rm -rf {} +
python3 - <<'EOF'
import json
p='/home/alex/.config/chromium-alex/Default/Preferences'; d=json.load(open(p))
d.setdefault('browser',{})['window_placement']={"bottom":960,"left":260,"maximized":False,"right":1700,"top":90,"work_area_bottom":1080,"work_area_left":66,"work_area_right":1920,"work_area_top":32}
d.setdefault('profile',{})['exit_type']='Normal'; d['profile']['exited_cleanly']=True
d['credentials_enable_service']=False; d['profile']['password_manager_enabled']=False
d.setdefault('password_manager',{})['leak_detection']=False
d['autofill']={'profile_enabled':False,'credit_card_enabled':False,'enabled':False}
json.dump(d,open(p,'w'))
EOF
rm -f /home/alex/.bash_history /home/alex/.cache/prompt-*
echo "world reset"
