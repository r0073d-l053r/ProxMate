// Off camera, before recording S03: a clean real Proxmox (no `proxmate` token, empty task list), a fresh
// root@pam login cookie, the Proxmox tab at 125% zoom and dark theme, its view reset to Datacenter → Summary,
// then the docs tab back exactly where S02 ends (Proxmox Integration, top of page, pointer on its sidebar link).
// Part one only (chapter S03). record-part1.cjs runs it from $PMV_LAB (link it there, see ../README.md); by hand:
// usage: node s03-preroll.cjs   (env PMV_PVE_URL, PMV_CDP, PMV_DISPLAY, PMV_PVE1_SSH_CONFIG / PMV_TS_DIR; needs pve-real.sh on)
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const x = require(path.join(__dirname, '../../record/xin.cjs'));
const { Web } = require(path.join(__dirname, '../../record/web.cjs'));
const WORK = process.env.PMV_WORK || path.join(os.homedir(), 'pmv', 'work');
const TS = process.env.PMV_TS_DIR || `${process.env.PMV_LAB || `${WORK}/lab`}/ts-lab`;
const SSH_CFG = process.env.PMV_PVE1_SSH_CONFIG || `${TS}/ssh_config`;
const PVE = (process.env.PMV_PVE_URL || 'https://192.168.1.10:8006').replace(/\/$/, ''); const PVE_HOST = new URL(PVE).hostname;
const sshPve = (cmd) => execFileSync('ssh', ['-o', 'ConnectTimeout=25', '-F', SSH_CFG, 'pve1-lab', cmd], { encoding: 'utf8', timeout: 60000 });

(async () => {
  // The narrator's "first token, box left ticked" (used in S06 as root@pam!first-try) exists on this Proxmox
  // too, so the token list S03 shows is the one the story implies. Its secret is never shown or kept.
  console.log(sshPve(`pveum user token remove root@pam proxmate >/dev/null 2>&1;
    pveum user token list root@pam --output-format json | grep -q '"first-try"' || pveum user token add root@pam first-try --privsep 1 >/dev/null;
    : > /var/log/pve/tasks/active; perl -MPVE::Cluster -e 'PVE::Cluster::broadcast_tasklist([])';
    echo "tokens: $(pveum user token list root@pam --output-format json)"`).trim());
  const ticket = execFileSync(path.join(__dirname, '../ts-lab/ticket.sh'), { encoding: 'utf8', env: { ...process.env, PMV_PVE1_SSH_CONFIG: SSH_CFG } }).trim();

  const w = await Web.connect(); const ctx = w.b.contexts()[0];
  await ctx.addCookies([
    { name: 'PVEAuthCookie', value: ticket, domain: PVE_HOST, path: '/', secure: true, sameSite: 'Lax' },
    { name: 'PVEThemeCookie', value: 'proxmox-dark', domain: PVE_HOST, path: '/', secure: true, sameSite: 'Lax' },
  ]);
  // Keep (or open) the docs tab before closing strays, so the browser never drops to zero tabs and quits.
  let docsTab = w.pages().find((q) => q.url().includes('proxmate.host'));
  if (!docsTab) { docsTab = await ctx.newPage(); await docsTab.goto('https://proxmate.host/docs/proxmox', { waitUntil: 'load', timeout: 45000 }); }
  for (const q of w.pages()) if (q !== docsTab) await q.close(); // stray tabs, e.g. from a failed try

  // Warm the Proxmox UI once (cache, cert decision, zoom, view state), then close the tab.
  // The main browser window: Chromium also owns small helper windows, so take the largest one.
  const wins = x.windows().filter((q) => /chromium/i.test(q.cls)).map((q) => { try { const r = x.visibleRect(q.id); return { q, a: r.w * r.h }; } catch { return { q, a: 0 }; } });
  const win = wins.sort((a, b) => b.a - a.a).map((e) => e.q)[0]; if (!win) throw new Error('Chromium is not running');
  x.xdo(['windowactivate', '--sync', String(parseInt(win.id, 16))], { quiet: true }); await x.sleep(400);
  if (!x.isMaximized(win.id)) throw new Error('Chromium is not maximized');
  const step = (m) => console.log(`  preroll: ${m}`);
  // The first connection through the tunnel after a lab reset can stall: short tries, a fresh tab each time.
  let p = null;
  for (let attempt = 1; attempt <= 3 && !p; attempt++) {
    const q = await ctx.newPage(); await q.bringToFront(); step(`open Proxmox (try ${attempt})`);
    const nav = await q.goto(PVE + '/', { waitUntil: 'commit', timeout: 20000 }).then(() => 'ok').catch((e) => e.message.split('\n')[0]);
    if (/ERR_CERT/.test(nav) || await q.locator('#details-button').count().catch(() => 0)) {
      await q.waitForSelector('#details-button', { timeout: 10000 }).catch(() => {});
      if (await q.locator('#details-button').count()) { step('accept the self-signed certificate'); await q.click('#details-button'); await x.sleep(500); await q.click('#proceed-link'); }
    } else if (nav !== 'ok') { step(`navigation: ${nav}`); }
    const ok = await q.locator('.x-tree-node-text').filter({ hasText: /^Datacenter$/ }).first().waitFor({ timeout: 25000 }).then(() => true).catch(() => false);
    if (ok) p = q; else { step('UI did not draw, retrying'); await q.close().catch(() => {}); }
  }
  if (!p) throw new Error('Proxmox UI never loaded');
  const dc = p.locator('.x-tree-node-text').filter({ hasText: /^Datacenter$/ }).first(); await x.sleep(1500); step('UI drawn');
  for (let i = 0; i < 6 && (await p.evaluate(() => devicePixelRatio)) < 1.24; i++) { await x.key('ctrl+equal'); await x.sleep(500); }
  for (let i = 0; i < 6 && (await p.evaluate(() => devicePixelRatio)) > 1.26; i++) { await x.key('ctrl+minus'); await x.sleep(500); }
  await dc.click({ timeout: 15000 }); await x.sleep(600);
  await p.locator('.x-treelist-item-text').filter({ hasText: /^Summary$/ }).first().click({ timeout: 15000 }); await x.sleep(2500);
  const st = await p.evaluate(() => ({ zoom: devicePixelRatio, user: (document.body.innerText.match(/root@pam/) || ['(not logged in)'])[0],
    dark: document.cookie.includes('proxmox-dark') || !!document.querySelector('link[href*="dark"]'), tasks: document.querySelectorAll('.x-grid-item').length }));
  console.log('proxmox tab:', JSON.stringify(st));
  if (st.user !== 'root@pam' || Math.abs(st.zoom - 1.25) > 0.02) throw new Error('Proxmox tab not ready');
  await p.close(); await x.sleep(500);

  // Docs tab: exactly how S02 leaves it.
  const docs = docsTab;
  await docs.bringToFront();
  await docs.goto('https://proxmate.host/docs/proxmox', { waitUntil: 'load', timeout: 45000 }); await x.sleep(1200);
  await docs.evaluate(() => window.scrollTo(0, 0)); await x.sleep(400);
  for (const q of w.pages()) if (q !== docs) await q.close();
  await w.move(docs, docs.getByRole('link', { name: 'Proxmox Integration' }).first()); await x.sleep(600);
  console.log('tabs:', w.pages().map((q) => q.url()), 'zoom on docs:', await docs.evaluate(() => devicePixelRatio));
  await w.b.close(); process.exit(0);
})().catch((e) => { console.error('PREROLL FAILED:', e.message.split('\n')[0]); process.exit(1); });
