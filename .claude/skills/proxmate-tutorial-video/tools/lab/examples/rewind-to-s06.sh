#!/bin/bash
# Rewind the lab to the end of chapter S05 (ProxMate just installed, wizard not started) so S06 onward
# can be re-recorded without redoing the docs and install chapters. Part one only.
# usage: TAKE=take4 rewind-to-s06.sh   (as root; env PMV_WORK (the take's state.json is $PMV_WORK/rec/$TAKE),
#        PROXMATE_URL, PMV_PVE_URL, PMV_PVE_LAB_BIN default /usr/local/sbin/pve-lab, PMV_DISPLAY, PMV_CDP)
HERE=$(dirname "$(readlink -f "$0")"); TOOLS=$(dirname "$(dirname "$HERE")")
WORK=${PMV_WORK:-$HOME/pmv/work}; LOGS=$WORK/logs; mkdir -p "$LOGS"
BIN=${PMV_PVE_LAB_BIN:-/usr/local/sbin/pve-lab}; PVE=${PMV_PVE_URL:-https://192.168.1.10:8006}; PVE=${PVE%/}
DISP=${PMV_DISPLAY:-:1}; TAKE=${TAKE:-take4}
set -u
echo "== box: undo S10 (sshfs, override, .env) and start ProxMate with an empty database"
runuser -u alex -- ssh -o BatchMode=yes alex@proxmate '
  cd ~/proxmate && docker compose down -v >/dev/null 2>&1
  mountpoint -q /mnt/pve-snippets && sudo umount /mnt/pve-snippets
  sudo rmdir /mnt/pve-snippets 2>/dev/null
  sudo apt-get remove -y sshfs >/dev/null 2>&1
  rm -f docker-compose.override.yml
  sed -i "/^SNIPPET_DIR=/d;/^SNIPPET_STORAGE=/d" .env
  docker compose up -d >/dev/null 2>&1
  for i in $(seq 1 60); do curl -sf http://127.0.0.1:4000/api/setup/status >/dev/null 2>&1 && break; sleep 2; done
  echo "setup status: $(curl -s http://127.0.0.1:4000/api/setup/status)"; which sshfs || echo "sshfs not installed"; grep -c SNIPPET .env'

echo "== pve1: empty node"
for p in $(pgrep -x python3); do grep -q "$BIN" /proc/$p/cmdline 2>/dev/null && kill $p; done; sleep 1
for c in $(lxc-ls 2>/dev/null); do lxc-stop -k -n "$c" >/dev/null 2>&1; done
for m in $(findmnt -rn -o TARGET | grep '^/var/lib/pve-lab/mnt/' | sort -r); do umount -l "$m"; done
for l in $(losetup -a | grep -E '/var/lib/vz/images/' | cut -d: -f1); do losetup -d "$l"; done
rm -rf /var/lib/pve-lab/qemu/*.json /var/lib/pve-lab/storage.json /var/lib/pve-lab/cluster-fw.json /var/lib/pve-lab/mnt/*
rm -rf /var/lib/vz/images/* /var/lib/vz/import/* /var/lib/vz/snippets/* 2>/dev/null
for c in /var/lib/lxc/vm*; do [ -d "$c" ] && rm -rf "$c"; done
: > /var/log/pve-lab.log
(nohup python3 -I $BIN > $LOGS/pve-lab.stdout 2>&1 &); sleep 2
curl -sk --noproxy '*' $PVE/api2/json/version >/dev/null && echo "pve1 api up"

echo "== desktop: Chromium back on the docs tab, app data cleared, terminal in front"
pkill -x chrome; sleep 2
P=/home/alex/.config/chromium-alex/Default
rm -rf "$P"/Cookies* "$P"/Network/Cookies* "$P"/LocalStorage* "$P"/"Local Storage" "$P"/"Session Storage" "$P"/IndexedDB "$P"/"Web Data"* \
  "$P"/Sessions "$P"/"Current Session" "$P"/"Current Tabs" "$P"/"Last Session" "$P"/"Last Tabs" 2>/dev/null
python3 - <<'EOF'
# Forget every visit to the ProxMate box, so the address bar cannot suggest pages a first-time
# user has never seen. The docs visits from S02-S05 stay, as they would in real life.
import sqlite3, os
from urllib.parse import urlparse
u = urlparse(os.environ.get('PROXMATE_URL') or 'http://192.168.1.50:3000')
P='/home/alex/.config/chromium-alex/Default'; LAB=f"{u.scheme}://{u.hostname}%"
def run(f, stmts):
    if not os.path.exists(f'{P}/{f}'): return
    c=sqlite3.connect(f'{P}/{f}'); n=0
    for s in stmts:
        try: n+=c.execute(s,(LAB,)).rowcount
        except sqlite3.OperationalError: pass
    c.commit(); c.execute('pragma wal_checkpoint(TRUNCATE)'); c.close(); print(f'  {f}: {n} rows removed')
ids="(select id from urls where url like ?)"
run('History', [f"delete from visits where url in {ids}", f"delete from keyword_search_terms where url_id in {ids}",
  f"delete from segments where url_id in {ids}", "delete from visited_links where link_url_id in (select id from urls where url like ?)",
  "delete from urls where url like ?"])
run('Shortcuts', ["delete from omni_box_shortcuts where url like ?"])
run('Top Sites', ["delete from top_sites where url like ?"])
run('Network Action Predictor', ["delete from network_action_predictor where url like ?"])
for f in ('History Provider Cache',):
    if os.path.exists(f'{P}/{f}'): os.remove(f'{P}/{f}')
EOF
chown -R alex:alex /home/alex/.config/chromium-alex/Default
python3 - <<'EOF'
import json
p='/home/alex/.config/chromium-alex/Default/Preferences'; d=json.load(open(p))
d.setdefault('profile',{})['exit_type']='Normal'; d['profile']['exited_cleanly']=True
d.setdefault('browser',{})['window_placement']={"bottom":1080,"left":66,"maximized":True,"right":1920,"top":32,"work_area_bottom":1080,"work_area_left":66,"work_area_right":1920,"work_area_top":32}
d['autofill']={'profile_enabled':False,'credit_card_enabled':False,'enabled':False}
json.dump(d,open(p,'w'))
EOF
# (33,132) is Chromium in the dock.
cd $TOOLS/record && STATE_F=$WORK/rec/$TAKE/state.json timeout 120 node -e "
const x=require('./xin.cjs'); const {Web}=require('./web.cjs');
(async()=>{ await x.click(33,132); const win=await x.waitWindow(w=>/chromium/i.test(w.cls),30000); await x.sleep(2500);
 const w=await Web.connect(); const p=w.pages().find(q=>q.url().startsWith('chrome://new')) || w.pages()[0];
 await p.goto('https://proxmate.host/docs/proxmox',{waitUntil:'load',timeout:45000});
 await p.getByRole('heading',{name:'Least-privilege token script'}).first().scrollIntoViewIfNeeded(); await x.sleep(500);
 for (const q of w.pages()) { if (q!==p) await q.close().catch(()=>{}); }
 // Take focus off the address bar (it holds the URL selected after launch): click a blank spot of the page.
 const spot = await p.evaluate(() => { for (const [fx, fy] of [[0.97,0.6],[0.97,0.8],[0.9,0.9],[0.5,0.97]]) { const X=innerWidth*fx, Y=innerHeight*fy, e=document.elementFromPoint(X,Y);
   if (e && !e.closest('a,button,input,textarea,select,[role=button],[tabindex],pre,code')) return { X, Y, tag: e.tagName }; } return null; });
 if (spot) { const m=await w.metrics(p); await x.click(m.dx+spot.X*m.z, m.dy+spot.Y*m.z); await x.sleep(400); console.log('blank click on', spot.tag); }
 const st0=await p.evaluate(()=>scrollY); console.log('scrollY', st0);
 const fs=require('fs'); const f=process.env.STATE_F; const st=JSON.parse(fs.readFileSync(f,'utf8')); st.adminWin=win.id; delete st.mikeWin; fs.writeFileSync(f, JSON.stringify(st,null,1));
 console.log('chromium maximized:', x.isMaximized(win.id), w.pages().map(q=>q.url())); await w.b.close(); process.exit(0); })().catch(e=>{console.error(e);process.exit(1)})"
TW=$(DISPLAY=$DISP xdotool search --class gnome-terminal | tail -1)
DISPLAY=$DISP xdotool windowactivate --sync $TW; sleep 0.6
DISPLAY=$DISP xdotool type --delay 40 'cd ~'; DISPLAY=$DISP xdotool key Return; sleep 0.6; DISPLAY=$DISP xdotool key ctrl+l; sleep 0.6
DISPLAY=$DISP xdotool mousemove 1100 700
echo "rewound to the end of S05"
