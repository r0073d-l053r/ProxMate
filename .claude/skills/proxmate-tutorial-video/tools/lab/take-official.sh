#!/bin/bash
# Record the whole part-one tutorial against the LIVE https://proxmate.host.
#   1. preflight: the live pages answer 200 through the egress proxy, with no redirect and no Cloudflare
#      challenge, and they contain every string the recorder clicks or points at
#   2. reset the lab, warm Chromium up on the live site off camera (fonts cached, Cloudflare cookie set)
#   3. record S02..S15 then the S01 cold open (../record/examples/record-part1.cjs), assemble, and check colour
# usage: take-official.sh [take-name]      (as root; stops at the first failed check; default take4)
#   env: PMV_WORK (takes in $PMV_WORK/rec/<take>, cut in $PMV_WORK/final-<take>), PMV_LAB, PMV_CDP, PMV_PROXY_CA,
#        and everything record-part1.cjs reads (PMV_ADMIN_PASSWORD, PMV_FRIEND_PASSWORD, PMV_VM_PASSWORD, ...)
set -u
HERE=$(dirname "$(readlink -f "$0")"); TOOLS=$(dirname "$HERE")
WORK=${PMV_WORK:-$HOME/pmv/work}; LOGS=$WORK/logs; mkdir -p "$LOGS"; LAB=${PMV_LAB:-$WORK/lab}
CA=${PMV_PROXY_CA:-/root/.ccr/ca-bundle.crt}
TAKE=${1:-take4}
PX=$(cat /etc/lab/chromium-proxy 2>/dev/null) || { echo "run docs-mode.sh official first"; exit 1; }
[ -e "$LAB/pve-real.sh" ] && [ -e "$LAB/s03-preroll.cjs" ] || { echo "record-part1.cjs needs pve-real.sh and s03-preroll.cjs in $LAB (README.md)"; exit 1; }
UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36'
get() { curl -sS --max-time 30 --cacert "$CA" -x "$PX" -A "$UA" "$@"; }

echo "== preflight: live pages"
ok=1
for u in / /docs /docs/proxmox /docs/deployment; do
  line=$(get -o /dev/null -w "%{http_code} loc=%{redirect_url} mitigated=%header{cf-mitigated} server=%header{server}" "https://proxmate.host$u" 2>&1)
  echo "  $u  $line"
  case "$line" in 200\ loc=\ mitigated=\ *) ;; *) ok=0 ;; esac
done
[ $ok = 1 ] || { echo "preflight failed: the live site is not reachable cleanly (see above)"; exit 2; }

echo "== preflight: text the recorder relies on"
need() { # page, expected count, strings...
  local page=$1 want=$2; shift 2; local html; html=$(get "https://proxmate.host$page")
  local n=0; for s in "$@"; do grep -qF -- "$s" <<<"$html" && n=$((n+1)) || echo "    missing on $page: $s"; done
  echo "  $page: $n/$want"; [ $n = $want ]
}
need /docs/proxmox 8 'Creating an API Token' 'Open Datacenter → Permissions → API Tokens' 'Click &quot;Add&quot;' \
  'uncheck &quot;Privilege Separation&quot;' 'The #1 setup pitfall: Privilege Separation.' 'Copy the token secret' \
  'Least-privilege token script' 'proxmox-token.sh' || ok=0
need /docs/deployment 2 'Environment Variables' 'SNIPPET_DIR' || ok=0
need /docs 3 'What is ProxMate?' '>Security<' '>REST API<' || ok=0
[ $ok = 1 ] || { echo "preflight failed: the live pages differ from what the recorder expects"; exit 3; }
runuser -u alex -- certutil -L -d sql:/home/alex/.pki/nssdb | grep -q 'Sandbox egress' || { echo "proxy CA missing in Chromium"; exit 4; }

echo "== reset the lab"
bash $HERE/reset-world.sh || exit 5

echo "== warm up Chromium on the live site (off camera)"
# (33,132) is Chromium in the dock.
cd $TOOLS/record && timeout 240 node -e "
const x=require('./xin.cjs'); const {chromium}=require('playwright');
(async()=>{ await x.click(33,132); await x.waitWindow(w=>/chromium/i.test(w.cls),30000); await x.sleep(2500);
 const b=await chromium.connectOverCDP(process.env.PMV_CDP||'http://127.0.0.1:9222'); const p=await b.contexts()[0].newPage(); const hosts=new Set();
 p.on('request',r=>{ try { hosts.add(new URL(r.url()).host) } catch {} });
 for (const u of ['/','/docs','/docs/proxmox','/docs/deployment']) { const r=await p.goto('https://proxmate.host'+u,{waitUntil:'load',timeout:45000});
   const t=await p.title(); console.log('  ', r&&r.status(), p.url(), '|', t); if (/just a moment/i.test(t)) { console.log('CLOUDFLARE CHALLENGE'); process.exit(6); } }
 await p.waitForTimeout(3000); console.log('   hosts contacted:', [...hosts].join(', ')); await p.close(); const s=await b.newBrowserCDPSession(); await s.send('Browser.close').catch(()=>{}); process.exit(0); })().catch(e=>{console.error(e.message);process.exit(7)})" || exit $?
sleep 3; pgrep -x chrome >/dev/null && pkill -x chrome; sleep 1

echo "== record"
rm -rf $WORK/rec/$TAKE
TAKE=$TAKE node $TOOLS/record/examples/record-part1.cjs > $LOGS/rec-$TAKE.log 2>&1; rc=$?
grep -v '^\s*$' $LOGS/rec-$TAKE.log | tail -40
[ $rc = 0 ] || { echo "recording stopped (exit $rc); see $LOGS/rec-$TAKE.log and $WORK/rec/$TAKE/*-fail.png"; exit 8; }

echo "== assemble"
mkdir -p $WORK/final-$TAKE
python3 $TOOLS/edit/assemble.py $WORK/rec/$TAKE $WORK/final-$TAKE/proxmate-setup-tutorial.mp4 || exit 9
python3 $TOOLS/edit/verifycolor.py $WORK/rec/$TAKE
