// Records the ProxMate first-time-setup tutorial on the real Ubuntu desktop, one capture per chapter.
// Example kept from part one: copy it next to a new script and rewrite the chapters (CH.*) for the new video.
// Usage: PMV_WORK=~/pmv/work/part1 TAKE=take1 ONLY=S02,S03 node record-part1.cjs
//        (chapters run in the order given; state carries over in <take>/state.json; captures go to $PMV_WORK/rec/<take>/chapters)
// env: PMV_WORK, VOICE_DIR (narration manifest dir, default $PMV_WORK/narr/voice), PROXMATE_URL, PMV_PVE_URL,
//      PMV_LAB (lab scripts, default $PMV_WORK/lab), PMV_PVE_TOKENS, PMV_FRIEND_PUBKEY, PMV_SETCLOCK, PMV_DISPLAY,
//      and the passwords typed on camera: PMV_ADMIN_PASSWORD, PMV_FRIEND_PASSWORD, PMV_VM_PASSWORD.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const TOOLS = path.join(__dirname, '..');
const x = require(path.join(TOOLS, 'xin.cjs'));
const { Web, captionButtons } = require(path.join(TOOLS, 'web.cjs'));
const { Chapter, loadNarration, waitPrompt, promptStamp, waitInput, log, sleep, WORK } = require(path.join(TOOLS, 'stage.cjs'));
// Credentials come from the environment, read only when a chapter types them.
const env = (k) => { const v = process.env[k]; if (!v) throw new Error(`set ${k}`); return v; };

const TAKE = process.env.TAKE || 'take1';
const OUT = `${WORK}/rec/${TAKE}`; fs.mkdirSync(OUT, { recursive: true });
const MAN = loadNarration(process.env.VOICE_DIR || `${WORK}/narr/voice`);
const STATE_F = `${OUT}/state.json`;
const S = fs.existsSync(STATE_F) ? JSON.parse(fs.readFileSync(STATE_F, 'utf8')) : {};
const save = () => fs.writeFileSync(STATE_F, JSON.stringify(S, null, 1));
const LAB = process.env.PMV_LAB || `${WORK}/lab`; // part one's lab scripts (pve-real.sh, s03-preroll.cjs...): link them from ../../lab (see ../../lab/README.md)
const TOK = JSON.parse(fs.readFileSync(process.env.PMV_PVE_TOKENS || '/etc/pve-lab/tokens.json', 'utf8'));
const ADMIN = { name: 'Alex', email: 'alex@example.com', get pw() { return env('PMV_ADMIN_PASSWORD'); } };
const MIKE = { name: 'Mike', email: 'mike@example.com', get pw() { return env('PMV_FRIEND_PASSWORD'); }, vm: 'mike-ubuntu', user: 'mike', get vmpw() { return env('PMV_VM_PASSWORD'); } };
const MIKE_KEY = fs.readFileSync(process.env.PMV_FRIEND_PUBKEY || `${LAB}/mike_ed25519.pub`, 'utf8').trim(); // public key, pasted on camera
const APP = (process.env.PROXMATE_URL || 'http://192.168.1.50:3000').replace(/\/$/, '');
const APP_HOST = APP.replace(/^https?:\/\//, ''); // what is typed in the address bar
const PVE = (process.env.PMV_PVE_URL || 'https://192.168.1.10:8006').replace(/\/$/, '');
const PVE_HOST = PVE.replace(/^https?:\/\//, '');
const DOCK = { files: { x: 33, y: 68 }, chromium: { x: 33, y: 132 }, terminal: { x: 33, y: 195 } };

let W = null; // Chromium DevTools reader (connected lazily: the browser is not running at the start)
async function web() { if (!W) W = await Web.connect(); return W; }
const chromeWins = () => x.windows().filter((w) => /chromium/i.test(w.cls));
const termWin = () => x.windows().find((w) => /terminal/i.test(w.cls));
async function dockClick(icon) { await x.click(icon.x, icon.y); await sleep(160); await x.moveTo(520 + Math.random() * 200, 380 + Math.random() * 160); }
async function maximize(win, kind) { if (x.isMaximized(win.id)) return; const b = captionButtons(win.id, kind); await x.click(b.max.x, b.max.y); await sleep(700); }
async function minimize(win, kind) { if (x.isMinimized(win.id)) return; const b = captionButtons(win.id, kind); await x.click(b.min.x, b.min.y); await sleep(700); }
async function focusWin(win, kind) {
  // Bring an app forward the way a person would: its icon in the Ubuntu dock.
  const active = () => { const a = x.activeWindow(); return a && parseInt(a, 10) === parseInt(win.id, 16); };
  if (active()) return;
  const icon = kind === 'chromium' ? DOCK.chromium : DOCK.terminal;
  const siblings = kind === 'chromium' ? chromeWins().filter((q) => !x.isMinimized(q.id)) : [termWin()];
  if (siblings.length <= 1 || x.isMinimized(win.id) === false && siblings.length === 1) { await dockClick(icon); await sleep(500); }
  if (!active()) { x.xdo(['windowactivate', '--sync', String(parseInt(win.id, 16))], { quiet: true }); await sleep(400); }
}
const adminWin = () => chromeWins().find((w) => w.id === S.adminWin) || chromeWins()[0];
// The admin tab and Mike's incognito tab share one DevTools context; each is tagged (window.name) when first opened.
async function taggedPage(tag, timeout = 15000) {
  const w = await web(); const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    for (const p of w.pages()) { try { if ((await p.evaluate(() => window.name)) === tag) { p.setDefaultTimeout(20000); return p; } } catch {} }
    await sleep(250);
  }
  throw new Error('no tab tagged ' + tag);
}
const adminPage = () => taggedPage('pm-admin');
// Screen rectangle [x, y, w, h] around page elements, for c.zoom() (the edit eases in on it; edit/fx.py).
async function rectOf(p, locs, pad = 10) {
  const w = await web(); const m = await w.metrics(p); let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const l of [].concat(locs)) { const b = await l.first().boundingBox().catch(() => null); if (!b) continue;
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height); }
  if (x0 > x1) throw new Error('nothing visible');
  return [m.dx + (x0 - pad) * m.z, m.dy + (y0 - pad) * m.z, (x1 - x0 + 2 * pad) * m.z, (y1 - y0 + 2 * pad) * m.z];
}
// A zoom is polish: if its target cannot be measured, the take goes on without it.
async function zoomOn(c, p, locs, pad) { try { c.zoom(await rectOf(p, locs, pad)); } catch (e) { log(`  (zoom skipped: ${e.message.split('\n')[0]})`); } }
const mikePage = () => taggedPage('pm-mike');

// ---------- terminal ----------
const HOST = { desk: 'alex-desktop', box: 'proxmate' };
async function sh(cmd, { host = HOST.box, wait = true, cps = 15, timeout = 600000, pre = 250 } = {}) {
  const since = Date.now();
  await x.type(cmd, { cps }); await sleep(pre); await x.key('Return');
  if (wait) { await waitPrompt(host, since, timeout); await sleep(350); }
}
function termCell() {
  const w = termWin(); const out = spawnSync('xprop', ['-id', String(parseInt(w.id, 16)), 'WM_NORMAL_HINTS'], { env: { ...process.env, DISPLAY: x.DISPLAY }, encoding: 'utf8' }).stdout;
  const m = out.match(/resize increment: (\d+) by (\d+)/); return m ? { cw: +m[1], ch: +m[2] } : { cw: 10, ch: 25 };
}

// ---------- chapters ----------
const CH = {};

CH.S02 = async (c) => {
  await x.moveTo(980, 560);
  await c.begin(); await sleep(900);
  await c.say(0);
  await dockClick(DOCK.chromium);
  const win = await x.waitWindow((w) => /chromium/i.test(w.cls), 30000); S.adminWin = win.id; save();
  await sleep(1000);
  await maximize(win, 'chromium'); await sleep(500);
  const w = await web(); let p = await w.page((u) => u.startsWith('chrome://new'));
  await w.go('proxmate.host'); p = await w.page((u) => u.includes('proxmate.host')); await p.waitForLoadState('load', { timeout: 45000 }); await sleep(600);
  await c.say(1); await w.move(p, p.getByRole('heading', { level: 1 }).first());
  await c.say(2); await sleep(900); await x.scroll(3); await sleep(500);
  await c.say(3); await sleep(800); await x.scroll(3);
  await c.say(4); await sleep(400); await x.scroll(-6, { delay: 50 });
  await c.say(5); await w.click(p, p.getByRole('link', { name: 'Docs', exact: true }).first()); await p.waitForURL('**/docs'); await sleep(500);
  await c.say(6); await w.move(p, p.getByRole('heading', { name: 'What is ProxMate?' }).first());
  await c.say(7); await w.move(p, p.getByRole('link', { name: 'Deployment' }).first());
  await c.say(8); await w.move(p, p.getByRole('link', { name: 'Proxmox Integration' }).first());
  await c.say(9); await c.during(0.5); await w.click(p, p.getByRole('link', { name: 'Proxmox Integration' }).first()); await p.waitForURL('**/docs/proxmox');
  return c.end(1.0);
};

// The token is created in a real Proxmox VE web UI (lab/s03-preroll.cjs gets the browser ready off camera).
CH.S03 = async (c) => {
  execFileSync('bash', [`${LAB}/pve-real.sh`, 'on'], { stdio: 'inherit', timeout: 120000 });
  execFileSync('node', [`${LAB}/s03-preroll.cjs`], { cwd: TOOLS, stdio: 'inherit', timeout: 360000 });
  // Re-taking only this chapter: make the top-bar clock read what the footage either side shows.
  if (process.env.CLOCK) execFileSync('bash', [process.env.PMV_SETCLOCK || `${LAB}/setclock.sh`, process.env.CLOCK], { stdio: 'inherit' });
  try { return await S03take(c); } finally { execFileSync('bash', [`${LAB}/pve-real.sh`, 'off'], { stdio: 'inherit', timeout: 120000 }); }
};
async function S03take(c) {
  const w = await web(); const docs = await w.page((u) => u.includes('proxmate.host/docs/proxmox'));
  const pin = { top: 0, bottom: 0 }; // the Proxmox UI never scrolls the page
  await c.begin(); await sleep(500);
  // The tab opens and the UI draws under the lead-in, so the menu path is spoken over the clicks themselves.
  await c.say(0); await c.during(0.35); await x.key('ctrl+t'); await sleep(450);
  await w.go(PVE_HOST);
  const p = await w.page((u) => u.startsWith(PVE));
  const dc = p.locator('.x-tree-node-text').filter({ hasText: /^Datacenter$/ }).first();
  await dc.waitFor({ timeout: 30000 }); await sleep(600);
  await c.say(1); await c.during(0.08); await w.click(p, dc, pin);
  await c.during(0.32); await w.move(p, p.locator('.x-treelist-item-text').filter({ hasText: /^Permissions$/ }).first(), pin);
  await c.during(0.55); await w.click(p, p.locator('.x-treelist-item-text').filter({ hasText: /^API Tokens$/ }).first(), pin);
  await c.during(0.86); await w.click(p, p.locator('.x-btn:visible').filter({ hasText: /^Add$/ }).first(), pin);
  const dlg = p.locator('.x-window:visible').filter({ hasText: 'Add: Token' }); await dlg.waitFor(); await sleep(400);
  const privsep = dlg.locator('input[name=privsep]');
  const nearBox = { ...pin, fx: 3.2, fy: 0.55 }; // to the right of the checkbox, clear of the Expire field
  await c.say(2); await zoomOn(c, p, dlg, 6); await w.move(p, dlg.locator('input[name=userid]'), { ...pin, fx: 0.3 });
  await c.during(0.62); await w.type(p, dlg.locator('input[name=tokenid]'), 'proxmate', { cps: 9 });
  // Leave the field so its "This field is required" hint (shown while it was empty) clears before the next line.
  await x.key('Tab'); await w.move(p, privsep, nearBox); await sleep(700);
  await c.say(3);
  await c.say(4);
  await c.say(5); await x.moveTo(x.pointer().x + 70, x.pointer().y - 4, { speed: 0.4 });
  await c.say(6); await w.move(p, privsep, nearBox);
  await c.say(7); await c.during(0.08); await w.click(p, privsep, pin);
  if (await privsep.isChecked()) throw new Error('Privilege Separation is still ticked');
  await w.move(p, privsep, nearBox);
  await c.during(0.3); await w.click(p, dlg.locator('.x-btn').filter({ hasText: /^Add$/ }), pin);
  const sec = p.locator('.x-window:visible').filter({ hasText: 'Token Secret' }); await sec.waitFor();
  // Kept only for the check after recording that this token really works.
  fs.writeFileSync(`${OUT}/s03-token.json`, JSON.stringify(await sec.locator('input').evaluateAll((els) => els.map((e) => e.value))), { mode: 0o600 });
  await c.during(0.72); await w.click(p, sec.locator('.x-btn').filter({ hasText: 'Copy Secret Value' }), pin);
  await c.quiet(0.4);
  // The proof: the new token in the list, Privilege Separation "No".
  await c.say(8); await c.during(0.05); await w.click(p, sec.locator('.x-tool').first(), pin); c.unzoom();
  await c.during(0.3); await w.move(p, p.locator('.x-grid-item').filter({ hasText: 'proxmate' }).first(), { ...pin, fx: 0.955 }); // just right of its "No", not on it
  await c.quiet(0.3); await x.key('ctrl+w'); await sleep(600);
  // Back to the docs: the line starts while they scroll, so the script is on screen by the time it is named.
  await c.say(9); await w.move(docs, docs.getByRole('heading', { name: 'Least-privilege token script' }), { top: 160, bottom: 450 });
  await c.say(10); await sleep(500); await w.move(docs, docs.locator('pre').filter({ hasText: 'proxmox-token.sh' }).first(), { fy: 0.3, bottom: 200 });
  await c.say(11);
  // In take4 the next chapter's footage starts with the pointer on the code block, so it stays put there.
  if (TAKE !== 'take4') { await c.during(0.4); await x.moveTo(1560, 720, { speed: 0.5 }); }
  await c.say(12);
  return c.end(1.0);
}

// The earlier S03, docs only (kept so a docs-only take can be recorded again).
CH.S03docs = async (c) => {
  const w = await web(); const p = await w.page((u) => u.includes('proxmate.host/docs/proxmox'));
  await c.begin(); await sleep(500);
  await c.say(0); await w.move(p, p.getByRole('heading', { name: 'Creating an API Token' }), { top: 130, bottom: 520 }); await sleep(900);
  await w.move(p, p.getByText('Open Datacenter → Permissions → API Tokens').first());
  await c.say(1); await w.move(p, p.getByText('Click "Add"').first());
  await c.say(2); await w.move(p, p.getByText('uncheck "Privilege Separation"').first());
  await c.say(3); await c.say(4);
  await c.say(5); await w.move(p, p.getByText('The #1 setup pitfall: Privilege Separation.').first(), { bottom: 260 });
  await c.say(6); await w.move(p, p.getByText('Copy the token secret').first());
  await c.say(7); await w.move(p, p.getByRole('heading', { name: 'Least-privilege token script' }), { top: 160, bottom: 450 });
  await c.say(8); await sleep(500); await w.move(p, p.locator('pre').filter({ hasText: 'proxmox-token.sh' }).first(), { fy: 0.3, bottom: 200 });
  await c.say(9); await c.say(10);
  return c.end(1.0);
};

CH.S04 = async (c) => {
  await c.begin(); await sleep(500);
  await c.say(0);
  await c.say(1); await c.during(0.3);
  await dockClick(DOCK.terminal);
  const tw = await x.waitWindow((q) => /terminal/i.test(q.cls), 20000); await sleep(1200);
  await maximize(tw, 'terminal'); await sleep(600);
  await sh('ssh alex@proxmate', { host: HOST.box });
  await c.say(2); await c.during(0.55); await sh('docker --version');
  await c.say(3); await sh('curl -fsSLO https://raw.githubusercontent.com/r0073d-l053r/ProxMate/main/install.sh', { cps: 22 });
  await c.say(4); await c.during(0.6); await sh('less install.sh', { wait: false }); await sleep(1500);
  await c.say(5); await sleep(1200); await x.key('space'); await sleep(1800); await x.key('space');
  await c.say(6); await c.during(0.15); await x.type('/Install them now', { cps: 12 }); await x.key('Return');
  await c.say(7); await c.during(0.5); await x.key('q'); await sleep(400);
  return c.end(1.0);
};

CH.S05 = async (c) => {
  await x.key('ctrl+l'); await sleep(500);
  await c.begin(); await sleep(500);
  await c.say(0); await c.during(0.1); await sh('bash install.sh', { wait: false });
  await waitInput(/bash install\.sh/, 60000);
  await c.say(1); await c.say(2); await c.say(3);
  await c.say(4); await c.during(0.6); const since = Date.now(); await x.type('1', { cps: 6 }); await sleep(300); await x.key('Return');
  await c.say(5); await c.say(6); await c.quiet(0.5);
  c.ffStart('install build', 6); await waitPrompt(HOST.box, since, 900000); await sleep(800); c.ffEnd();
  await c.say(7, { gap: 0.6 });
  // Point at the warning: it sits 13 lines above the prompt at the bottom of the maximized terminal.
  // Point at the warning. Measured on this terminal: the prompt row is centred 37px above the
  // bottom edge, rows are one cell apart, and "! Until you finish..." is 14 rows above the prompt.
  const r = x.visibleRect(termWin().id); const { cw, ch } = termCell();
  const rowUp = (k) => r.y + r.h - 37 - ch * k;
  await c.say(8); c.zoom([r.x, rowUp(15.6), cw * 84, ch * 4.4]); await x.moveTo(r.x + 4 + cw * 2.5, rowUp(14));
  await c.say(9); await x.moveTo(r.x + 4 + cw * 60, rowUp(13), { speed: 0.35 });
  await c.say(10); await c.during(0.5); c.unzoom();
  return c.end(1.0);
};

CH.S06 = async (c) => {
  const w = await web();
  // The terminal's install output cannot be restored after a rewind, so the chapter opens on the browser.
  await focusWin(adminWin(), 'chromium'); await sleep(900); await x.moveTo(1100, 620);
  await c.begin(); await sleep(400);
  await c.say(0); await x.key('ctrl+t'); await sleep(700);
  await w.go(APP_HOST);
  let p = await w.page((u) => u.startsWith(APP)); await p.evaluate(() => { window.name = 'pm-admin'; }); await p.waitForURL('**/setup**'); await p.getByLabel('Display name').waitFor(); await sleep(400);
  await c.say(1); await w.move(p, p.getByText('Create your admin account').first().or(p.getByLabel('Display name')).first());
  await c.say(2);
  await w.type(p, p.getByLabel('Display name'), ADMIN.name); await w.type(p, p.getByLabel('Email'), ADMIN.email);
  await w.type(p, p.getByLabel('Password', { exact: true }), ADMIN.pw, { cps: 18 }); await w.type(p, p.getByLabel('Confirm password'), ADMIN.pw, { cps: 18 });
  await w.click(p, p.getByRole('button', { name: 'Continue' })); await p.waitForURL('**/setup/proxmox');
  await c.say(3);
  await c.say(4); await w.type(p, p.getByLabel('Proxmox host URL'), PVE);
  await c.say(5); await c.during(0.55); await w.type(p, p.getByLabel('API token ID'), 'root@pam!first-try');
  await c.say(6); await x.clipboard(TOK['root@pam!first-try'].secret);
  await w.click(p, p.getByLabel('API token secret')); await x.key('ctrl+v'); await sleep(400);
  await w.click(p, p.getByRole('button', { name: 'Test connection' }));
  log('  red:', (await w.toast(p, /NO permissions/)).slice(0, 90)); await sleep(300);
  await c.say(7); await zoomOn(c, p, p.locator('[data-sonner-toast]').filter({ hasText: /NO permissions/ }), 14);
  await w.move(p, p.locator('[data-sonner-toast]').filter({ hasText: /NO permissions/ }).first(), { fx: 0.3, fy: 0.3, top: 0, bottom: 0 });
  await c.say(8); await x.moveTo(x.pointer().x + 160, x.pointer().y + 40, { speed: 0.4 });
  await c.say(9); c.unzoom();
  await w.type(p, p.getByLabel('API token ID'), 'root@pam!proxmate', { clear: true });
  await x.clipboard(TOK['root@pam!proxmate'].secret);
  await w.click(p, p.getByLabel('API token secret')); await x.key('ctrl+a'); await x.key('ctrl+v'); await sleep(400);
  await w.click(p, p.getByRole('button', { name: 'Test connection' }));
  log('  green:', await w.toast(p, /Connected to Proxmox/)); await sleep(300);
  await c.say(10); await zoomOn(c, p, [p.locator('[data-sonner-toast]').filter({ hasText: /Connected to Proxmox/ }), p.locator('[data-sonner-toast]').filter({ hasText: /VM\.Audit is granted/ })], 14);
  await w.move(p, p.locator('[data-sonner-toast]').filter({ hasText: /Connected to Proxmox/ }).first(), { fx: 0.35, top: 0, bottom: 0 });
  await c.say(11); await w.move(p, p.locator('[data-sonner-toast]').filter({ hasText: /VM\.Audit is granted/ }).first(), { fx: 0.35, top: 0, bottom: 0 }).catch(() => {});
  await c.say(12); c.unzoom(); await w.move(p, p.getByText('Verify TLS certificate').first());
  await c.say(13); await w.click(p, p.getByRole('button', { name: 'Continue' })); await p.waitForURL('**/setup/defaults');
  return c.end(1.2);
};

CH.S07 = async (c) => {
  const w = await web(); const p = await w.page((u) => u.includes('/setup/defaults'));
  await p.getByText('Default storage pool').first().waitFor();
  await c.begin(); await sleep(400);
  await c.say(0); await w.move(p, p.getByText('Default storage pool').first());
  await c.say(1);
  const combos = p.getByRole('combobox');
  await w.select(p, combos.nth(0), /^local\b/);
  await w.select(p, p.locator('#default-network'), 'vmbr0');
  await w.select(p, p.getByRole('combobox').nth(2), /^local\b/);
  await c.say(2);
  await c.say(3); await w.move(p, p.getByText('Installed on every cloud-init VM').first(), { bottom: 330 });
  await zoomOn(c, p, [p.getByText('Installed on every cloud-init VM'), p.getByText(/fail2ban/), p.getByText(/btop/)], 16);
  await c.say(4); await w.move(p, p.getByText(/fail2ban/).first()); await sleep(700); await w.move(p, p.getByText(/btop/).first());
  await c.say(5); c.unzoom(); await w.click(p, p.getByRole('button', { name: 'Continue' })); await p.waitForURL('**/setup/complete'); await sleep(900);
  await w.click(p, p.getByRole('button', { name: 'Finish setup' })); await p.waitForURL(APP + '/'); await sleep(800);
  await c.say(6);
  return c.end(1.2);
};

CH.S08 = async (c) => {
  const w = await web(); const p = await adminPage();
  await c.begin(); await sleep(300);
  await c.say(0); await zoomOn(c, p, [p.getByRole('button', { name: 'Confirm backup' }), p.getByText(/ENCRYPTION_KEY/)], 18);
  await w.move(p, p.getByRole('button', { name: 'Confirm backup' }));
  await c.say(1);
  await c.say(2); await c.during(0.3); c.unzoom(); await c.during(0.45);
  await focusWin(termWin(), 'terminal'); await x.key('ctrl+l'); await sleep(300);
  await sh("grep ENCRYPTION_KEY ~/proxmate/.env | sed 's/=.*/=<hidden>/'", { cps: 20 });
  await c.say(3); await c.during(0.35);
  await focusWin(adminWin(), 'chromium');
  await w.click(p, p.getByRole('checkbox').first()); await w.click(p, p.getByRole('button', { name: 'Confirm backup' }));
  try { log('  toast:', await w.toast(p, /recorded|backed up|confirmed/i, 8000)); } catch { log('  (no backup toast)'); }
  await c.say(4);
  return c.end(1.0);
};

CH.S09 = async (c) => {
  const w = await web(); const p = await adminPage();
  await c.begin(); await sleep(300);
  await c.say(0); await c.during(0.25);
  await w.click(p, p.getByRole('link', { name: 'Settings' }).first()); await p.waitForURL('**/admin/settings**'); await sleep(600);
  await w.click(p, p.getByRole('tab', { name: 'Proxmox' })); await sleep(500);
  await w.move(p, p.getByText('Tenant network isolation').first(), { top: 140, bottom: 520 });
  await c.say(1); await zoomOn(c, p, [p.getByText('Tenant network isolation'), p.getByText(/Apply isolation firewall to new VMs/), p.getByRole('button', { name: 'Enable enforcement' })], 16);
  await w.move(p, p.getByText(/Apply isolation firewall to new VMs/).first());
  await c.say(2);
  await c.say(3); await w.move(p, p.getByRole('button', { name: 'Enable enforcement' }));
  await c.say(4); c.unzoom(); await w.click(p, p.getByRole('button', { name: 'Enable enforcement' })); await sleep(700);
  await w.click(p, p.getByRole('button', { name: 'Enable', exact: true }));
  try { log('  toast:', await w.toast(p, /firewall|isolation/i, 15000)); } catch { log('  (no firewall toast)'); }
  await c.say(5); await zoomOn(c, p, p.getByText(/Isolation is enforced/), 24); await w.move(p, p.getByText(/Isolation is enforced/).first());
  await c.quiet(0.4); c.unzoom();
  return c.end(1.6);
};

CH.S10 = async (c) => {
  const w = await web();
  await c.begin(); await sleep(300);
  await c.say(0);
  await c.say(1); await c.during(0.3); await x.key('ctrl+t'); await sleep(600); await w.go('proxmate.host/docs/deployment');
  const d = await w.page((u) => u.includes('/docs/deployment')); await d.waitForLoadState('load', { timeout: 45000 });
  await c.say(2); await w.move(d, d.getByRole('heading', { name: 'Environment Variables' }), { top: 140, bottom: 600 });
  await c.say(3); await w.move(d, d.locator('tr').filter({ hasText: 'SNIPPET_DIR' }).first(), { fx: 0.15, bottom: 260 });
  await zoomOn(c, d, [d.locator('tr').filter({ hasText: 'SNIPPET_DIR' }), d.locator('tr').filter({ hasText: 'SNIPPET_STORAGE' })], 10);
  await sleep(800); await w.move(d, d.locator('tr').filter({ hasText: 'SNIPPET_DIR' }).first(), { fx: 0.6 });
  await c.say(4); await c.during(0.7); c.unzoom();
  await c.say(5); await c.during(0.1);
  await focusWin(termWin(), 'terminal'); await x.key('ctrl+l'); await sleep(300);
  await sh('sudo apt install -y sshfs', { cps: 18 });
  await sh('sudo mkdir -p /mnt/pve-snippets', { cps: 20 });
  await sh('sudo sshfs -o allow_other root@pve1:/var/lib/vz/snippets /mnt/pve-snippets', { cps: 22 });
  await c.say(6);
  await sh('cd ~/proxmate', { cps: 16 });
  await sh('nano docker-compose.override.yml', { wait: false, cps: 18 }); await sleep(1200);
  for (const line of ['services:', '  backend:', '    volumes:', '      - /mnt/pve-snippets:/snippets']) { await x.type(line, { cps: 16 }); await x.key('Return'); }
  await sleep(500); await x.key('ctrl+o'); await sleep(700); await x.key('Return'); await sleep(600);
  const since = Date.now(); await x.key('ctrl+x'); await waitPrompt(HOST.box, since, 15000); await sleep(400);
  await sh('echo "SNIPPET_DIR=/snippets" >> .env', { cps: 18 });
  await sh('echo "SNIPPET_STORAGE=local" >> .env', { cps: 18 });
  await c.say(7); await c.during(0.05); await sh('docker compose up -d backend', { cps: 18, timeout: 180000 });
  return c.end(1.2);
};

CH.S11 = async (c) => {
  const w = await web();
  await c.begin(); await sleep(300);
  await c.say(0); await focusWin(adminWin(), 'chromium'); await sleep(300); await x.key('ctrl+w'); await sleep(600);
  const p = await adminPage(); await p.bringToFront().catch(() => {});
  await c.say(1); await w.click(p, p.getByRole('link', { name: 'Template Store' }).first()); await p.waitForURL('**/templates**'); await sleep(800);
  await c.say(2);
  await c.say(3); await w.move(p, p.getByText('Manage templates (admin)').first(), { bottom: 400 });
  await w.click(p, p.getByRole('combobox').filter({ hasText: 'Choose a cloud image' }).first(), { after: 500 });
  await c.say(4);
  { const opts = p.getByRole('option'); const n = await opts.count(); for (let i = 1; i < Math.min(n, 6); i++) { await w.move(p, opts.nth(i), { top: 0, bottom: 0 }); await sleep(250); } }
  await w.click(p, p.getByRole('option', { name: /Ubuntu 24\.04 LTS \(Noble\)$/ }).first(), { top: 0, bottom: 0 });
  await w.type(p, p.getByPlaceholder('e.g. Debian 12'), 'Ubuntu 24.04', { clear: true });
  await c.say(5); await w.click(p, p.getByRole('button', { name: 'Add to store' }));
  await c.say(6); await c.say(7); await c.quiet(0.4);
  c.ffStart('download and bake', 7);
  await p.locator('a[href*="/vms/new?template="]').first().waitFor({ timeout: 900000 }); await sleep(1500);
  c.ffEnd();
  await c.say(8, { gap: 0.6 }); await zoomOn(c, p, p.locator('a[href*="/vms/new?template="]').first().locator('xpath=ancestor::*[.//text()[contains(., "Cloud-init")]][1]'), 12);
  await w.move(p, p.getByText('Cloud-init', { exact: true }).first());
  await c.say(9);
  await c.say(10); c.unzoom(); await w.move(p, p.getByText(/✓ automatic/).first(), { bottom: 260 });
  await c.say(11); await c.during(0.2); await w.click(p, p.getByRole('button', { name: 'Configure' }).first()); await sleep(900);
  await w.move(p, p.getByText('Install Cockpit', { exact: true }).first(), { top: 0, bottom: 0 }); await sleep(900);
  await w.move(p, p.getByText('Install Tailscale', { exact: true }).first(), { top: 0, bottom: 0 }); await sleep(600);
  await c.quiet(0.3); await w.click(p, p.getByRole('button', { name: /Save selection|Close|Cancel/ }).first(), { top: 0, bottom: 0 });
  return c.end(1.0);
};

CH.S12 = async (c) => {
  const w = await web(); const p = await adminPage();
  // Re-taking from S12 (lab/s12-preroll.cjs): save the extras again so the "options saved" toast S11 ends on is up.
  if (process.env.S12_RESAVE) { await w.click(p, p.getByRole('button', { name: 'Save selection' }).first(), { top: 0, bottom: 0 }); await sleep(350); }
  await c.begin(); await sleep(300);
  await c.say(0); await w.click(p, p.getByRole('link', { name: 'Invites' }).first()); await p.waitForURL('**/admin/invites**'); await sleep(600);
  await c.say(1);
  await c.say(2); await w.type(p, p.locator('#cpu'), '4', { clear: true }); await w.type(p, p.locator('#ram'), '8', { clear: true }); await w.type(p, p.locator('#storage'), '80', { clear: true });
  await c.say(3); await w.type(p, p.locator('#label'), 'Mike');
  const respP = p.waitForResponse((r) => r.url().includes('/api/invites') && r.request().method() === 'POST', { timeout: 20000 });
  await w.click(p, p.getByRole('button', { name: 'Generate invite' }));
  const b = await (await respP).json(); S.invite = b.inviteUrl || (b.token && `${APP}/register/${b.token}`); save(); log('  invite:', S.invite);
  // Over plain HTTP the page's copy button has no clipboard access ("Could not copy"), so copy it by hand.
  await sleep(500); const link = p.getByText(S.invite, { exact: true }).first();
  await w.move(p, link, { fx: 0.4 }); await sleep(200); x.xdo(['click', '--repeat', '3', '--delay', '90', '1']); await sleep(300); await x.key('ctrl+c'); await sleep(300);
  const clip = spawnSync('runuser', ['-u', 'alex', '--', 'env', `DISPLAY=${x.DISPLAY}`, 'xclip', '-o', '-selection', 'clipboard'], { encoding: 'utf8', timeout: 4000 }).stdout.trim();
  log('  clipboard:', clip === S.invite ? 'invite link' : JSON.stringify(clip.slice(0, 80)));
  await zoomOn(c, p, link, 16);
  await c.say(4); await c.quiet(0.5); c.unzoom();
  return c.end(1.4);
};

CH.S13 = async (c) => {
  const w = await web();
  await c.begin(); await sleep(300);
  await c.say(0); await c.during(0.35);
  const before = new Set(chromeWins().map((q) => q.id));
  await x.key('ctrl+shift+n');
  const mw = await x.waitWindow((q) => /chromium/i.test(q.cls) && !before.has(q.id), 20000); S.mikeWin = mw.id; save(); await sleep(1200);
  await maximize(mw, 'chromium'); await sleep(400);
  await x.key('ctrl+l'); await sleep(200); await x.key('ctrl+v'); await sleep(500); await x.key('Return');
  const p = await w.page((u) => u.includes('/register/')); await p.evaluate(() => { window.name = 'pm-mike'; }); await p.getByLabel('Display name').waitFor(); await sleep(500);
  await c.say(1); await zoomOn(c, p, p.getByText(/vCPU/), 30); await w.move(p, p.getByText(/vCPU/).first());
  await c.say(2); c.unzoom();
  await w.type(p, p.getByLabel('Display name'), MIKE.name); await w.type(p, p.getByLabel('Email'), MIKE.email);
  await w.type(p, p.getByLabel('Password', { exact: true }), MIKE.pw, { cps: 18 }); await w.type(p, p.getByLabel('Confirm password'), MIKE.pw, { cps: 18 });
  await w.click(p, p.getByRole('button', { name: /create account|sign up|register/i }).first()); await p.waitForURL(APP + '/'); await sleep(600);
  await c.say(3);
  await c.say(4); await w.move(p, p.getByText(/vCPU/).first());
  await c.say(5); await w.click(p, p.getByRole('link', { name: 'Virtual Machines' }).first()); await p.waitForURL('**/vms**'); await sleep(500);
  await w.click(p, p.getByRole('link', { name: /New VM|Create your first VM/ }).or(p.getByRole('button', { name: /New VM|Create your first VM/ })).first()); await p.waitForURL('**/vms/new**'); await sleep(600);
  await c.say(6); await w.select(p, p.getByRole('combobox').first(), /Ubuntu 24\.04/); await w.click(p, p.getByRole('button', { name: /^Medium/ }));
  await c.say(7);
  await w.type(p, p.locator('#name'), MIKE.vm, { clear: true }); await w.type(p, p.locator('#ciuser'), MIKE.user, { clear: true });
  await x.clipboard(MIKE_KEY); await w.click(p, p.locator('#sshkey')); await x.key('ctrl+v'); await sleep(300);
  await c.say(8); await w.type(p, p.locator('#cipassword'), MIKE.vmpw, { cps: 16 });
  await c.say(9); await zoomOn(c, p, p.getByText('Install Cockpit', { exact: true }), 40); await w.click(p, p.getByText('Install Cockpit', { exact: true }).first());
  await c.during(0.8); c.unzoom(); await sleep(400);
  await w.click(p, p.getByRole('button', { name: /^(Create VM|Create|Deploy)/ }).last());
  await c.say(10);
  await p.waitForURL(/\/vms\/(?!new)[^/?#]+$/, { timeout: 30000 }).catch(() => {}); log('  vm page', p.url());
  await c.say(11); await c.quiet(0.4);
  c.ffStart('clone, boot, cloud-init', 7);
  await waitGuestReady();
  await p.getByText(/Finishing setup on this VM/).first().waitFor({ state: 'hidden', timeout: 240000 }).catch(() => log('  (setup banner still showing)'));
  await sleep(1000);
  c.ffEnd();
  await c.say(12, { gap: 0.5 }); await w.move(p, p.getByText('Running').first(), { top: 0, bottom: 0 }).catch(() => {});
  return c.end(1.0);
};

// The VM is "ready" for the console when it shows Running AND cloud-init in the guest has finished.
async function waitGuestReady(timeout = 1200000) {
  const t0 = Date.now(); let guest = null;
  while (Date.now() - t0 < timeout) {
    const names = spawnSync('lxc-ls', ['--running'], { encoding: 'utf8' }).stdout.trim().split(/\s+/).filter(Boolean);
    for (const n of names) {
      const h = spawnSync('lxc-attach', ['-n', n, '--', 'hostname'], { encoding: 'utf8' }).stdout.trim();
      if (h === MIKE.vm) guest = n;
    }
    if (guest) {
      const st = spawnSync('lxc-attach', ['-n', guest, '--', 'cloud-init', 'status'], { encoding: 'utf8' }).stdout;
      if (/status: (done|error)/.test(st)) { log('  guest', guest, st.trim().split('\n').pop()); S.guest = guest; save(); return; }
    }
    await sleep(3000);
  }
  throw new Error('guest never became ready');
}

CH.S14 = async (c) => {
  const w = await web(); const p = await mikePage();
  await c.begin(); await sleep(300);
  await c.say(0);
  if (!/\/vms\/[^/]+$/.test(p.url())) { await w.click(p, p.getByRole('link', { name: MIKE.vm }).first()); await p.waitForURL(/\/vms\/[^/]+$/); await sleep(700); }
  await w.click(p, p.getByRole('button', { name: 'Console' }).first(), { after: 600 });
  await w.click(p, p.getByRole('menuitem', { name: /Text/ }).first(), { top: 0, bottom: 0 });
  await sleep(1800);
  const cons = p;
  const term = cons.locator('.xterm-screen, .xterm').first(); await term.waitFor({ timeout: 15000 });
  await w.click(cons, term, { fx: 0.5, fy: 0.5, top: 0, bottom: 0 }); await sleep(400); await x.key('Return'); await sleep(900);
  await c.say(1);
  await c.say(2); await x.type(MIKE.user, { cps: 10 }); await x.key('Return'); await sleep(1100); await x.type(MIKE.vmpw, { cps: 14 }); await x.key('Return'); await sleep(2500);
  await c.say(3); { const b = await term.boundingBox(); const m = await w.metrics(cons); if (b) c.zoom([m.dx + b.x * m.z, m.dy + b.y * m.z, b.width * 0.62 * m.z, b.height * 0.42 * m.z]); }
  await x.type('cloud-init status', { cps: 15 }); await x.key('Return'); await sleep(1500);
  await x.type('systemctl is-active cockpit.socket', { cps: 18 }); await x.key('Return'); await sleep(900);
  await c.quiet(0.3); c.unzoom(); await sleep(500);
  await c.say(4); await c.during(0.2); await x.type('btop', { cps: 10 }); await x.key('Return'); await sleep(4200); await x.key('q'); await sleep(600);
  await c.say(5);
  await c.say(6); await c.during(0.05);
  await w.click(cons, cons.getByRole('link', { name: 'Help & Docs' }).first(), { top: 0 }); await cons.waitForURL('**/help**'); await sleep(600);
  await w.move(cons, cons.getByText(/SSH into your VM from anywhere/).first()); await sleep(1200);
  await w.move(cons, cons.getByText(/Publish a public website/).first());
  await c.say(7);
  return c.end(1.0);
};

CH.S15 = async (c) => {
  const w = await web();
  // Before rolling: Mike's window away, the admin window in front on its VM list.
  const mw = chromeWins().find((q) => q.id === S.mikeWin); if (mw) await minimize(mw, 'chromium');
  await focusWin(adminWin(), 'chromium');
  const p = await adminPage();
  await w.click(p, p.getByRole('link', { name: 'Virtual Machines' }).first()); await p.waitForURL('**/vms**'); await sleep(900);
  await x.moveTo(1500, 900);
  await c.begin(); await sleep(400);
  await c.say(0); await zoomOn(c, p, [p.getByText(/quota/), p.getByText(MIKE.vm)], 30); await c.during(0.15); await w.move(p, p.getByText(MIKE.vm).first(), { fy: 1.9 }); await sleep(900); await x.moveTo(1500, 900, { speed: 0.6 });
  await c.say(1); c.unzoom();
  await c.say(2);
  await c.say(3);
  await c.say(4); await c.during(0.1); await x.key('ctrl+t'); await sleep(500); await w.go('proxmate.host/docs');
  const d = await w.page((u) => u.endsWith('proxmate.host/docs')); await d.waitForLoadState('load', { timeout: 45000 }); await sleep(500);
  await w.move(d, d.getByRole('link', { name: 'Security' }).first()); await sleep(600); await w.move(d, d.getByRole('link', { name: 'REST API' }).first());
  await c.say(5);
  await c.say(6);
  return c.end(1.5);
};

// Cold open, recorded last: the finished result first.
CH.S01 = async (c) => {
  const w = await web();
  // Before rolling: Mike's incognito window, maximized, logged in on his VM's text console.
  { const aw = adminWin(); x.xdo(['windowactivate', '--sync', String(parseInt(aw.id, 16))], { quiet: true }); await sleep(700);
    const ap = await adminPage(); await ap.bringToFront(); await sleep(400);
    for (const q of w.pages()) { if (q !== ap && q.url().includes('proxmate.host')) { await q.close().catch(() => {}); } }
    await sleep(500); await ap.bringToFront(); if (!/\/vms$/.test(ap.url())) { await ap.goto(APP + '/vms'); } await sleep(800); }
  const mw = chromeWins().find((q) => q.id === S.mikeWin);
  x.xdo(['windowactivate', '--sync', String(parseInt(mw.id, 16))], { quiet: true }); await sleep(800); await maximize(mw, 'chromium');
  const mp = await mikePage();
  await w.click(mp, mp.getByRole('link', { name: 'Virtual Machines' }).first()); await mp.waitForURL('**/vms**'); await sleep(600);
  await w.click(mp, mp.getByRole('link', { name: MIKE.vm }).first()); await mp.waitForURL(/\/vms\/[^/]+$/); await sleep(800);
  await w.click(mp, mp.getByRole('button', { name: 'Console' }).first(), { after: 600 });
  await w.click(mp, mp.getByRole('menuitem', { name: /Text/ }).first(), { top: 0, bottom: 0 }); await sleep(1800);
  const cons = mp;
  const term = cons.locator('.xterm-screen, .xterm').first(); await term.waitFor({ timeout: 15000 });
  await w.click(cons, term, { top: 0, bottom: 0 }); await sleep(300); await x.key('Return'); await sleep(900);
  await x.type(MIKE.user, { cps: 12 }); await x.key('Return'); await sleep(1100); await x.type(MIKE.vmpw, { cps: 14 }); await x.key('Return'); await sleep(2500);
  // ProxMate's relay can drop the console's first resize frame, leaving the guest at 80x24; a real window
  // resize makes xterm send it again once the relay is attached.
  await x.key('super+Down'); await sleep(1400); await maximize(mw, 'chromium'); await sleep(1800);
  { const ps = spawnSync('lxc-attach', ['-n', S.guest || 'vm101', '--', 'bash', '-c', 'for t in $(who | awk \'$1=="mike"{print $2}\'); do stty -F /dev/$t size; done'], { encoding: 'utf8' }).stdout.trim(); log('  mike tty sizes:', ps.replace(/\n/g, ' | ')); }
  await x.key('ctrl+l'); await sleep(600); await x.moveTo(1500, 900);
  await c.begin(); await sleep(400);
  await c.say(0); await c.during(0.05); await x.type('btop', { cps: 10 }); await x.key('Return');
  await c.say(1); await c.during(0.6); await x.key('q'); await sleep(500); await x.type('whoami && hostname', { cps: 14 }); await x.key('Return');
  await c.say(2); await c.during(0.5); await minimize(mw, 'chromium'); await focusWin(adminWin(), 'chromium');
  const p = await adminPage(); await w.move(p, p.getByText(MIKE.vm).first());
  await c.say(3); await zoomOn(c, p, [p.getByText(/quota/), p.getByText(MIKE.vm)], 30); await w.move(p, p.getByText(/quota/).first(), { fy: 1.9 });
  await c.say(4); c.unzoom(); await c.during(0.3); await w.click(p, p.getByRole('link', { name: 'Dashboard' }).first()); await sleep(900);
  await w.move(p, p.getByText('Total cluster load').first());
  await c.say(5); await w.move(p, p.getByText(/Virtual machines by owner/).first(), { bottom: 200 });
  await c.say(6); await c.say(7); await w.click(p, p.getByRole('link', { name: 'Virtual Machines' }).first()); await sleep(600);
  await c.say(8); await w.move(p, p.getByText(MIKE.vm).first());
  return c.end(1.0);
};

(async () => {
  const order = (process.env.ONLY || 'S02,S03,S04,S05,S06,S07,S08,S09,S10,S11,S12,S13,S14,S15,S01').split(',');
  for (const id of order) {
    const c = new Chapter(id, MAN, `${OUT}/chapters`);
    x.onClick = (pt) => { if (c.t0 !== null && c.ff && c.ff.exitCode === null) c.mark('click', { x: pt.x, y: pt.y }); };
    try { await CH[id](c); }
    catch (e) {
      log(`!!! ${id} failed: ${e.message.split('\n')[0]}`);
      try { execFileSync('import', ['-window', 'root', `${OUT}/${id}-fail.png`], { env: { ...process.env, DISPLAY: x.DISPLAY } }); } catch {}
      if (c.ff && c.ff.exitCode === null) { c.ff.stdin.write('q'); c.ff.stdin.end(); }
      process.exitCode = 1; break;
    }
  }
  if (W) await W.b.close().catch(() => {});
  process.exit();
})();
