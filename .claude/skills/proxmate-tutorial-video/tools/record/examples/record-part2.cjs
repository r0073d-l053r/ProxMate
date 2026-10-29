// Records tutorial 2 (templates, cloud-init, VMs, the VM page, consoles) on the real Ubuntu desktop, one capture
// per chapter, against ProxMate on the real Proxmox VE node pve1. Same stage as part one (stage.cjs): real X11
// input only, DevTools used to read where things are. Example kept from part two: the newest recorder, the best
// starting point for a new video (copy it and rewrite the chapters, CH.*).
// usage: PMV_WORK=~/pmv/work/part2 TAKE=t2a ONLY=V02,V03 node record-part2.cjs
//        (run prep-part2.cjs first; state carries over between runs in <take>/state.json; captures go to $PMV_WORK/rec/<take>/chapters)
// env: PMV_WORK, VOICE_DIR (narration manifest dir, default $PMV_WORK/narr/voice), PROXMATE_URL, PROXMATE_API,
//      PMV_DISPLAY, PMV_CDP, and the passwords typed on camera or used for the API polling: PMV_ADMIN_PASSWORD,
//      PMV_FRIEND_PASSWORD, PMV_VM_PASSWORD (web-01's cloud-init password), PMV_CT_PASSWORD (the LXC root password).
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const TOOLS = path.join(__dirname, '..');
const x = require(path.join(TOOLS, 'xin.cjs'));
const { Web, captionButtons } = require(path.join(TOOLS, 'web.cjs'));
const { Chapter, loadNarration, log, sleep, WORK } = require(path.join(TOOLS, 'stage.cjs'));
// Credentials come from the environment, read only when they are needed.
const env = (k) => { const v = process.env[k]; if (!v) throw new Error(`set ${k}`); return v; };

const TAKE = process.env.TAKE || 't2a';
const OUT = `${WORK}/rec/${TAKE}`; fs.mkdirSync(OUT, { recursive: true });
const MAN = loadNarration(process.env.VOICE_DIR || `${WORK}/narr/voice`);
const STATE_F = `${OUT}/state.json`;
const S = fs.existsSync(STATE_F) ? JSON.parse(fs.readFileSync(STATE_F, 'utf8')) : {};
const save = () => fs.writeFileSync(STATE_F, JSON.stringify(S, null, 1));
const APP = (process.env.PROXMATE_URL || 'http://192.168.1.50:3000').replace(/\/$/, '');
const APP_HOST = APP.replace(/^https?:\/\//, ''); // what is typed in the address bar
const API = (process.env.PROXMATE_API || 'http://192.168.1.50:4000/api').replace(/\/$/, '');
const ADMIN = { email: 'alex@example.com', get pw() { return env('PMV_ADMIN_PASSWORD'); } };
const MIKE = { email: 'mike@example.com', get pw() { return env('PMV_FRIEND_PASSWORD'); } };
// web-01's password as of the start of this run: the one saved after a reset (V18), else PMV_VM_PASSWORD.
const WEB_PW = S.webPw || process.env.PMV_VM_PASSWORD;
const WEB = { name: 'web-01', user: 'ubuntu', get pw() { return WEB_PW || env('PMV_VM_PASSWORD'); } };
const TPL = 'Ubuntu with Docker';
const KEY = fs.readFileSync('/home/alex/.ssh/id_ed25519.pub', 'utf8').trim();
const DOCK = { chromium: { x: 33, y: 132 }, terminal: { x: 33, y: 195 } };

let W = null;
async function web() { if (!W) W = await Web.connect(); return W; }
const chromeWins = () => x.windows().filter((w) => /chromium/i.test(w.cls));
const noop = () => {};
// The admin tab: tagged with window.name 'pm-admin' by the pre-roll. Every page keeps confirm() prompts on screen.
async function taggedPage(tag, timeout = 15000) {
  const w = await web(); const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    for (const p of w.pages()) { try { if ((await p.evaluate(() => window.name)) === tag) { p.setDefaultTimeout(20000); if (!p.__dlg) { p.on('dialog', noop); p.__dlg = true; } return p; } } catch {} }
    await sleep(250);
  }
  throw new Error('no tab tagged ' + tag);
}
const adminPage = () => taggedPage('pm-admin');
const mikePage = () => taggedPage('pm-mike');

// ---------- ProxMate API (read-only polling for the waits) ----------
let cookie = null;
async function api(path) {
  if (!cookie) {
    const r = await fetch(API + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', Origin: APP }, body: JSON.stringify({ email: ADMIN.email, password: ADMIN.pw }) });
    cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  }
  const r = await fetch(API + path, { headers: { cookie, Origin: APP } });
  if (r.status === 401) { cookie = null; return api(path); }
  return r.json();
}
async function until(fn, timeout, every = 3000, what = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { try { const v = await fn(); if (v) return v; } catch {} await sleep(every); }
  throw new Error(`timed out waiting for ${what}`);
}

// ---------- screen helpers ----------
async function rectOf(p, locs, pad = 10) {
  const w = await web(); const m = await w.metrics(p); let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const l of [].concat(locs)) { const b = await l.first().boundingBox().catch(() => null); if (!b) continue;
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height); }
  if (x0 > x1) throw new Error('nothing visible');
  return [m.dx + (x0 - pad) * m.z, m.dy + (y0 - pad) * m.z, (x1 - x0 + 2 * pad) * m.z, (y1 - y0 + 2 * pad) * m.z];
}
async function zoomOn(c, p, locs, pad) { try { c.zoom(await rectOf(p, locs, pad)); } catch (e) { log(`  (zoom skipped: ${e.message.split('\n')[0]})`); } }
async function park(px = 1700, py = 980) { await x.moveTo(px, py, { speed: 0.6 }); }
// A real click with Ctrl held (xterm opens links only on Ctrl/⌘-click).
async function ctrlClick(px, py) {
  await x.moveTo(px, py); await sleep(220);
  x.xdo(['keydown', 'ctrl']); await sleep(140); x.xdo(['click', '1']);
  if (x.onClick) x.onClick(x.pointer(), 1);
  await sleep(140); x.xdo(['keyup', 'ctrl']); await sleep(150);
}
// The browser's own confirm() prompt: wait for it, find its orange OK button on screen, click it for real.
function okButton() {
  const out = spawnSync('python3', ['-c', `
import subprocess, io
from PIL import Image
im = Image.open(io.BytesIO(subprocess.run(['import','-window','root','png:-'],capture_output=True,env={'DISPLAY':'${x.DISPLAY}'}).stdout)).convert('RGB')
px = im.load(); xs=[]; ys=[]
for y in range(60, 700, 2):
    for x in range(400, 1600, 2):
        r,g,b = px[x,y]
        if r > 190 and 80 < g < 140 and b < 60: xs.append(x); ys.append(y)
print((min(xs)+max(xs))//2 if xs else -1, (min(ys)+max(ys))//2 if ys else -1)
`], { encoding: 'utf8' }).stdout.trim().split(' ').map(Number);
  if (out[0] < 0) throw new Error('confirm OK button not found');
  return { x: out[0], y: out[1] };
}
function dialogOpened(p, timeout = 10000) {
  return new Promise((res, rej) => { const to = setTimeout(() => rej(new Error('no confirm dialog')), timeout); p.once('dialog', (d) => { clearTimeout(to); res(d); }); });
}
async function clickOk(pending) { await pending; await sleep(900); const ok = okButton(); await x.moveTo(ok.x, ok.y, { speed: 0.8 }); await sleep(300); await x.click(); await sleep(500); }

// xterm (DOM renderer): screen rectangle of the first match of `re` in the visible rows.
async function termText(p, re) {
  const w = await web(); const m = await w.metrics(p);
  const r = await p.evaluate((src) => {
    const re = new RegExp(src);
    for (const row of document.querySelectorAll('.xterm-rows > div')) {
      const mm = row.textContent.match(re); if (!mm) continue;
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT); let pos = 0, n, set = false; const range = document.createRange();
      const s = mm.index, e = mm.index + mm[0].length;
      while ((n = walker.nextNode())) { const len = n.textContent.length; if (!set && s < pos + len) { range.setStart(n, s - pos); set = true; } if (set && e <= pos + len) { range.setEnd(n, e - pos); break; } pos += len; }
      const b = range.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height };
    }
    return null;
  }, re.source);
  return r && { x: m.dx + r.x * m.z, y: m.dy + r.y * m.z, w: r.w * m.z, h: r.h * m.z, cx: m.dx + (r.x + r.w / 2) * m.z, cy: m.dy + (r.y + r.h / 2) * m.z };
}
const termAll = (p) => p.evaluate(() => [...document.querySelectorAll('.xterm-rows > div')].map((d) => d.textContent).join('\n'));
async function waitTerm(p, re, timeout = 60000) { return until(async () => re.test(await termAll(p)), timeout, 400, `terminal text ${re}`); }
async function focusTerm(p) { const w = await web(); await w.click(p, p.locator('.xterm-screen, .xterm').first(), { top: 0, bottom: 0, fx: 0.5, fy: 0.85 }); await sleep(300); }
// Log in on a serial console if it shows a login prompt (typed for real).
async function termLogin(p, user, pw) {
  await x.key('Return'); await sleep(900);
  const txt = await termAll(p);
  if (/login:\s*$/m.test(txt.trimEnd()) || /login:\s*$/.test(txt.trimEnd())) {
    await x.type(user, { cps: 10 }); await x.key('Return'); await waitTerm(p, /Password:\s*$/m, 15000); await sleep(300);
    await x.type(pw, { cps: 14 }); await x.key('Return'); await waitTerm(p, /\$\s*$/m, 30000); await sleep(400);
  }
}
async function vmIdFromUrl(p) { return (p.url().match(/\/vms\/([a-z0-9]+)/) || [])[1]; }
const sidebar = (p, name) => p.getByRole('link', { name, exact: true }).first();
const menuItem = (p, re) => p.getByRole('menuitem', { name: re }).first();
const cardOf = (p, title) => p.locator('[data-slot=card]').filter({ has: p.locator('[data-slot=card-title]', { hasText: title }) }).first();
async function vmPage(p, id, tab) { const w = await web(); if (!p.url().endsWith(`/vms/${id}`) || tab) { await p.goto(`${APP}/vms/${id}${tab ? `?tab=${tab}` : ''}`); await sleep(1500); } return w; }

// ---------- chapters ----------
const CH = {};

CH.V02 = async (c) => {
  const w = await web(); const p = await adminPage();
  await p.goto(APP + '/templates'); await sleep(1500); await park(1200, 640);
  await c.begin(); await sleep(500);
  await c.say('Everything starts'); await w.move(p, p.getByRole('heading', { name: 'Template Store' }).first(), { fx: 0.8 });
  await c.say('A template is'); await c.during(0.3); await w.move(p, cardOf(p, 'Ubuntu 24.04'), { fx: 0.3, fy: 0.3 });
  await c.say('three ways'); await c.during(0.2); await w.move(p, p.getByText('Add a cloud image (admin)').first(), { fx: 0.9 });
  await c.say('Add a cloud image downloads'); await zoomOn(c, p, p.getByText('Add a cloud image (admin)').locator('xpath=ancestor::*[@data-slot="card"][1]'), 8);
  await w.move(p, p.locator('[data-slot=select-trigger]').first(), { fx: 0.3 });
  await c.say('Add from cluster publishes'); c.unzoom(); await c.during(0.15); await w.move(p, p.getByRole('button', { name: 'Add from cluster' }).first());
  await c.say('Save as template turns'); await c.during(0.2); await w.move(p, p.getByText(/convert it to a template from its detail page/).first(), { fx: 0.75 });
  await c.say('Here\'s Ubuntu 24.04'); await zoomOn(c, p, cardOf(p, 'Ubuntu 24.04'), 14); await c.during(0.3); await w.move(p, cardOf(p, 'Ubuntu 24.04').getByRole('button', { name: 'Deploy' }));
  await c.quiet(0.4); c.unzoom();
  return c.end(1.0);
};

CH.V03 = async (c) => {
  const w = await web(); const p = await adminPage();
  if (!p.url().endsWith('/templates')) { await p.goto(APP + '/templates'); await sleep(1500); }
  const trigger = p.locator('[data-slot=select-trigger]').first();
  await c.begin(); await sleep(400);
  await c.say('Let\'s add Debian 13'); await c.during(0.4); await w.click(p, trigger, { after: 700 });
  const list = p.locator('[data-slot=select-content]').first(); await list.waitFor();
  await c.say('Open the list'); await w.move(p, p.locator('[data-slot=select-item]').filter({ hasText: 'Ubuntu 24.04' }).first());
  await sleep(500); await x.scroll(3, { delay: 140 }); await sleep(500); await x.scroll(3, { delay: 140 });
  await c.say('Want something'); await sleep(300); await x.scroll(6, { delay: 110 }); await sleep(400);
  await w.move(p, p.locator('[data-slot=select-item]').filter({ hasText: /Custom image URL/ }).first(), { top: 0, bottom: 0 });
  await c.say('Pick Debian 13'); await c.during(0.1); await x.scroll(-14, { delay: 60 }); await sleep(400);
  await w.click(p, p.locator('[data-slot=select-item]').filter({ hasText: 'Debian 13 (Trixie)' }).filter({ hasNotText: 'ARM64' }).first(), { top: 0, bottom: 0, after: 500 });
  await c.during(0.65); await w.move(p, p.getByPlaceholder('e.g. Debian 12'), { fx: 0.15 });
  await c.say('Add to store'); await c.during(0.2); await w.click(p, p.getByRole('button', { name: 'Add to store' }));
  const t0 = Date.now();
  await c.say('Proxmox downloads'); await sleep(1500); await park(1500, 700);
  await c.say('That guest agent matters');
  await c.say('This takes a few minutes'); await c.quiet(0.3);
  c.ffStart('cloud image build', 7);
  await until(async () => (await api('/templates')).some((t) => /^Debian 13/.test(t.name)), 25 * 60000, 5000, 'the Debian 13 template');
  await until(async () => (await cardOf(p, 'Debian 13').count()) > 0, 30000, 500, 'the Debian 13 card');
  await sleep(1200); c.ffEnd(); log(`  build took ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  const card = cardOf(p, 'Debian 13');
  await c.say('And there\'s Debian 13', { gap: 0.6 }); await w.move(p, card.getByText('Cloud-init').first(), { bottom: 160 }); await zoomOn(c, p, card, 14);
  await c.quiet(0.6); c.unzoom();
  return c.end(1.0);
};

CH.V04 = async (c) => {
  const w = await web(); const p = await adminPage();
  if (!p.url().endsWith('/templates')) { await p.goto(APP + '/templates'); await sleep(1500); }
  const card = cardOf(p, 'Debian 13'); await w.reveal(p, card, { bottom: 140 });
  await c.begin(); await sleep(400);
  await c.say('Each card has'); await zoomOn(c, p, card, 14); await w.move(p, card.getByRole('button', { name: 'Deploy' }), { fx: -1.4 });
  await c.say('The pencil adds'); await c.during(0.2); await w.click(p, card.locator('button[title="Edit notes & icon"]'), { after: 600 });
  await w.move(p, card.getByText('Upload icon').first());
  await c.say('I\'ll write'); await c.during(0.15);
  await w.type(p, card.locator('textarea'), 'Log in as debian with the SSH key you picked.', { cps: 17 });
  await w.click(p, card.getByRole('button', { name: 'Save' }), { after: 900 });
  c.unzoom();
  await c.say('Refresh downloads'); await w.move(p, card.locator('button[title^="Rebuild from the latest cloud image"]'));
  await c.say('ProxMate can do that for you'); await c.during(0.25); await w.click(p, sidebar(p, 'Settings')); await p.waitForURL('**/admin/settings**'); await sleep(700);
  await w.click(p, p.getByRole('tab', { name: 'Maintenance' }).first(), { after: 900 });
  const fresh = p.getByText('Cloud-image freshness').first(); await w.move(p, fresh, { fx: 0.9, bottom: 300 });
  await zoomOn(c, p, fresh.locator('xpath=ancestor::*[@data-slot="card"][1]'), 10);
  await c.quiet(0.9); c.unzoom(); await sleep(500);
  await w.click(p, sidebar(p, 'Template Store')); await p.waitForURL('**/templates'); await sleep(900);
  await c.say('And the bin', { gap: 0.2 }); await w.move(p, cardOf(p, 'Debian 13').locator('button[title^="Delete template"]'), { bottom: 140 });
  await c.quiet(0.4); await park(1500, 760);
  return c.end(1.0);
};

CH.V05 = async (c) => {
  const w = await web(); const p = await adminPage();
  if (!p.url().endsWith('/templates')) { await p.goto(APP + '/templates'); await sleep(1500); }
  await c.begin(); await sleep(400);
  await c.say('Already have templates'); await c.during(0.5); await w.click(p, p.getByRole('button', { name: 'Add from cluster' }));
  const row = p.getByText('debian-12-golden').first(); await row.waitFor({ timeout: 30000 });
  await c.say('Add from cluster lists'); await w.move(p, row, { fx: 0.4 });
  await c.say('Here\'s debian-12-golden'); await zoomOn(c, p, [row, p.getByRole('button', { name: 'Publish' })], 16); await w.move(p, p.getByText(/vmid 9100/).first());
  await c.say('Add a login note'); await c.during(0.2);
  await w.type(p, p.getByPlaceholder(/Optional login notes/), 'Log in as debian with the SSH key you picked.', { cps: 17 });
  await w.click(p, p.getByRole('button', { name: 'Publish' }), { after: 800 }); c.unzoom();
  const card = cardOf(p, 'debian-12-golden'); await card.waitFor({ timeout: 30000 }); await sleep(600);
  await c.say('It\'s in the store now'); await w.move(p, card, { fx: 0.5, fy: 0.3, bottom: 120 });
  await c.say('ProxMate spotted'); await zoomOn(c, p, card, 14); await w.move(p, card.getByText('Cloud-init').first());
  await c.quiet(0.5); c.unzoom();
  return c.end(1.0);
};

CH.V06 = async (c) => {
  const w = await web(); const p = await adminPage();
  if (!p.url().endsWith('/templates')) { await p.goto(APP + '/templates'); await sleep(1500); }
  await w.reveal(p, p.getByText('Cloud-init extras (admin)').first(), { top: 140 });
  await c.begin(); await sleep(400);
  await c.say('Next up, cloud-init extras'); await c.during(0.55); await w.click(p, p.getByRole('button', { name: 'Configure' }), { after: 900 });
  const offered = p.getByText('Options offered to tenants').first();
  await c.say('The top list'); await w.move(p, offered, { fx: 1.4, top: 120, bottom: 120 });
  const box = p.locator('label').filter({ hasText: 'Install code-server' }).first();
  await c.say('I\'ll untick code-server'); await c.during(0.15); await w.click(p, box, { fx: 0.1, after: 400 });
  const always = p.getByText('Installed automatically on every VM').first();
  await c.say('The bottom list'); await w.move(p, always, { fx: 1.3, top: 130, bottom: 300 });
  await c.say('Security updates'); await zoomOn(c, p, [always, p.locator('label').filter({ hasText: 'Resource monitor (btop)' }).last()], 12);
  await w.move(p, p.locator('label').filter({ hasText: 'Automatic security updates' }).last(), { fx: 0.4 }); await sleep(500);
  await w.move(p, p.locator('label').filter({ hasText: 'SSH brute-force protection (fail2ban)' }).last(), { fx: 0.4 }); await sleep(400);
  await w.move(p, p.locator('label').filter({ hasText: 'Resource monitor (btop)' }).last(), { fx: 0.4 });
  await c.say('Save selection'); c.unzoom(); await w.click(p, p.getByRole('button', { name: 'Save selection' }), { after: 400 });
  await w.toast(p, /saved/i).catch(() => {});
  const search = p.getByPlaceholder(/Search snippets/);
  await c.say('Curious what actually runs'); await c.during(0.3); await w.type(p, search, 'Docker', { cps: 10 }); await sleep(600);
  const opt = p.locator('button').filter({ hasText: /^Docker$|Install Docker/ }).first();
  await c.say('Here\'s Docker'); await w.click(p, opt, { after: 800 });
  const code = p.locator('pre').filter({ hasText: /cloud-config|docker/ }).first(); await code.waitFor({ timeout: 10000 });
  await w.reveal(p, code, { bottom: 140 }); await zoomOn(c, p, code, 10); await w.move(p, code, { fx: 0.35, fy: 0.4 });
  await c.quiet(0.8); c.unzoom();
  return c.end(1.0);
};

CH.V07 = async (c) => {
  const w = await web(); const p = await adminPage();
  await c.begin(); await sleep(400);
  await c.say('Quick stop'); await c.during(0.3); await x.click(DOCK.terminal.x, DOCK.terminal.y); await sleep(200); await park(1000, 600);
  const tw = await x.waitWindow((q) => /terminal/i.test(q.cls), 20000); await sleep(1300);
  await c.say('Save your SSH key once');
  await x.type('cat ~/.ssh/id_ed25519.pub', { cps: 13 }); await sleep(250); await x.key('Return'); await sleep(700);
  await c.say('Here\'s my public key');
  // The key is the line under the command: triple-click selects it, Ctrl+Shift+C copies it.
  const r = x.visibleRect(tw.id); const cell = (() => { const out = spawnSync('xprop', ['-id', String(parseInt(tw.id, 16)), 'WM_NORMAL_HINTS'], { env: { ...process.env, DISPLAY: x.DISPLAY }, encoding: 'utf8' }).stdout; const m = out.match(/resize increment: (\d+) by (\d+)/); return m ? { cw: +m[1], ch: +m[2] } : { cw: 10, ch: 22 }; })();
  const lineY = r.y + (S.termTop || 45) + cell.ch * 1.5;
  await x.moveTo(r.x + 160, lineY); await sleep(250); await x.click(undefined, undefined); x.xdo(['click', '--repeat', '2', '--delay', '80', '1']); await sleep(500);
  await x.key('ctrl+shift+c'); await sleep(400);
  const clip = spawnSync('runuser', ['-u', 'alex', '--', 'env', `DISPLAY=${x.DISPLAY}`, 'xclip', '-o', '-selection', 'clipboard'], { encoding: 'utf8', timeout: 3000 }).stdout.trim();
  if (clip !== KEY) { log(`  (selection was not the key: "${clip.slice(0, 40)}", putting it on the clipboard)`); await x.clipboard(KEY); }
  await c.say('Security, SSH keys'); await c.during(0.02);
  await x.click(DOCK.chromium.x, DOCK.chromium.y); await sleep(700);
  await w.click(p, p.getByRole('button', { name: /Alex/ }).last(), { after: 600 });
  await w.click(p, menuItem(p, /Security/), { top: 0, bottom: 0 }); await p.waitForURL('**/security'); await sleep(800);
  const name = p.getByPlaceholder(/laptop|Key name/i).first();
  await w.reveal(p, p.getByText('SSH keys', { exact: true }).first(), { top: 140 });
  await w.type(p, (await name.count()) ? name : p.getByLabel('Key name'), 'laptop', { cps: 10 });
  await w.click(p, p.locator('textarea').first(), { after: 300 }); await x.key('ctrl+v'); await sleep(500);
  await w.click(p, p.getByRole('button', { name: 'Save key' }), { after: 500 });
  await w.toast(p, /saved|added/i).catch(() => {});
  await c.say('From now on'); await zoomOn(c, p, p.getByText('SSH keys', { exact: true }).first().locator('xpath=ancestor::*[@data-slot="card"][1]'), 10);
  await w.move(p, p.getByText('laptop', { exact: true }).first(), { fx: 3 });
  await c.quiet(0.6); c.unzoom();
  return c.end(1.0);
};

CH.V08 = async (c) => {
  const w = await web(); const p = await adminPage();
  await c.begin(); await sleep(400);
  await c.say('Now the fun part'); await w.click(p, sidebar(p, 'Template Store')); await p.waitForURL('**/templates'); await sleep(700);
  await c.during(0.75); await w.click(p, cardOf(p, 'Ubuntu 24.04').getByRole('button', { name: 'Deploy' }), { bottom: 140 }); await p.waitForURL('**/vms/new**'); await sleep(1200);
  await c.say('The template is already picked'); await w.move(p, p.locator('[data-slot=select-trigger]').first(), { fx: 0.3 });
  await c.during(0.6); await w.type(p, p.locator('#name'), WEB.name, { cps: 9 });
  await c.say('Pick a size'); await c.during(0.3); await w.click(p, p.getByRole('button', { name: /^Small/ }).first());
  const chip = p.getByRole('button', { name: 'laptop', exact: true }).first();
  await c.say('Under Use a saved key'); await w.move(p, p.getByText('Use a saved key:').first(), { fx: 1.0, bottom: 300 });
  await c.during(0.6); await w.click(p, chip); await zoomOn(c, p, [p.getByText('Use a saved key:'), p.locator('textarea#sshkey')], 10);
  await c.say('The username fills itself in'); c.unzoom(); await w.move(p, p.getByText('The login user to create.').first(), { fx: 0.3, fy: -1.3 });
  await c.say('I\'ll set a password'); await c.during(0.3); await w.type(p, p.locator('#cipassword'), WEB.pw, { cps: 14 });
  await c.say('Nice detail');
  await c.say('Then the extras'); await c.during(0.3);
  await w.click(p, p.locator('label').filter({ hasText: 'Install Docker' }).first(), { fx: 0.05 });
  await c.during(0.75); await w.click(p, p.locator('label').filter({ hasText: 'Install Tailscale' }).first(), { fx: 0.05 });
  await c.say('And the always-on list'); await c.during(0.2); await w.move(p, p.getByText(/Also installed on every VM/).first(), { fx: 0.5 }); await zoomOn(c, p, p.getByText(/Also installed on every VM/).first(), 10);
  await c.say('As an admin'); c.unzoom(); await w.move(p, p.getByText('Admin options').first(), { fx: 2.5 });
  await c.say('Deploy!'); await w.click(p, p.getByRole('button', { name: 'Deploy' }).last());
  await p.waitForURL(/\/vms\/(?!new$)[a-z0-9]+$/, { timeout: 60000 }); S.webId = await vmIdFromUrl(p); S.webPw = WEB.pw; save(); await sleep(800);
  await c.say('ProxMate copies the template'); await park(1500, 800); await c.quiet(0.3);
  c.ffStart('clone', 6);
  await until(async () => (await api(`/vms/${S.webId}`)).deployState === 'deploying', 25 * 60000, 4000, 'the clone and first boot');
  await until(async () => (await p.getByText(/Finishing setup on this VM/).count()) > 0, 30000, 500, 'the banner');
  await sleep(1500); c.ffEnd();
  return c.end(0.8);
};

CH.V09 = async (c) => {
  const w = await web(); const p = await adminPage(); await vmPage(p, S.webId);
  const banner = p.getByText(/Finishing setup on this VM/).first();
  await c.begin(); await sleep(400);
  await c.say('Here\'s web-01'); await zoomOn(c, p, banner.locator('xpath=ancestor::*[contains(@class,"border")][1]'), 8); await w.move(p, banner, { fx: 0.9 });
  await c.say('Cloud-init is installing');
  await c.say('Power and delete are locked'); c.unzoom(); await c.during(0.4); await w.move(p, p.getByRole('button', { name: /Actions/ }).first());
  await c.say('The text console already works'); await c.during(0.3); await w.click(p, p.getByRole('button', { name: /Console/ }).first(), { after: 600 });
  await w.click(p, menuItem(p, /^Text/), { top: 0, bottom: 0 }); await p.waitForURL('**/console**'); await sleep(2500);
  await c.say('That\'s cloud-init doing its thing'); await park(1600, 1000); await c.quiet(0.3);
  c.ffStart('cloud-init', 7);
  await until(async () => (await api(`/vms/${S.webId}`)).deployState === 'ready', 20 * 60000, 4000, 'cloud-init to finish');
  await sleep(1500); c.ffEnd();
  await w.click(p, p.getByRole('button', { name: 'Back to VM' }).or(p.getByRole('link', { name: 'Back to VM' })).first(), { top: 0 }); await p.waitForURL(/\/vms\/[a-z0-9]+$/); await sleep(1500);
  await until(async () => !!(await api(`/vms/${S.webId}`)).ipAddress, 120000, 2000, 'the IP address');
  const ip = p.getByText('Connection details').first();
  await c.say('Setup\'s done', { gap: 0.6 }); await zoomOn(c, p, ip.locator('xpath=ancestor::*[@data-slot="card"][1]'), 10); await w.move(p, p.getByText('IP address').first(), { fx: 3 });
  await c.quiet(0.6); c.unzoom();
  return c.end(1.0);
};

CH.V10 = async (c) => {
  const w = await web(); const p = await adminPage();
  await c.begin(); await sleep(400);
  await c.say('Templates aren\'t the only way'); await w.click(p, sidebar(p, 'Virtual Machines')); await p.waitForURL('**/vms'); await sleep(700);
  await c.say('New VM, and pick Custom VM'); await w.click(p, p.getByRole('link', { name: /New VM/ }).or(p.getByRole('button', { name: /New VM/ })).first()); await p.waitForURL('**/vms/new**'); await sleep(1000);
  await w.click(p, p.locator('[data-slot=select-trigger]').first(), { after: 600 });
  await w.click(p, p.locator('[data-slot=select-item]').filter({ hasText: 'Custom VM (install from ISO)' }).first(), { top: 0, bottom: 0, after: 500 });
  await c.say('Name it, and pick an installer'); await w.type(p, p.locator('#name'), 'debian-iso', { cps: 10 });
  await w.click(p, p.getByRole('button', { name: /^Small/ }).first());
  const isoSel = p.getByText('Installation ISO').locator('xpath=following::*[@data-slot="select-trigger"][1]');
  await w.click(p, isoSel, { after: 600 }); await w.click(p, p.locator('[data-slot=select-item]').filter({ hasText: 'debian-13.7.0-amd64-netinst.iso' }).first(), { top: 0, bottom: 0, after: 400 });
  await c.say('Create VM, and it boots'); await c.during(0.2); await w.click(p, p.getByRole('button', { name: 'Create VM' }));
  await p.waitForURL(/\/vms\/(?!new$)[a-z0-9]+$/, { timeout: 60000 }); S.isoId = await vmIdFromUrl(p); save();
  await until(async () => (await api(`/vms/${S.isoId}`)).status === 'running', 120000, 1500, 'the ISO VM to start'); await sleep(1500);
  await w.click(p, p.getByRole('button', { name: /Console/ }).first(), { after: 600 });
  await w.click(p, menuItem(p, /^Graphical/), { top: 0, bottom: 0 }); await p.waitForURL('**/console**'); await sleep(4500);
  await c.say('There it is, in the graphical console'); await w.move(p, p.locator('canvas').first(), { fx: 0.45, fy: 0.3, top: 0, bottom: 0 }); await x.click(); await sleep(300); await x.key('Down'); await sleep(400); await x.key('Up');
  await c.say('One heads-up'); await c.during(0.3); await w.click(p, p.getByRole('tab', { name: 'Text', exact: true }).first(), { top: 0, after: 1500 });
  await zoomOn(c, p, p.getByText(/has no text console/).first(), 30);
  await c.say('ProxMate says so'); await c.during(0.5); c.unzoom(); await w.click(p, p.getByRole('button', { name: /Switch to graphical console/ }).first(), { top: 0, bottom: 0, after: 1200 });
  await c.say('For something lighter'); await w.click(p, sidebar(p, 'Virtual Machines')); await p.waitForURL('**/vms'); await sleep(600);
  await w.click(p, p.getByRole('link', { name: /New VM/ }).or(p.getByRole('button', { name: /New VM/ })).first()); await p.waitForURL('**/vms/new**'); await sleep(1000);
  await w.click(p, p.locator('[data-slot=select-trigger]').first(), { after: 600 });
  await w.click(p, p.locator('[data-slot=select-item]').filter({ hasText: 'Container (LXC)' }).first(), { top: 0, bottom: 0, after: 600 });
  await c.say('Containers share the host');
  await w.type(p, p.locator('#name'), 'debian-ct', { cps: 10 });
  await w.click(p, p.getByRole('button', { name: /^Small/ }).first());
  await c.say('Pick a container template');
  const ctSel = p.getByText('Container template').locator('xpath=following::*[@data-slot="select-trigger"][1]');
  await w.click(p, ctSel, { after: 600 }); await w.click(p, p.locator('[data-slot=select-item]').filter({ hasText: 'debian-12-standard' }).first(), { top: 0, bottom: 0, after: 400 });
  await w.type(p, p.locator('#ct-password'), env('PMV_CT_PASSWORD'), { cps: 14 });
  await w.click(p, p.getByRole('button', { name: 'Create container' }));
  await p.waitForURL(/\/vms\/(?!new$)[a-z0-9]+$/, { timeout: 60000 }); S.ctId = await vmIdFromUrl(p); save(); await c.quiet(0.3);
  c.ffStart('container create', 5);
  await until(async () => (await api(`/vms/${S.ctId}`)).status === 'running', 10 * 60000, 2000, 'the container');
  await w.click(p, sidebar(p, 'Virtual Machines')); await p.waitForURL('**/vms'); await sleep(1500); c.ffEnd();
  const lxc = p.getByText('LXC', { exact: true }).first();
  await c.say('And there it is in the list', { gap: 0.5 }); await w.move(p, lxc); await zoomOn(c, p, p.getByText('debian-ct').first().locator('xpath=ancestor::tr[1]').or(lxc), 12);
  await c.say('Small print'); await c.quiet(0.4); c.unzoom();
  return c.end(1.0);
};

CH.V11 = async (c) => {
  const w = await web(); const p = await adminPage();
  if (!/\/vms$/.test(p.url())) { await p.goto(APP + '/vms'); await sleep(1500); }
  await c.begin(); await sleep(400);
  await c.say('Back to web-01'); await w.click(p, p.getByRole('link', { name: WEB.name, exact: true }).first()); await p.waitForURL(/\/vms\/[a-z0-9]+$/); await sleep(1200);
  await c.say('Up top'); await zoomOn(c, p, [p.getByRole('heading', { name: WEB.name }), p.getByText('Ubuntu 24.04').first()], 14);
  await w.move(p, p.getByText('Running', { exact: true }).first()); await sleep(500); await w.move(p, p.getByText('pve1').first()); await sleep(400); await w.move(p, p.getByText('Ubuntu 24.04').first());
  await c.say('Connection details'); c.unzoom(); await w.move(p, p.getByText('IP address').first(), { fx: 3.2 });
  const copy = p.getByRole('button', { name: /Copy/i }).first(); if (await copy.count()) { await c.during(0.6); await w.click(p, copy); }
  await c.say('Live status and Configuration'); await w.move(p, p.getByText('Live status').first(), { fx: 2 }); await c.during(0.5); await w.move(p, p.getByText('Configuration', { exact: true }).first(), { fx: 2 });
  await c.say('Notes, projects and tags'); await w.move(p, p.getByText('Notes', { exact: true }).first(), { fx: 2, bottom: 200 }); await c.during(0.4); await w.move(p, p.getByText('Tags', { exact: true }).first(), { fx: 2, bottom: 200 });
  await c.say('And Optimization tips'); await c.during(0.35); await w.move(p, p.getByText('Optimization tips').first(), { fx: 1.5, bottom: 150 }); await zoomOn(c, p, p.getByText('Optimization tips').first().locator('xpath=ancestor::*[@data-slot="card"][1]'), 10);
  await c.during(0.45); await w.move(p, p.getByText(/Reach it from outside ProxMate/).first(), { fx: 0.4 });
  await c.quiet(0.6); c.unzoom(); await sleep(400);
  await x.scroll(-10, { delay: 40 }); await sleep(500);
  return c.end(1.0);
};

CH.V12 = async (c) => {
  const w = await web(); const p = await adminPage(); await vmPage(p, S.webId);
  await c.begin(); await sleep(400);
  await c.say('Now, getting in'); await c.during(0.5); await w.click(p, p.getByRole('button', { name: /Console/ }).first(), { after: 700 });
  await c.say('Graphical, Text, and Pop out'); await w.move(p, menuItem(p, /^Graphical/), { top: 0, bottom: 0 }); await c.during(0.35); await w.move(p, menuItem(p, /^Text/), { top: 0, bottom: 0 }); await c.during(0.7); await w.move(p, menuItem(p, /^Pop out/), { top: 0, bottom: 0 });
  await c.say('Graphical first'); await c.during(0.1); await w.click(p, menuItem(p, /^Graphical/), { top: 0, bottom: 0 }); await p.waitForURL('**/console**'); await sleep(4000);
  const canvas = p.locator('canvas').first();
  await c.say('Type the username'); await w.click(p, canvas, { fx: 0.5, fy: 0.5, top: 0, bottom: 0 }); await sleep(300); await x.key('Return'); await sleep(700);
  await x.type(WEB.user, { cps: 9 }); await x.key('Return'); await sleep(900);
  await c.during(0.7); await w.click(p, p.getByRole('button', { name: 'Paste' }).first(), { top: 0, after: 600 });
  const ta = p.locator('textarea').first(); await ta.waitFor();
  await c.say('Put the text in'); await w.type(p, ta, WEB.pw, { cps: 14, clear: true });
  await c.during(0.35); await w.click(p, p.getByRole('button', { name: /Send to VM/ }).first(), { top: 0, bottom: 0, after: 700 });
  await w.click(p, canvas, { fx: 0.5, fy: 0.75, top: 0, bottom: 0 }); await x.key('Return'); await sleep(2500);
  await c.say('We\'re in'); await zoomOn(c, p, canvas, 0);
  await c.say('Ctrl+Alt+Del and Reconnect'); c.unzoom(); await w.move(p, p.getByRole('button', { name: /Ctrl\+Alt\+Del/ }).first(), { top: 0 }); await c.during(0.5); await w.move(p, p.getByRole('button', { name: 'Reconnect' }).first(), { top: 0 });
  await c.say('And this Actions menu'); await c.during(0.15); await w.click(p, p.getByRole('button', { name: /Actions/ }).first(), { top: 0, after: 600 });
  await w.move(p, menuItem(p, /Pause/), { top: 0, bottom: 0 }); await c.during(0.7); await w.move(p, menuItem(p, /Force stop/), { top: 0, bottom: 0 });
  await c.quiet(0.4); await x.key('Escape'); await sleep(300);
  return c.end(1.0);
};

CH.V13 = async (c) => {
  const w = await web(); const p = await adminPage();
  if (!p.url().includes(`/vms/${S.webId}/console`)) { await p.goto(`${APP}/vms/${S.webId}/console`); await sleep(3000); }
  await c.begin(); await sleep(400);
  await c.say('Flip the toggle to Text'); await c.during(0.4); await w.click(p, p.getByRole('tab', { name: 'Text', exact: true }).first(), { top: 0, after: 2000 });
  await focusTerm(p);
  await c.say('It\'s a real terminal'); await termLogin(p, WEB.user, WEB.pw); await x.key('ctrl+l'); await sleep(300);
  await c.say('Let\'s try Docker'); await c.during(0.5); await x.type('docker run hello-world', { cps: 13 }); await x.key('Return');
  await waitTerm(p, /Hello from Docker!/, 120000);
  await c.say('No sudo needed'); { const r = await termText(p, /Hello from Docker!/); if (r) c.zoom([r.x - 40, r.y - 120, 900, 300]); }
  await c.say('Select some text'); c.unzoom();
  // Chromium's own right-click menu (Cut, Copy, Paste...) opens at the pointer: Copy sits 62 px below it, Paste 95 px.
  const hello = await termText(p, /Hello from Docker!/);
  if (hello) {
    await x.drag(hello.x + 1, hello.cy, hello.x + hello.w - 1, hello.cy); await sleep(300);
    const at = x.pointer(); await x.click(undefined, undefined, { button: 3 }); await sleep(800);
    await x.moveTo(at.x + 65, at.y + 62, { speed: 0.7 }); await sleep(200); await x.click(); await sleep(500);
    const prompt = await termText(p, /ubuntu@web-01:~\$\s*$/) || (await termText(p, /ubuntu@web-01:~\$/));
    await c.during(0.55);
    if (prompt) { await x.moveTo(prompt.x + prompt.w + 60, prompt.cy, { speed: 0.8 }); const at2 = x.pointer(); await x.click(undefined, undefined, { button: 3 }); await sleep(800);
      await x.moveTo(at2.x + 65, at2.y + 95, { speed: 0.7 }); await sleep(200); await x.click(); await sleep(1200); }
    await x.key('ctrl+u'); await sleep(300);
  }
  await c.say('And links are clickable'); await c.during(0.2); await x.type('sudo tailscale up', { cps: 12 }); await x.key('Return');
  await waitTerm(p, /login\.tailscale\.com\/a\//, 60000); await sleep(500);
  const link = await termText(p, /https:\/\/login\.tailscale\.com\/a\/\S+/);
  await c.say('Ctrl-click'); await c.during(0.1); await ctrlClick(link.cx, link.cy);
  const ts = await (await web()).page((u) => u.includes('tailscale.com'), 20000);
  // Chromium opens it as a second tab, in the background: click that tab like a person would (maximized window,
  // first tab spans x 108-338 at y 52, so the second one is centred at x 461).
  await sleep(900); await x.moveTo(461, 52, { speed: 0.8 }); await sleep(200); await x.click();
  await ts.waitForLoadState('load').catch(() => {}); await sleep(1500);
  await c.say('I won\'t join my tailnet'); await c.during(0.35); await x.key('ctrl+w'); await sleep(800);
  if (p.isClosed() || !ts.isClosed()) throw new Error('closed the wrong tab');
  await focusTerm(p); await x.key('ctrl+c'); await sleep(500); await x.key('ctrl+l');
  await c.say('Before we move on'); await c.during(0.2); await x.type('echo "remember the milk" > notes.txt && ls', { cps: 15 }); await x.key('Return');
  await c.quiet(0.6);
  return c.end(1.0);
};

// Move a window by its title bar (server-side decorations sit just above the client area), slowly enough for Mutter.
async function dragWindow(id, ex, ey) {
  const r = x.visibleRect(id); const sx = r.x + r.w / 2, sy = r.y - 18;
  await x.moveTo(sx, sy); await sleep(300); x.xdo(['mousedown', '1']); await sleep(250);
  for (let i = 1; i <= 25; i++) { x.xdo(['mousemove', String(Math.round(sx + (ex - sx) * i / 25)), String(Math.round(sy + (ey - sy) * i / 25))]); await sleep(30); }
  await sleep(250); x.xdo(['mouseup', '1']); await sleep(500);
}

CH.V14 = async (c) => {
  const w = await web(); const p = await adminPage();
  for (const q of w.pages()) if (q.url().includes('/console-popout/')) await q.close().catch(() => {});
  if (!p.url().includes(`/vms/${S.webId}/console`)) { await p.goto(`${APP}/vms/${S.webId}/console?mode=text`); await sleep(3000); }
  await c.begin(); await sleep(400);
  // One text session at a time: leave this console page, then pop the console out from the VM page's menu.
  await c.say('Want a terminal'); await c.during(0.2);
  await w.click(p, p.getByRole('button', { name: 'Back to VM' }).or(p.getByRole('link', { name: 'Back to VM' })).first(), { top: 0 }); await p.waitForURL(/\/vms\/[a-z0-9]+$/); await sleep(900);
  await w.click(p, p.getByRole('button', { name: /Console/ }).first(), { after: 600 });
  await w.click(p, menuItem(p, /^Pop out/), { top: 0, bottom: 0 });
  const pop = await w.page((u) => u.includes('/console-popout/'), 20000); pop.on('dialog', noop); await sleep(2500);
  const popWin = await x.waitWindow((q) => /chromium/i.test(q.cls) && !x.isMaximized(q.id), 10000);
  await c.say('The console gets its own window');
  { const r = x.visibleRect(popWin.id); await dragWindow(popWin.id, 1920 - r.w / 2 - 24, 1080 - r.h - 24 - 18); }
  await c.say('I\'ll use it to give this VM some work'); await c.during(0.3);
  { const box = await pop.locator('.xterm-screen').boundingBox(); const m = await w.metrics(pop);
    await x.click(m.dx + (box.x + box.width / 2) * m.z, m.dy + (box.y + box.height * 0.8) * m.z); await sleep(300); }
  await termLogin(pop, WEB.user, WEB.pw);
  await x.type('timeout 90 yes > /dev/null', { cps: 13 }); await x.key('Return'); S.loadAt = Date.now(); save();
  await c.say('And if you reach ProxMate over HTTPS');
  await c.quiet(0.5);
  return c.end(0.8);
};

CH.V15 = async (c) => {
  const w = await web(); const p = await adminPage();
  await c.begin(); await sleep(300);
  // The main window comes back to the front with a click on an empty part of it (left of the pop-out).
  await c.say('Back on the VM page'); await c.during(0.1); await x.click(180, 900); await sleep(500);
  await w.click(p, p.getByRole('tab', { name: 'Insights' }).first(), { after: 1500 });
  await c.say('There\'s that busy CPU'); await zoomOn(c, p, p.getByText('Live activity').first().locator('xpath=ancestor::*[@data-slot="card"][1]'), 10); await sleep(1500);
  await c.say('Day and Week'); c.unzoom(); await w.click(p, p.getByRole('tab', { name: 'Day', exact: true }).first(), { after: 1200 });
  await c.during(0.6); await w.click(p, p.getByRole('tab', { name: 'Week', exact: true }).first(), { after: 900 });
  await c.say('And Activity'); await c.during(0.2); await w.click(p, p.getByRole('tab', { name: 'Activity' }).first(), { after: 1200 });
  await w.move(p, p.getByText(/Console opened/).first(), { fx: 0.3 });
  await c.quiet(0.6);
  return c.end(1.0);
};

CH.V16 = async (c) => {
  const w = await web(); const p = await adminPage();
  // Before rolling: the pop-out window closed, the VM page on Overview.
  for (const q of (await web()).pages()) if (q.url().includes('/console-popout/')) await q.close().catch(() => {});
  await p.goto(`${APP}/vms/${S.webId}?tab=activity`); await sleep(1800);
  const actions = () => p.getByRole('button', { name: /^Actions/ }).first();
  await c.begin(); await sleep(400);
  await c.say('The Actions menu has everything else'); await c.during(0.3); await w.click(p, actions(), { after: 700 });
  await c.say('Start, Stop and Restart'); await w.move(p, menuItem(p, /^Start/), { top: 0, bottom: 0 }); await c.during(0.3); await w.move(p, menuItem(p, /^Stop/), { top: 0, bottom: 0 }); await c.during(0.55); await w.move(p, menuItem(p, /^Restart/), { top: 0, bottom: 0 });
  await c.say('Rename does what it says'); await w.move(p, menuItem(p, /^Rename/), { top: 0, bottom: 0 });
  await c.say('Resize changes CPU'); await c.during(0.2); await w.click(p, menuItem(p, /^Resize/), { top: 0, bottom: 0, after: 800 });
  const dlg = p.getByRole('alertdialog').first(); await dlg.waitFor();
  await w.click(p, dlg.getByRole('button', { name: /^Medium/ }).first(), { top: 0, bottom: 0 });
  await c.say('And here\'s the nice part'); await c.during(0.2); await w.click(p, dlg.getByRole('button', { name: 'Apply' }), { top: 0, bottom: 0 });
  const toast = await w.toast(p, /snapshot|resiz/i, 60000).catch(() => ''); log('  toast:', toast);
  await zoomOn(c, p, p.locator('[data-sonner-toast]').first(), 10); await sleep(1500); c.unzoom();
  await c.say('Duplicate makes a full copy'); await c.during(0.35); await w.click(p, actions(), { after: 600 }); await w.click(p, menuItem(p, /^Stop/), { top: 0, bottom: 0, after: 600 });
  { const cd = p.getByRole('alertdialog'); if (await cd.count()) await w.click(p, cd.getByRole('button', { name: /^Stop/ }).last(), { top: 0, bottom: 0 }); }
  await until(async () => (await api(`/vms/${S.webId}`)).status === 'stopped', 180000, 1500, 'web-01 to stop'); await sleep(1500);
  await w.click(p, actions(), { after: 600 }); await w.click(p, menuItem(p, /^Duplicate/), { top: 0, bottom: 0, after: 700 });
  const dd = p.getByRole('alertdialog').first(); await dd.waitFor();
  await w.type(p, dd.locator('#dupName'), 'web-golden', { cps: 10, clear: true });
  await w.click(p, dd.getByRole('button', { name: 'Duplicate' }), { top: 0, bottom: 0 }); await c.quiet(0.3); await park(1500, 900);
  c.ffStart('duplicate', 6);
  await p.waitForURL((u) => /\/vms\/[a-z0-9]+$/.test(u.pathname) && !u.pathname.endsWith(S.webId), { timeout: 20 * 60000 });
  S.goldId = await vmIdFromUrl(p); save(); await sleep(2000); c.ffEnd();
  await c.say('Migrate moves a VM', { gap: 0.5 }); await w.click(p, actions(), { after: 600 }); await w.move(p, menuItem(p, /^Migrate/), { top: 0, bottom: 0 });
  await c.say('Now, Save as template'); await c.during(0.35); await w.click(p, menuItem(p, /^Save as template/), { top: 0, bottom: 0, after: 700 });
  const cv = p.getByRole('alertdialog').first(); await cv.waitFor();
  await c.say('In real life'); await zoomOn(c, p, cv, 10); await w.move(p, cv.getByText(/Best on a minimal, configured build/).first(), { top: 0, bottom: 0 });
  await c.during(0.45); await w.type(p, cv.locator('#tplName'), TPL, { cps: 13 });
  await c.say('Convert, and it\'s in the Template Store'); c.unzoom(); await c.during(0.05); await w.click(p, cv.getByRole('button', { name: 'Convert' }), { top: 0, bottom: 0 });
  await p.waitForURL('**/templates', { timeout: 180000 }); await sleep(1200);
  const gcard = cardOf(p, TPL); await gcard.waitFor({ timeout: 30000 }); await w.move(p, gcard, { fx: 0.3, fy: 0.3, bottom: 120 });
  await c.say('I don\'t need this one'); await c.during(0.25);
  const pending = dialogOpened(p); await w.click(p, gcard.locator('button[title^="Delete template"]'), { bottom: 120 }); await clickOk(pending);
  await until(async () => (await cardOf(p, TPL).count()) === 0, 120000, 500, 'the template to go');
  await c.say('Back on web-01, Rebuild'); await c.during(0.1); await p.goto(`${APP}/vms/${S.webId}`); await sleep(1500);
  await w.click(p, actions(), { after: 600 }); await w.click(p, menuItem(p, /^Rebuild/), { top: 0, bottom: 0, after: 800 });
  const rb = p.getByRole('alertdialog').first(); await rb.waitFor(); await sleep(800);
  await c.during(0.8); await w.click(p, rb.getByRole('button', { name: 'Cancel' }), { top: 0, bottom: 0 });
  await c.say('And Start it again'); await w.click(p, actions(), { after: 600 }); await w.click(p, menuItem(p, /^Start/), { top: 0, bottom: 0 });
  await until(async () => (await api(`/vms/${S.webId}`)).status === 'running', 120000, 1500, 'web-01 to start');
  await c.quiet(0.8);
  return c.end(1.0);
};

CH.V17 = async (c) => {
  const w = await web(); const p = await adminPage();
  await until(async () => !!(await api(`/vms/${S.webId}`)).ipAddress, 180000, 2000, 'web-01 to boot');
  // Off camera: a logged-in shell on the serial console, with notes.txt in place.
  await p.goto(`${APP}/vms/${S.webId}/console?mode=text`); await sleep(3000); await focusTerm(p);
  await until(async () => /login:\s*$|\$\s*$/m.test((await termAll(p)).trimEnd()) || (await x.key('Return'), false), 180000, 3000, 'a shell prompt');
  await termLogin(p, WEB.user, WEB.pw); await x.type('ls notes.txt', { cps: 30 }); await x.key('Return'); await sleep(900);
  if (/No such file/.test(await termAll(p))) { await x.type('echo "remember the milk" > notes.txt', { cps: 30 }); await x.key('Return'); await sleep(600); }
  await x.key('ctrl+l'); await sleep(300);
  await p.goto(`${APP}/vms/${S.webId}`); await sleep(1800); await park(1500, 900);
  await c.begin(); await sleep(400);
  await c.say('Backups and Snapshots'); await w.click(p, p.getByRole('tab', { name: /Backups/ }).first(), { after: 1200 });
  const snaps = p.getByText('Snapshots', { exact: true }).first();
  await c.say('Snapshots are quick save points'); await w.move(p, p.getByText('Automatic', { exact: true }).first(), { bottom: 160 }); await zoomOn(c, p, p.getByText(/pm-auto-resize/).first().locator('xpath=ancestor::*[@data-slot="card"][1]'), 10);
  await c.say('Let\'s take our own'); c.unzoom(); await w.click(p, p.getByRole('button', { name: 'Take snapshot' }).first(), { after: 600 });
  await w.type(p, p.getByPlaceholder('e.g. before-kernel-upgrade'), 'before-oops', { cps: 10 });
  await w.click(p, p.getByRole('button', { name: 'Create snapshot' }), { after: 400 });
  await p.getByText('before-oops', { exact: true }).first().waitFor({ timeout: 60000 }); await sleep(600);
  await c.say('Now, the oops'); await c.during(0.2); await p.goto(`${APP}/vms/${S.webId}/console?mode=text`); await sleep(3000);
  await focusTerm(p); await termLogin(p, WEB.user, WEB.pw); await x.key('ctrl+l'); await sleep(300);
  await x.type('rm notes.txt && ls -l', { cps: 13 }); await x.key('Return'); await sleep(900);
  await c.say('Gone. Back to Snapshots'); await c.during(0.25); await p.goto(`${APP}/vms/${S.webId}?tab=backups`); await sleep(1800);
  const row = p.getByText('before-oops', { exact: true }).first().locator('xpath=ancestor::*[.//button[normalize-space()="Roll back"]][1]');
  await w.click(p, row.getByRole('button', { name: 'Roll back' }).first(), { after: 700 });
  const ad = p.getByRole('alertdialog').first(); await ad.waitFor(); await sleep(400);
  await w.click(p, ad.getByRole('button', { name: 'Roll back' }), { top: 0, bottom: 0 });
  // In v1.3.4 this dialog stays open after the rollback (its Roll back button doesn't close it): wait for the
  // toast that confirms it, then dismiss the dialog with Esc.
  { const toast = p.getByText(/Rolled web-01 back/).first(); const t0 = Date.now(); let ff = false;
    while (!(await toast.isVisible().catch(() => false))) {
      if (!ff && Date.now() - t0 > 6000 && c.now() > c.speechEnd + 0.3) { c.ffStart('rollback', 3); ff = true; }
      if (Date.now() - t0 > 240000) throw new Error('timed out waiting for the rollback toast');
      await sleep(300);
    }
    if (ff) c.ffEnd(); }
  await sleep(1000); await x.key('Escape'); await ad.waitFor({ state: 'hidden', timeout: 10000 });
  await until(async () => (await api(`/vms/${S.webId}`)).status === 'stopped', 180000, 1500, 'the rollback');
  await c.say('A rollback puts the disk back'); await c.during(0.7); await w.click(p, p.getByRole('button', { name: /^Actions/ }).first(), { after: 600 }); await w.click(p, menuItem(p, /^Start/), { top: 0, bottom: 0 });
  await c.quiet(0.3); c.ffStart('boot', 4);
  await until(async () => { const v = await api(`/vms/${S.webId}`); return v.status === 'running' && v.ipAddress; }, 300000, 2000, 'the boot');
  await p.goto(`${APP}/vms/${S.webId}/console?mode=text`); await sleep(3000); await focusTerm(p);
  await until(async () => /login:/.test(await termAll(p)) || (await x.key('Return'), false), 120000, 3000, 'a login prompt');
  c.ffEnd();
  await c.say('Log back in', { gap: 0.4 }); await termLogin(p, WEB.user, WEB.pw); await x.key('ctrl+l'); await sleep(300);
  await x.type('cat notes.txt', { cps: 12 }); await x.key('Return'); await sleep(700);
  { const r = await termText(p, /remember the milk/); if (r) c.zoom([r.x - 60, r.y - 60, 700, 200]); }
  await c.say('Snapshots live on'); c.unzoom(); await c.during(0.4); await p.goto(`${APP}/vms/${S.webId}?tab=backups`); await sleep(1800);
  await w.move(p, p.getByText('MateStates · backups').first(), { fx: 1.5 });
  await c.say('New MateState saves'); await c.during(0.35); await w.click(p, p.getByRole('button', { name: 'New MateState' }).first());
  await c.quiet(0.3); c.ffStart('MateState backup', 6);
  await until(async () => ((await api(`/vms/${S.webId}/matestates`)).items || []).some((m) => m.status === 'ready'), 25 * 60000, 5000, 'the MateState');
  await sleep(2500); c.ffEnd();
  await c.say('Done. Restore brings it back', { gap: 0.5 }); await w.move(p, p.getByRole('button', { name: 'Restore' }).first()); await c.during(0.55); await w.move(p, p.getByText('Backup policy', { exact: true }).first(), { fx: 2 });
  await c.quiet(0.6);
  return c.end(1.0);
};

CH.V18 = async (c) => {
  const w = await web(); const p = await adminPage(); await p.goto(`${APP}/vms/${S.webId}?tab=settings`); await sleep(1800);
  // card titles only: the sidebar has an 'Admin' section label too
  const card = (t) => p.locator('[data-slot=card-title]').filter({ hasText: new RegExp(`^\\s*${t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\s*$`) }).first();
  await c.begin(); await sleep(400);
  await c.say('Last tab, Settings'); await w.move(p, p.getByRole('tab', { name: 'Settings' }).first());
  await c.say('General has the name'); await w.move(p, card('General'), { fx: 3 });
  await c.say('Power schedule starts'); await w.move(p, card('Power schedule'), { fx: 2, top: 140 });
  await c.say('Disks adds'); await w.move(p, card('Disks'), { fx: 3, top: 140 });
  await c.say('GPU and PCI passthrough'); await w.move(p, card('GPU / PCI passthrough'), { fx: 1.6, top: 140 });
  await c.say('Alerts emails you'); await w.move(p, card('Alerts'), { fx: 3, top: 140 });
  await c.say('Recovery is the one'); await w.move(p, card('Recovery'), { fx: 3, top: 140 });
  await zoomOn(c, p, card('Recovery').locator('xpath=ancestor::*[@data-slot="card"][1]'), 8);
  await c.say('Forgot your password'); await c.during(0.3); await w.click(p, p.getByRole('button', { name: 'Reset password' }).first(), { after: 700 });
  const rd = p.getByRole('alertdialog').first(); await rd.waitFor(); c.unzoom();
  const u = rd.getByPlaceholder('e.g. ubuntu, debian, root'); if (!(await u.inputValue())) await w.type(p, u, WEB.user, { cps: 10 });
  await w.click(p, rd.getByRole('button', { name: 'Reset password' }), { top: 0, bottom: 0 });
  await rd.getByRole('button', { name: 'Done' }).waitFor({ timeout: 60000 }); await sleep(500);
  const newPw = (await rd.locator('input[readonly], code').first().evaluate((e) => e.value || e.textContent).catch(() => '')).trim();
  if (newPw) { S.webPw = newPw; save(); log('  new guest password saved to state'); }
  await zoomOn(c, p, rd, 10); await sleep(1200);
  await c.say('Lost your key'); c.unzoom(); await w.click(p, rd.getByRole('button', { name: 'Done' }), { top: 0, bottom: 0, after: 500 }); await w.move(p, p.getByRole('button', { name: 'Add SSH key' }).first());
  await c.say('Need a file inside'); await w.move(p, p.getByRole('button', { name: 'Push file' }).first());
  await c.say('And if it won\'t boot'); await w.move(p, p.getByRole('button', { name: 'Boot into rescue' }).first());
  await c.say('Below that'); await w.move(p, card('Shared access'), { fx: 2, top: 140 }); await c.during(0.35); await w.move(p, card('Admin'), { fx: 3, top: 140 }); await c.during(0.65); await w.move(p, card('Danger zone'), { fx: 3, top: 140, bottom: 260 });
  await c.quiet(0.5);
  return c.end(1.0);
};

CH.V19 = async (c) => {
  const w = await web(); const p = await adminPage(); if (!p.url().includes('tab=settings')) { await p.goto(`${APP}/vms/${S.webId}?tab=settings`); await sleep(1800); }
  await w.reveal(p, p.getByText('Shared access', { exact: true }).first(), { top: 160 });
  await c.begin(); await sleep(400);
  await c.say('Let\'s share web-01'); await c.during(0.4); await w.type(p, p.getByPlaceholder('person@example.com'), MIKE.email, { cps: 12 });
  await c.say('Viewer, Operator, or Manager'); await zoomOn(c, p, p.getByText('Shared access', { exact: true }).first().locator('xpath=ancestor::*[@data-slot="card"][1]'), 8);
  await w.move(p, p.getByText('Viewer', { exact: true }).first()); await c.during(0.5); await w.move(p, p.getByText('Operator', { exact: true }).first()); await c.during(0.8);
  await c.say('Share.'); c.unzoom(); await w.click(p, p.getByRole('button', { name: 'Share' }).first(), { after: 900 });
  // Mike's side: an incognito window, signed in for real.
  await c.say('Here\'s Mike\'s side'); await c.during(0.05);
  const nWin = chromeWins().length; await x.key('ctrl+shift+n');
  await until(async () => chromeWins().length > nWin, 20000, 300, 'the incognito window'); await sleep(1500);
  await w.go(`${APP_HOST}/login`); const mpg = await w.page((u) => u.startsWith(APP + '/login'), 20000); mpg.on('dialog', noop);
  await mpg.waitForLoadState('load').catch(() => {});
  await mpg.evaluate(() => { window.name = 'pm-mike'; }); await sleep(800);
  await w.type(mpg, mpg.getByLabel(/email/i), MIKE.email, { cps: 18 }); await w.type(mpg, mpg.getByLabel(/password/i).first(), MIKE.pw, { cps: 20 }); await x.key('Return');
  await mpg.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 }); await sleep(900);
  await w.click(mpg, sidebar(mpg, 'Virtual Machines')); await mpg.waitForURL('**/vms'); await sleep(900);
  await w.click(mpg, mpg.getByRole('link', { name: WEB.name, exact: true }).or(mpg.getByText(WEB.name, { exact: true })).first()); await mpg.waitForURL(/\/vms\/[a-z0-9]+$/); await sleep(1200);
  await zoomOn(c, mpg, mpg.getByRole('button', { name: /View console/ }).first(), 30); await w.move(mpg, mpg.getByRole('button', { name: /View console/ }).first());
  await c.say('He sees the same screen'); c.unzoom(); await w.click(mpg, mpg.getByRole('button', { name: /View console/ }).first(), { after: 600 });
  await w.click(mpg, menuItem(mpg, /^Graphical/), { top: 0, bottom: 0 }); await mpg.waitForURL('**/console**'); await sleep(3500);
  await w.move(mpg, mpg.getByText('View only').first(), { top: 0 }); await zoomOn(c, mpg, mpg.getByText('View only').first(), 40);
  await w.click(mpg, mpg.locator('canvas').first(), { fx: 0.5, fy: 0.6, top: 0, bottom: 0 }); await x.type('ls', { cps: 8 }); await x.key('Return'); await sleep(400);
  await c.say('Perfect for showing a friend'); c.unzoom();
  await c.quiet(0.6);
  return c.end(1.0);
};

CH.V20 = async (c) => {
  const w = await web();
  // Before rolling: Mike's window closed, Alex's in front.
  for (const q of w.pages()) { try { if ((await q.evaluate(() => window.name)) === 'pm-mike') await q.close(); } catch {} }
  await sleep(800); const p = await adminPage(); await p.bringToFront(); await p.goto(`${APP}/vms/${S.webId}`); await sleep(1500);
  await c.begin(); await sleep(400);
  await c.say('One last thing'); await w.move(p, p.getByText(/Reach it from outside ProxMate/).first(), { bottom: 150 });
  await c.say('Not with port forwards'); await c.during(0.3); await w.click(p, sidebar(p, 'Help & Docs')); await p.waitForURL('**/help**'); await sleep(900);
  await w.move(p, p.getByText(/Cluster policy: no port forwarding/).first());
  await c.say('Tailscale, for private SSH'); await w.move(p, p.getByText(/SSH into your VM from anywhere/).first()); await zoomOn(c, p, p.getByText(/SSH into your VM from anywhere/).first(), 40);
  await c.say('And Cloudflare Tunnel'); c.unzoom(); await w.move(p, p.getByText(/Publish a public website/).first());
  await c.say('So, here\'s what we covered'); await c.during(0.4); await w.click(p, sidebar(p, 'Template Store')); await p.waitForURL('**/templates'); await sleep(900);
  await c.say('Three ways to fill'); await w.move(p, cardOf(p, 'Debian 13'), { fx: 0.4, fy: 0.3, bottom: 120 });
  await c.say('Then every tab'); await c.during(0.3); await w.click(p, sidebar(p, 'Virtual Machines')); await sleep(900);
  await c.say('The ProxMate IDE is next');
  await c.say('Tell me in the comments');
  await c.say('Happy homelabbing');
  return c.end(1.5);
};

// Cold open, recorded last: the finished result first.
CH.V01 = async (c) => {
  const w = await web(); const p = await adminPage();
  await p.goto(`${APP}/vms/${S.webId}/console?mode=text`); await sleep(3000); await focusTerm(p);
  await termLogin(p, WEB.user, S.webPw || WEB.pw); await x.key('ctrl+l'); await sleep(500); await park(1650, 1000);
  await c.begin(); await sleep(400);
  await c.say(0); await c.during(0.12); await x.type('docker run hello-world', { cps: 13 }); await x.key('Return');
  // the payoff stays on screen: Docker's greeting, zoomed in, for the whole of line 1
  await waitTerm(p, /Hello from Docker!/, 40000); await sleep(400);
  { const r = await termText(p, /Hello from Docker!/); if (r) c.zoom([r.x - 30, r.y - 40, 860, 300]); }
  await c.say(1); await c.during(0.85); c.unzoom(); await sleep(700); await p.goto(`${APP}/vms/${S.webId}`); await sleep(1200);
  await zoomOn(c, p, [p.getByRole('heading', { name: WEB.name }), p.getByText('Connection details').first()], 20);
  await c.say(2); c.unzoom(); await w.move(p, p.getByText('IP address').first(), { fx: 3 });
  await c.say(3); await w.click(p, sidebar(p, 'Template Store')); await sleep(900);
  await c.say(4); await w.move(p, cardOf(p, 'Ubuntu 24.04'), { fx: 0.5, fy: 0.3 });
  await c.say(5);
  await c.say(6);
  return c.end(1.0);
};

(async () => {
  const order = (process.env.ONLY || 'V02,V03,V04,V05,V06,V07,V08,V09,V10,V11,V12,V13,V14,V15,V16,V17,V18,V19,V20,V01').split(',');
  for (const id of order) {
    const c = new Chapter(id, MAN, `${OUT}/chapters`);
    x.onClick = (pt) => { if (c.t0 !== null && c.ff && c.ff.exitCode === null) c.mark('click', { x: pt.x, y: pt.y }); };
    try { await CH[id](c); S.done = [...new Set([...(S.done || []), id])]; save(); }
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
