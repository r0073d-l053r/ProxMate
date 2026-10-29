// Records tutorial 3 (secure your ProxMate: two-factor authentication, recovery codes, the Security page, the
// admin Settings tabs, an invite that requires a second factor, a password reset without email, an access window
// that runs out, the Audit Log) on the real Ubuntu desktop against ProxMate and the real Proxmox VE node pve1.
// Same stage as parts one and two (stage.cjs): real X11 input only, DevTools used to read where things are.
// KeePassXC (Qt, no DevTools) is driven at fixed positions: kpOpen() puts its window at KP.ox/KP.oy first.
// usage: PMV_WORK=~/pmv/work TAKE=t3a ONLY=PREP,V02,V03 node record-part3.cjs
//        PREP (no capture) opens Chromium maximized and signed in as Alex, and KeePassXC unlocked at the lower right;
//        EXPIRE (no capture) ends Sam's access again, for a retake of V17 or V18.
//        State carries over between runs in <take>/state.json (mode 0600: it holds lab-only TOTP secrets and codes).
// env: PMV_WORK, VOICE_DIR (default $PMV_WORK/narr/voice), PROXMATE_URL, PROXMATE_API, PMV_DISPLAY, PMV_CDP,
//      PMV_ADMIN_PASSWORD, PMV_FRIEND_PASSWORD (Mike), PMV_SAM_PASSWORD, PMV_CT_PASSWORD (Sam's container root
//      password), PMV_KDBX_PASSWORD (the KeePassXC database), PMV_KIOSK_PIN (4-12 digits, lab only),
//      PMV_PROXMATE_SSH (default alex@proxmate, runs as alex).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync, spawn } = require('child_process');
const TOOLS = path.join(__dirname, '..');
const x = require(path.join(TOOLS, 'xin.cjs'));
const { Web, captionButtons } = require(path.join(TOOLS, 'web.cjs'));
const { Chapter, loadNarration, log, sleep, WORK } = require(path.join(TOOLS, 'stage.cjs'));
const env = (k) => { const v = process.env[k]; if (!v) throw new Error(`set ${k}`); return v; };

const TAKE = process.env.TAKE || 't3a';
const OUT = `${WORK}/rec/${TAKE}`; fs.mkdirSync(OUT, { recursive: true });
const MAN = loadNarration(process.env.VOICE_DIR || `${WORK}/narr/voice`);
const STATE_F = `${OUT}/state.json`;
const S = fs.existsSync(STATE_F) ? JSON.parse(fs.readFileSync(STATE_F, 'utf8')) : {};
const save = () => { fs.writeFileSync(STATE_F, JSON.stringify(S, null, 1), { mode: 0o600 }); fs.chmodSync(STATE_F, 0o600); };
const APP = (process.env.PROXMATE_URL || 'http://192.168.1.50:3000').replace(/\/$/, '');
const APP_HOST = APP.replace(/^https?:\/\//, '');
const API = (process.env.PROXMATE_API || 'http://192.168.1.50:4000/api').replace(/\/$/, '');
const BOX = process.env.PMV_PROXMATE_SSH || 'alex@proxmate';
const ADMIN = { email: 'alex@example.com', name: 'Alex', get pw() { return env('PMV_ADMIN_PASSWORD'); } };
const MIKE = { email: 'mike@example.com', name: 'Mike' };
const SAM = { email: 'sam@example.com', name: 'Sam', get pw() { return env('PMV_SAM_PASSWORD'); } };
const CT = { name: 'sam-debian', ramGb: '1', diskGb: '4', template: 'debian-12-standard' };
const DOCK = { chromium: { x: 33, y: 132 }, keepassxc: { x: 33, y: 262 } };
const TABSTRIP = { x: 900, y: 52 }; // empty tab strip of a maximized Chromium window: a safe place to click it to the front

let W = null;
async function web() { if (!W) W = await Web.connect(); return W; }
const chromeWins = () => x.windows().filter((w) => /chromium/i.test(w.cls));
const noop = () => {};
async function taggedPage(tag, timeout = 15000) {
  const w = await web(); const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    for (const p of w.pages()) { try { if ((await p.evaluate(() => window.name)) === tag) { p.setDefaultTimeout(20000); if (!p.__dlg) { p.on('dialog', noop); p.__dlg = true; } return p; } } catch {} }
    await sleep(250);
  }
  throw new Error('no tab tagged ' + tag);
}
const adminPage = () => taggedPage('pm-admin');
const samPage = () => taggedPage('pm-sam');
const mikePage = () => taggedPage('pm-mike');
const activate = (id) => { x.xdo(['windowactivate', '--sync', String(parseInt(id, 16))], { quiet: true }); };

// ---------- TOTP (RFC 6238: SHA-1, 6 digits, 30 s), only to CHECK codes before they are sent ----------
// A wrong code counts toward the account lockout, so every code KeePassXC puts on the clipboard is compared with
// the one computed from the setup key read off the page, and nothing is typed when they differ.
function b32(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const ch of s.replace(/[=\s]/g, '').toUpperCase()) { const v = A.indexOf(ch); if (v < 0) throw new Error('bad base32'); bits += v.toString(2).padStart(5, '0'); }
  const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out);
}
function totp(secret, t = Date.now(), step = 0) {
  const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(Math.floor(t / 30000) + step));
  const h = crypto.createHmac('sha1', b32(secret)).update(b).digest(); const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
const secLeft = () => 30 - (Date.now() / 1000) % 30;
// Copy a code only with time to spare: wait for the next 30 s step when fewer than `min` seconds are left.
async function freshStep(min = 12) { const l = secLeft(); if (l < min) { log(`  (waiting ${l.toFixed(1)}s for a fresh code)`); await sleep((l + 0.7) * 1000); } }
const clip = () => spawnSync('runuser', ['-u', 'alex', '--', 'env', `DISPLAY=${x.DISPLAY}`, 'xclip', '-o', '-selection', 'clipboard'], { encoding: 'utf8', timeout: 3000 }).stdout || '';
function checkCode(code, secret) {
  if (!/^\d{6}$/.test(code)) throw new Error('clipboard does not hold a 6-digit code');
  if (![0, -1].some((s) => totp(secret, Date.now(), s) === code)) throw new Error('KeePassXC code does not match the setup key: not sending it');
}

// ---------- ProxMate API as Alex (read-only polling, and the off-camera steps) ----------
let cookie = null;
const H = () => ({ 'content-type': 'application/json', Origin: APP });
const cookieOf = (r) => r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
async function apiLogin() {
  const r = await fetch(API + '/auth/login', { method: 'POST', headers: H(), body: JSON.stringify({ email: ADMIN.email, password: ADMIN.pw }) });
  const j = await r.json().catch(() => ({}));
  if (j.twoFactorRequired) {
    if (!S.alexSecret) throw new Error('Alex has 2FA on but state.json has no secret');
    await freshStep(5);
    const r2 = await fetch(API + '/auth/2fa/verify', { method: 'POST', headers: H(), body: JSON.stringify({ challenge: j.challenge, code: totp(S.alexSecret) }) });
    if (!r2.ok) throw new Error(`API 2FA verify failed (${r2.status}); not retrying`); // a retry would count toward the lockout
    return cookieOf(r2);
  }
  if (!r.ok) throw new Error(`API login failed (${r.status})`);
  return cookieOf(r);
}
async function api(p, { method = 'GET', body } = {}) {
  if (!cookie) cookie = await apiLogin();
  const r = await fetch(API + p, { method, headers: { ...H(), cookie }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { cookie = null; return api(p, { method, body }); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${j.error || ''}`);
  return j;
}
async function until(fn, timeout, every = 3000, what = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { try { const v = await fn(); if (v) return v; } catch {} await sleep(every); }
  throw new Error(`timed out waiting for ${what}`);
}
// On the ProxMate box, as alex: docker and the compose project live in ~/proxmate.
function onBox(cmd) { return execFileSync('runuser', ['-u', 'alex', '--', 'ssh', '-o', 'BatchMode=yes', BOX, cmd], { encoding: 'utf8', timeout: 180000 }); }

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
const sidebar = (p, name) => p.getByRole('link', { name, exact: true }).first();
const menuItem = (p, re) => p.getByRole('menuitem', { name: re }).first();
const cardOf = (p, title) => p.locator('[data-slot=card]').filter({ has: p.locator('[data-slot=card-title]', { hasText: title }) }).first();
const tab = (p, name) => p.getByRole('tab', { name, exact: true }).first();
const btn = (p, name, exact = true) => p.getByRole('button', { name, exact }).first();
async function selectIn(p, label, option) {
  const w = await web();
  await w.click(p, p.getByText(label, { exact: true }).first().locator('xpath=following::*[@data-slot="select-trigger"][1]'), { after: 600 });
  await w.click(p, p.locator('[data-slot=select-item]:visible').filter({ hasText: option }).first(), { top: 0, bottom: 0, after: 500 });
}
// The address bar: Ctrl+L, paste what is on the clipboard, Enter.
async function goPaste() { await x.key('ctrl+l'); await sleep(250); await x.key('ctrl+v'); await sleep(400); await x.key('Return'); }
async function userMenu(p, who) { const w = await web(); await w.click(p, p.getByRole('button', { name: new RegExp(who) }).last(), { top: 0, after: 600 }); }
async function signOut(p, who) { const w = await web(); await userMenu(p, who); await w.click(p, menuItem(p, /Sign out/), { top: 0, bottom: 0 }); await p.waitForURL('**/login**', { timeout: 20000 }); await sleep(900); }
async function typeLogin(p, email, pw) {
  const w = await web();
  await w.type(p, p.locator('#email'), email, { cps: 18, clear: true }); await w.type(p, p.locator('#password'), pw, { cps: 20, clear: true });
  await w.click(p, btn(p, 'Sign in'), { after: 400 });
}
const twoFactorCard = (p) => p.getByText('Two-factor authentication', { exact: true }).first();
// A straight pointer path (Qt menus switch submenus on any row the pointer crosses, so no arcs here).
async function slide(tx, ty, ms = 350) {
  const p = x.pointer(); const n = Math.max(6, Math.round(ms / 25));
  for (let i = 1; i <= n; i++) { x.xdo(['mousemove', String(Math.round(p.x + (tx - p.x) * i / n)), String(Math.round(p.y + (ty - p.y) * i / n))]); await sleep(ms / n); }
}

// ---------- KeePassXC (Qt: fixed positions, measured with the window's client area at KP.ox, KP.oy, 800x560) ----------
const KP = { ox: 1120, oy: 470, w: 800, h: 560, rows: { ProxMate: [367, 135], Sam: [380, 165] }, ok: [362, 446], menu: { totp: [53, 103], sub: -210, setup: 195 } };
const kpWin = () => x.windows().find((w) => /keepassxc/i.test(w.cls) && / - KeePassXC$/.test(w.title));
const kpDialog = () => x.windows().find((w) => /keepassxc/i.test(w.cls) && /^Setup TOTP/.test(w.title));
async function kpOpen() {
  // off camera: a fresh database (the two entries, no TOTP yet), opened, unlocked and placed at the lower right
  execFileSync('bash', [path.join(TOOLS, '..', 'lab', 'kdbx-reset.sh')], { stdio: 'ignore', env: process.env });
  spawn('setsid', ['bash', path.join(TOOLS, 'asalex.sh'), 'keepassxc', '/home/alex/Documents/Passwords.kdbx'], { stdio: 'ignore', detached: true }).unref();
  const lw = await x.waitWindow((w) => /keepassxc/i.test(w.cls), 30000); await sleep(1500);
  const id = String(parseInt(lw.id, 16));
  x.xdo(['windowsize', id, String(KP.w), String(KP.h)]); x.xdo(['windowmove', id, String(KP.ox), String(KP.oy)]); await sleep(500);
  activate(lw.id); await sleep(400);
  x.xdo(['type', '--delay', '30', '--', env('PMV_KDBX_PASSWORD')]); await x.key('Return');
  await until(async () => kpWin(), 15000, 300, 'KeePassXC unlocked');
  const r = x.visibleRect(kpWin().id); if (r.x !== KP.ox || r.y !== KP.oy) throw new Error(`KeePassXC at ${r.x},${r.y}, not ${KP.ox},${KP.oy}`);
}
async function kpFront() {
  await x.click(DOCK.keepassxc.x, DOCK.keepassxc.y); await sleep(800);
  if (x.activeWindow() !== String(parseInt(kpWin().id, 16))) throw new Error('KeePassXC did not come to the front');
}
async function chromeFront(winId) { await x.click(TABSTRIP.x, TABSTRIP.y); await sleep(500); if (winId && x.activeWindow() !== String(parseInt(winId, 16))) throw new Error('Chromium did not come to the front'); }
async function kpRowPoint(entry) { const [rx, ry] = KP.rows[entry]; return { x: KP.ox + rx, y: KP.oy + ry }; }
// Right-click the entry, TOTP, then Copy TOTP or Set up TOTP… in the submenu (it opens to the left here).
async function kpTotpMenu(entry, item) {
  const pt = await kpRowPoint(entry);
  await x.moveTo(pt.x, pt.y); await sleep(250); await x.click(undefined, undefined, { button: 3 }); await sleep(700);
  await slide(pt.x + KP.menu.totp[0], pt.y + KP.menu.totp[1], 300); await sleep(250); await x.click(); await sleep(700);
  await slide(pt.x + KP.menu.sub, pt.y + KP.menu.totp[1], 450); await sleep(250);
  if (item === 'setup') { await slide(pt.x + KP.menu.sub, pt.y + KP.menu.setup, 300); await sleep(250); }
  await x.click(); await sleep(600);
}
async function kpSetupTotp(entry) {
  await kpTotpMenu(entry, 'setup');
  await until(async () => kpDialog(), 8000, 200, 'the Setup TOTP dialog'); await sleep(600);
  await x.key('ctrl+v'); await sleep(700); // "Secret Key:" has the focus; "Default settings (RFC 6238)" stays selected
  await x.moveTo(KP.ox + KP.ok[0], KP.oy + KP.ok[1]); await sleep(300); await x.click(); await sleep(700);
  await until(async () => !kpDialog(), 8000, 200, 'the Setup TOTP dialog to close');
}
// Copy the entry's current code (menu or Ctrl+T), and check it before anything is typed.
async function kpCopyTotp(entry, secret, { viaMenu = false } = {}) {
  await freshStep(12);
  if (viaMenu) await kpTotpMenu(entry, 'copy');
  else { const pt = await kpRowPoint(entry); await x.click(pt.x, pt.y); await sleep(400); await x.key('ctrl+t'); await sleep(500); }
  const code = clip().trim(); checkCode(code, secret); return code;
}

// ---------- chapters ----------
const CH = {};

// Off camera: Chromium maximized and signed in as Alex on the dashboard, KeePassXC unlocked at the lower right.
CH.PREP = async () => {
  let win = chromeWins()[0];
  if (!win) { await x.click(DOCK.chromium.x, DOCK.chromium.y); win = await x.waitWindow((w) => /chromium/i.test(w.cls), 30000); await sleep(2500); }
  if (!x.isMaximized(win.id)) { const b = captionButtons(win.id, 'chromium'); await x.click(b.max.x, b.max.y); await sleep(900); }
  S.adminWin = win.id;
  const w = await web(); const ctx = w.b.contexts()[0];
  const pages = ctx.pages(); const p = pages[0] || await ctx.newPage();
  for (const q of pages.slice(1)) await q.close().catch(() => {});
  await p.goto(`${APP}/login`); await sleep(1500);
  if (p.url().includes('/login')) {
    await p.locator('#email').fill(ADMIN.email); await p.locator('#password').fill(ADMIN.pw); await p.keyboard.press('Enter');
    await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 });
  }
  await p.evaluate(() => { window.name = 'pm-admin'; }); await p.goto(`${APP}/`); await sleep(1500); await p.evaluate(() => { window.name = 'pm-admin'; });
  if (!kpWin()) await kpOpen();
  activate(win.id); await sleep(600);
  await x.click(1500, 1000); await sleep(300); await x.moveTo(1500, 900);
  save(); log('  prep ready: Chromium', win.id, 'KeePassXC', kpWin().id);
};

CH.V02 = async (c) => {
  const w = await web(); const p = await adminPage();
  if (new URL(p.url()).pathname !== '/') { await p.goto(`${APP}/`); await sleep(1500); }
  await park(1200, 640);
  await c.begin(); await sleep(400);
  await c.say('Every account has its own'); await c.during(0.45); await userMenu(p, ADMIN.name);
  await w.move(p, menuItem(p, /Security/), { top: 0, bottom: 0 }); await zoomOn(c, p, [p.locator('[role=menu]').first()], 12);
  await c.say('Our friends get this page'); await c.during(0.5); c.unzoom(); await x.key('Escape'); await sleep(400);
  await c.say('As the admin'); await w.move(p, p.getByText('Admin', { exact: true }).first(), { top: 0 });
  await zoomOn(c, p, [sidebar(p, 'Invites'), sidebar(p, 'Settings')], 14);
  await c.during(0.45); await w.move(p, sidebar(p, 'Invites'), { top: 0 }); await sleep(350); await w.move(p, sidebar(p, 'Users'), { top: 0 }); await sleep(350);
  await w.move(p, sidebar(p, 'Audit Log'), { top: 0 }); await sleep(350); await w.move(p, sidebar(p, 'Settings'), { top: 0 });
  await c.quiet(0.4); c.unzoom();
  return c.end(1.0);
};

CH.V03 = async (c) => {
  const w = await web(); const p = await adminPage();
  if (!p.url().endsWith('/security')) { await p.goto(`${APP}/security`); await sleep(1500); }
  await park(1300, 700);
  await c.begin(); await sleep(400);
  await c.say('Two-factor authentication is off'); await zoomOn(c, p, cardOf(p, 'Two-factor authentication is off'), 10);
  await c.during(0.6); c.unzoom(); await w.click(p, btn(p, 'Set up 2FA', false), { after: 900 });
  const keyLine = p.getByText(/Can.t scan\? Enter this key manually:/).first(); await keyLine.waitFor();
  const code = keyLine.locator('code').first(); S.alexSecret = (await code.innerText()).trim(); save();
  await c.say('On a phone'); await w.move(p, p.getByAltText('2FA QR code'), { fx: 0.5, fy: 0.5 });
  await c.say('using KeePassXC'); await zoomOn(c, p, keyLine, 12); await c.during(0.35); await w.move(p, code, { fx: 0.5 });
  await c.during(0.7); await x.click(undefined, undefined, { double: true }); await sleep(400); await x.key('ctrl+c'); await sleep(400);
  if (clip().trim() !== S.alexSecret) { log('  (double-click did not select the whole key; selecting it again)'); await x.click(undefined, undefined, { double: true }); await sleep(300); await x.key('ctrl+c'); await sleep(300); }
  if (clip().trim() !== S.alexSecret) throw new Error('the setup key is not on the clipboard');
  await c.say('Every click on Set up 2FA'); c.unzoom();
  await c.say('In KeePassXC, I made an entry'); await c.during(0.1); await kpFront();
  await c.during(0.45); await kpSetupTotp('ProxMate');
  await c.say('TOTP is the six-digit code');
  await c.say('Now I\'ll copy the current code'); await c.during(0.15);
  await kpCopyTotp('ProxMate', S.alexSecret, { viaMenu: true });
  await chromeFront(S.adminWin);
  await w.click(p, p.locator('#code')); await x.key('ctrl+v'); await sleep(400);
  const typed = (await p.locator('#code').inputValue()).trim(); checkCode(typed, S.alexSecret);
  await w.click(p, btn(p, 'Enable 2FA', false));
  await w.toast(p, /Two-factor authentication is on/, 20000).catch(() => {});
  await c.quiet(0.6);
  return c.end(1.0);
};

CH.V04 = async (c) => {
  const w = await web(); const p = await adminPage();
  const card = cardOf(p, 'Save your recovery codes'); await card.waitFor({ timeout: 10000 });
  S.alexCodes = (await card.locator('.font-mono span').allInnerTexts()).map((s) => s.trim()); save();
  if (S.alexCodes.length !== 10) throw new Error('expected 10 recovery codes');
  await w.reveal(p, card, { top: 120 });
  await c.begin(); await sleep(400);
  await c.say('ProxMate now shows ten recovery codes'); await zoomOn(c, p, card, 10); await w.move(p, card.locator('.font-mono').first(), { fx: 0.5, fy: 0.5 });
  await c.say('They won\'t be shown again'); await c.during(0.45); await w.click(p, card.getByRole('button', { name: /Copy all/ }), { after: 500 });
  await c.say('Try to store them'); c.unzoom();
  await c.say('Once they\'re saved'); await c.during(0.2); await w.click(p, card.getByRole('button', { name: 'I\'ve saved them' }), { after: 800 });
  const on = cardOf(p, 'Two-factor authentication is on'); await on.waitFor();
  await c.during(0.6); await zoomOn(c, p, on, 10); await w.move(p, on.getByText(/recovery codes left/).first(), { fx: 0.6 });
  await c.quiet(0.6); c.unzoom();
  return c.end(1.0);
};

CH.V05 = async (c) => {
  const w = await web(); const p = await adminPage();
  if (!p.url().endsWith('/security')) { await p.goto(`${APP}/security`); await sleep(1500); }
  await c.begin(); await sleep(400);
  await c.say('Let\'s see what signing in'); await c.during(0.5); await signOut(p, ADMIN.name);
  await typeLogin(p, ADMIN.email, ADMIN.pw);
  await twoFactorCard(p).waitFor({ timeout: 20000 }); await sleep(500);
  await c.say('Instead of the dashboard'); await zoomOn(c, p, [twoFactorCard(p), btn(p, 'Verify')], 16); await w.move(p, p.locator('#code'), { fx: 0.3 });
  await c.during(0.55); c.unzoom(); await kpFront(); await c.during(0.8);
  await kpCopyTotp('ProxMate', S.alexSecret);
  await chromeFront(S.adminWin);
  await c.say('I\'ll paste it in'); await w.click(p, p.locator('#code')); await x.key('ctrl+v'); await sleep(300);
  checkCode((await p.locator('#code').inputValue()).trim(), S.alexSecret);
  await w.click(p, btn(p, 'Verify')); await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 }); await sleep(800);
  await c.say('ProxMate also accepts'); await park(1300, 700);
  await c.quiet(0.6);
  return c.end(1.0);
};

CH.V06 = async (c) => {
  const w = await web(); const p = await adminPage();
  const rc = S.alexCodes && S.alexCodes[0]; if (!rc) throw new Error('no recovery code in state');
  await c.begin(); await sleep(400);
  await c.say('Now let\'s pretend'); await c.during(0.35); await signOut(p, ADMIN.name);
  await typeLogin(p, ADMIN.email, ADMIN.pw); await twoFactorCard(p).waitFor({ timeout: 20000 }); await sleep(400);
  await c.during(0.85); await w.type(p, p.locator('#code'), rc, { cps: 9 });
  await c.say('It goes in the same box'); await zoomOn(c, p, p.locator('#code'), 40);
  await c.during(0.75); c.unzoom(); await w.click(p, btn(p, 'Verify')); await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 });
  S.alexCodes = S.alexCodes.slice(1); save(); await sleep(800);
  await userMenu(p, ADMIN.name); await w.click(p, menuItem(p, /Security/), { top: 0, bottom: 0 }); await p.waitForURL('**/security'); await sleep(900);
  const on = cardOf(p, 'Two-factor authentication is on');
  await c.say('Back on the Security page'); await zoomOn(c, p, on, 10); await w.move(p, on.getByText(/9 recovery codes left/).first(), { fx: 0.6 });
  await c.say('To get new codes'); await w.move(p, on.getByPlaceholder('123456'), { fx: 0.4 }); await c.during(0.55); await w.move(p, btn(p, 'Disable 2FA', false));
  await c.say('Please don\'t skip'); c.unzoom(); await park(1350, 760);
  await c.say('If you lose both');
  await c.quiet(0.6);
  return c.end(1.0);
};

CH.V07 = async (c) => {
  const w = await web(); const p = await adminPage();
  if (!p.url().endsWith('/security')) { await p.goto(`${APP}/security`); await sleep(1500); }
  await c.begin(); await sleep(400);
  const pk = cardOf(p, 'Passkeys');
  await c.say('Further down are passkeys'); await w.move(p, pk.locator('[data-slot=card-title]'), { fx: 2.5, top: 140, bottom: 300 }); await zoomOn(c, p, pk, 10);
  await c.say('Browsers only allow passkeys'); await w.move(p, btn(p, 'Add a passkey', false), { bottom: 300 });
  const ssh = cardOf(p, 'SSH keys'); const tok = cardOf(p, 'API tokens');
  await c.say('The SSH keys card'); c.unzoom(); await w.move(p, ssh.locator('[data-slot=card-title]'), { fx: 2.5, top: 140, bottom: 400 });
  await c.during(0.5); await w.move(p, tok.locator('[data-slot=card-title]'), { fx: 2.5, top: 140, bottom: 420 });
  await c.say('I\'ll make a token called terraform'); await c.during(0.2); await w.type(p, p.locator('#tokenName'), 'terraform', { cps: 10 });
  await w.click(p, btn(p, 'Create token', false), { after: 900 });
  const panel = p.getByText(/Your new token/).first(); await panel.waitFor();
  await zoomOn(c, p, panel.locator('xpath=ancestor::div[1]'), 14);
  await c.during(0.7); await w.click(p, tok.getByRole('button', { name: 'Copy', exact: true }).first(), { after: 500 });
  await c.say('A token can do most'); c.unzoom(); await w.click(p, tok.getByRole('button', { name: 'Done', exact: true }).first(), { after: 700 });
  await w.move(p, tok.getByText(/never used/).first(), { fx: 0.5 });
  await c.say('When a token isn\'t needed'); await c.during(0.35); await w.click(p, tok.getByRole('button', { name: 'Revoke terraform' }).first());
  await w.toast(p, /API token revoked/, 15000).catch(() => {});
  const ep = cardOf(p, 'Email preferences');
  await c.say('At the bottom'); await w.move(p, ep.locator('[data-slot=card-title]'), { fx: 2.5, top: 140, bottom: 200 }); await zoomOn(c, p, ep, 10);
  await c.quiet(0.6); c.unzoom();
  return c.end(1.0);
};

CH.V08 = async (c) => {
  const w = await web(); const p = await adminPage();
  await c.begin(); await sleep(400);
  await c.say('That covers my own account'); await c.during(0.35); await w.click(p, sidebar(p, 'Settings')); await p.waitForURL('**/admin/settings**'); await sleep(1200);
  await c.during(0.8); await w.move(p, tab(p, 'Proxmox'), { top: 0 });
  const tls = p.getByText('Verify TLS certificate', { exact: true }).first();
  await c.say('Right now the Verify TLS'); await w.move(p, tls, { fx: -0.1 }); await zoomOn(c, p, tls.locator('xpath=ancestor::label[1]').or(tls), 30);
  await c.say('Once Proxmox has a certificate'); c.unzoom();
  await c.say('In part one'); await w.move(p, p.getByText('API token ID', { exact: true }).first(), { fx: 0.5 });
  const pool = p.getByText('Proxmox pool (optional)', { exact: true }).first();
  await c.say('If you fill in a Proxmox pool'); await w.move(p, pool, { fx: 0.5 }); await zoomOn(c, p, [pool, p.getByText(/Every guest ProxMate creates, clones/).first()], 12);
  await c.say('The Test connection button'); c.unzoom(); await c.during(0.2); await w.click(p, btn(p, 'Test connection', false));
  await w.toast(p, /Connected to Proxmox VE/, 30000).catch(() => {}); await zoomOn(c, p, p.locator('[data-sonner-toast]').first(), 10);
  const iso = cardOf(p, 'Tenant network isolation');
  await c.say('Further down is tenant network isolation'); c.unzoom(); await w.move(p, iso.locator('[data-slot=card-title]'), { fx: 1.6, top: 140, bottom: 520 }); await zoomOn(c, p, iso, 8);
  await c.say('This amber note'); await w.move(p, iso.getByText(/Not enforced yet/).first(), { fx: 0.3 });
  await c.say('The Enable enforcement button'); await w.move(p, iso.getByText('Management subnet (kept reachable)', { exact: true }).first(), { fx: 0.5 });
  await c.during(0.3); await w.move(p, iso.getByRole('button', { name: /Enable enforcement/ }).first()); // pointed at, never clicked
  await c.say('I\'m leaving my lab node alone'); c.unzoom(); await c.during(0.2); await park(1400, 420);
  await c.quiet(0.6);
  return c.end(1.0);
};

CH.V09 = async (c) => {
  const w = await web(); const p = await adminPage();
  await c.begin(); await sleep(400);
  const smtp = cardOf(p, 'Email (SMTP)'); const nt = cardOf(p, 'Notifications');
  await c.say('The Notifications tab starts'); await w.click(p, tab(p, 'Notifications'), { top: 0, after: 1000 });
  await w.move(p, smtp.locator('[data-slot=card-title]'), { fx: 2, top: 140 }); await zoomOn(c, p, smtp, 8);
  await c.say('Below that'); c.unzoom(); await w.move(p, nt.getByText('Webhook URL', { exact: true }).first(), { fx: 0.5, top: 140, bottom: 400 });
  await c.during(0.5); await w.move(p, nt.getByText('ntfy', { exact: true }).first(), { fx: 0.5, bottom: 400 }); await c.during(0.8); await w.move(p, nt.getByText('Telegram', { exact: true }).first(), { fx: 0.5, bottom: 360 });
  const lock = nt.getByText('Account locked (brute-force)', { exact: true }).first();
  await c.say('The Account locked option'); await w.move(p, lock, { fx: 0.4, bottom: 200 }); await zoomOn(c, p, [nt.getByText('Notify me about', { exact: true }).first(), lock], 14);
  await c.say('This lab doesn\'t have a channel'); c.unzoom(); await w.move(p, btn(p, 'Send test', false), { bottom: 160 });
  await c.quiet(0.6);
  return c.end(1.0);
};

CH.V10 = async (c) => {
  const w = await web(); const p = await adminPage();
  await c.begin(); await sleep(400);
  const sso = cardOf(p, 'Single sign-on (OIDC)'); const kiosk = cardOf(p, 'Kiosk mode');
  await c.say('The Access tab is where'); await w.click(p, tab(p, 'Access'), { top: 0, after: 1000 });
  await w.move(p, sso.locator('[data-slot=card-title]'), { fx: 2, top: 140 }); await zoomOn(c, p, sso.locator('[data-slot=card-header]').first(), 10);
  await c.say('Keycloak is popular'); await w.move(p, sso.getByText(/Keycloak, Authentik/).first(), { fx: 0.2 });
  await c.say('It has to be on HTTPS'); c.unzoom(); await w.move(p, sso.getByText('Issuer URL', { exact: true }).first(), { fx: 0.5 });
  await c.say('When we fill it in'); await w.move(p, sso.getByText('Redirect / callback URL', { exact: true }).first(), { fx: 0.5, top: 160 });
  await zoomOn(c, p, [sso.getByText('Redirect / callback URL', { exact: true }).first(), sso.getByText(/Register this exact URL/).first()], 14);
  await c.during(0.6); c.unzoom(); await w.move(p, sso.getByText('Admin group', { exact: true }).first(), { fx: 0.5, bottom: 300 });
  await c.say('People who sign in through Keycloak'); await w.move(p, sso.getByText(/Enable SSO/).first(), { fx: 0.3, bottom: 240 });
  await c.say('Kiosk mode is a full-screen'); await w.move(p, kiosk.locator('[data-slot=card-title]'), { fx: 2, top: 160, bottom: 320 }); await zoomOn(c, p, kiosk, 8);
  await c.say('I\'ll set a PIN here'); await c.during(0.15); await w.type(p, kiosk.getByPlaceholder('••••'), env('PMV_KIOSK_PIN'), { cps: 6 });
  await w.click(p, kiosk.getByRole('button', { name: 'Set PIN', exact: true }));
  await w.toast(p, /Kiosk exit PIN set/, 15000).catch(() => {});
  await c.quiet(0.6); c.unzoom();
  return c.end(1.0);
};

CH.V11 = async (c) => {
  const w = await web(); const p = await adminPage();
  await c.begin(); await sleep(400);
  const up = cardOf(p, 'Updates'); const db = cardOf(p, 'App-database backups');
  await c.say('On the Maintenance tab'); await w.click(p, tab(p, 'Maintenance'), { top: 0, after: 1000 });
  await c.during(0.3); await w.click(p, up.getByRole('button', { name: /Check for updates/ }).first(), { top: 140 });
  await up.getByText(/You.re on the latest version/).first().waitFor({ timeout: 30000 }); await zoomOn(c, p, up, 10);
  await c.say('App-database backups save'); c.unzoom(); await w.move(p, db.locator('[data-slot=card-title]'), { fx: 2, top: 140, bottom: 420 }); await zoomOn(c, p, db, 8);
  await c.say('I\'ll click Back up now'); await c.during(0.3); await w.click(p, db.getByRole('button', { name: /Back up now/ }).first());
  await w.toast(p, /Snapshot written/, 30000).catch(() => {});
  await c.say('To keep backups off this machine'); await w.move(p, db.getByText('Backup directory', { exact: true }).first(), { fx: 0.5 });
  await c.say('Restoring one also needs'); c.unzoom(); await w.move(p, db.getByText(/ENCRYPTION_KEY/).first(), { fx: 0.5 });
  await c.quiet(0.6);
  return c.end(1.0);
};

CH.V12 = async (c) => {
  const w = await web(); const p = await adminPage();
  if (!p.url().includes('/admin/settings')) { await x.key('Escape'); await p.goto(`${APP}/admin/settings?tab=maintenance`); await sleep(1500); await park(1400, 700); }
  await c.begin(); await sleep(400);
  await c.say('Now let\'s invite our new friend Sam'); await c.during(0.2); await w.click(p, sidebar(p, 'Invites')); await p.waitForURL('**/admin/invites'); await sleep(1100);
  const form = cardOf(p, 'Create an invite');
  await c.say('I\'m keeping the usual quota'); await w.move(p, p.locator('#cpu'), { fx: 0.5 }); await sleep(300); await w.move(p, p.locator('#storage'), { fx: 0.5 });
  await c.during(0.5); await selectIn(p, 'Invite link expires in', /^1 day$/);
  await c.say('Compute access is how long'); await c.during(0.5); await selectIn(p, 'Compute access', /^7 days$/);
  await w.type(p, p.locator('#label'), SAM.name, { cps: 8 });
  const req = form.locator('label').filter({ hasText: 'Require two-step authentication' }).first();
  await c.say('Then I\'ll check Require'); await c.during(0.15); await w.click(p, req.locator('input[type=checkbox]'));
  await zoomOn(c, p, req, 12); await c.during(0.8); c.unzoom(); await w.click(p, btn(p, 'Generate invite', false), { after: 900 });
  await w.toast(p, /Invite created/, 15000).catch(() => {});
  const row = p.locator('tr').filter({ hasText: SAM.name }).first(); await row.waitFor();
  await c.say('Sam\'s invite now has a 2FA badge'); await w.move(p, row.getByText('2FA', { exact: true }).first(), { bottom: 160 }); await zoomOn(c, p, row, 12);
  const box = p.locator('code').filter({ hasText: '/register/' }).first();
  await c.say('On plain HTTP'); c.unzoom(); await w.click(p, form.getByRole('button', { name: 'Copy', exact: true }).first(), { top: 140 });
  await w.toast(p, /Could not copy/, 8000).catch(() => {}); await sleep(600);
  S.inviteUrl = (await box.innerText()).trim(); save();
  await w.move(p, box, { fx: 0.3 }); await sleep(250); x.xdo(['click', '--repeat', '3', '--delay', '90', '1']); if (x.onClick) x.onClick(x.pointer(), 1);
  await sleep(400); await x.key('ctrl+c'); await sleep(400);
  if (clip().trim() !== S.inviteUrl) { log('  (selection was not the link, putting it on the clipboard)'); await x.clipboard(S.inviteUrl); }
  await c.say('Send it to Sam somewhere private'); await park(1500, 900);
  await c.quiet(0.6);
  return c.end(1.0);
};

CH.V13 = async (c) => {
  const w = await web(); const p = await adminPage(); activate(S.adminWin);
  if (clip().trim() !== S.inviteUrl) await x.clipboard(S.inviteUrl);
  await c.begin(); await sleep(400);
  await c.say('This private window stands in'); await c.during(0.1);
  const before = chromeWins().map((q) => q.id); await x.key('ctrl+shift+n');
  const sw = await x.waitWindow((q) => /chromium/i.test(q.cls) && !before.includes(q.id), 20000); S.samWin = sw.id; save(); await sleep(1500);
  if (!x.isMaximized(sw.id)) { await x.key('super+Up'); await sleep(900); }
  await goPaste();
  const sp = await w.page((u) => u.includes('/register/'), 20000); sp.on('dialog', noop); await sp.waitForLoadState('load').catch(() => {});
  await sp.evaluate(() => { window.name = 'pm-sam'; });
  await sp.getByText('Create your account').first().waitFor({ timeout: 20000 }); await sleep(600);
  await c.say('The invite page shows'); await w.move(sp, sp.getByText('vCPU', { exact: true }).first(), { fx: 0.5 });
  await zoomOn(c, sp, sp.getByText(/This invite requires two-step authentication/).first(), 14); await w.move(sp, sp.getByText(/This invite requires two-step authentication/).first(), { fx: 0.3 });
  await c.say('Sam fills in a name'); c.unzoom();
  await w.type(sp, sp.locator('#displayName'), SAM.name, { cps: 9 }); await w.type(sp, sp.locator('#email'), SAM.email, { cps: 16 });
  await w.type(sp, sp.locator('#password'), SAM.pw, { cps: 18 }); await w.type(sp, sp.locator('#confirm'), SAM.pw, { cps: 18 });
  await w.click(sp, btn(sp, 'Create account', false));
  await sp.waitForURL('**/setup-2fa**', { timeout: 30000 }); await sleep(900);
  await c.say('Instead of the dashboard, the setup page'); await w.move(sp, btn(sp, 'Use a passkey instead', false));
  await c.during(0.65); await w.click(sp, btn(sp, 'Set up authenticator app', false), { after: 900 });
  const keyLine = sp.getByText(/Can.t scan\? Enter this key:/).first(); await keyLine.waitFor();
  const code = keyLine.locator('code').first().or(keyLine.locator('xpath=following::code[1]')).first();
  S.samSecret = (await code.innerText()).trim(); save();
  await c.say('From here, the steps match'); await w.move(sp, code, { fx: 0.5 }); await sleep(300);
  await x.click(undefined, undefined, { double: true }); await sleep(400); await x.key('ctrl+c'); await sleep(400);
  if (clip().trim() !== S.samSecret) { await x.click(undefined, undefined, { double: true }); await sleep(300); await x.key('ctrl+c'); await sleep(300); }
  if (clip().trim() !== S.samSecret) throw new Error('Sam\'s setup key is not on the clipboard');
  await kpFront(); await kpSetupTotp('Sam');
  await kpCopyTotp('Sam', S.samSecret, { viaMenu: true });
  await chromeFront(S.samWin);
  await w.click(sp, sp.locator('#code')); await x.key('ctrl+v'); await sleep(400);
  checkCode((await sp.locator('#code').inputValue()).trim(), S.samSecret);
  await w.click(sp, btn(sp, 'Enable', true));
  const rc = sp.getByText('Save your recovery codes').first(); await rc.waitFor({ timeout: 20000 }); await sleep(500);
  S.samCodes = (await sp.locator('.font-mono span').allInnerTexts()).map((s) => s.trim()); save();
  await c.say('The recovery codes come up next'); await zoomOn(c, sp, rc.locator('xpath=ancestor::*[@data-slot="card"][1]'), 10);
  await c.during(0.55); c.unzoom(); await w.click(sp, sp.getByRole('button', { name: /I.ve saved them/ }).first());
  await sp.waitForURL('**/login**', { timeout: 20000 }); await sleep(800);
  await c.say('Setup doesn\'t sign Sam in'); await typeLogin(sp, SAM.email, SAM.pw);
  await twoFactorCard(sp).waitFor({ timeout: 20000 }); await sleep(400);
  await kpFront(); await kpCopyTotp('Sam', S.samSecret); await chromeFront(S.samWin);
  await w.click(sp, sp.locator('#code')); await x.key('ctrl+v'); await sleep(300); checkCode((await sp.locator('#code').inputValue()).trim(), S.samSecret);
  await w.click(sp, btn(sp, 'Verify')); await sp.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 }); await sleep(900);
  await c.say('If Sam had closed the setup page'); await park(1300, 700);
  await c.quiet(0.6);
  return c.end(1.0);
};

CH.V14 = async (c) => {
  const w = await web(); const sp = await samPage(); activate(S.samWin);
  if (new URL(sp.url()).pathname !== '/') { await sp.goto(`${APP}/`); await sleep(1500); }
  const banner = sp.getByText(/Your compute access ends in/).first(); await banner.waitFor({ timeout: 15000 });
  await c.begin(); await sleep(400);
  await c.say('Sam\'s access ends in a week'); await zoomOn(c, sp, banner.locator('xpath=ancestor::*[contains(@class,"border")][1]'), 8); await w.move(sp, banner, { fx: 0.6 });
  await c.say('It says the machines'); await c.during(0.2); await w.move(sp, sp.getByText(/Nothing is deleted/).first(), { fx: 0.5 });
  await c.say('Now Sam is going to start'); c.unzoom(); await w.click(sp, sidebar(sp, 'Virtual Machines')); await sp.waitForURL('**/vms'); await sleep(900);
  await w.click(sp, sp.getByRole('link', { name: /New VM/ }).or(sp.getByRole('button', { name: /New VM/ })).first()); await sp.waitForURL('**/vms/new**'); await sleep(1000);
  await w.click(sp, sp.locator('[data-slot=select-trigger]').first(), { after: 600 });
  await w.click(sp, sp.locator('[data-slot=select-item]:visible').filter({ hasText: 'Container (LXC)' }).first(), { top: 0, bottom: 0, after: 600 });
  await w.type(sp, sp.locator('#name'), CT.name, { cps: 10 });
  await w.click(sp, sp.getByRole('button', { name: /^Small/ }).first());
  await selectIn(sp, 'Memory', new RegExp(`^${CT.ramGb} GB$`));
  await w.type(sp, sp.locator('#storage'), CT.diskGb, { cps: 8, clear: true });
  const ctSel = sp.getByText('Container template').locator('xpath=following::*[@data-slot="select-trigger"][1]');
  await w.click(sp, ctSel, { after: 600 }); await w.click(sp, sp.locator('[data-slot=select-item]:visible').filter({ hasText: CT.template }).first(), { top: 0, bottom: 0, after: 400 });
  await w.type(sp, sp.locator('#ct-password'), env('PMV_CT_PASSWORD'), { cps: 14 });
  await w.click(sp, btn(sp, 'Create container', false));
  await sp.waitForURL(/\/vms\/(?!new$)[a-z0-9]+$/, { timeout: 60000 }); S.ctId = (sp.url().match(/\/vms\/([a-z0-9]+)/) || [])[1]; save();
  await c.say('Creating it takes'); await park(1500, 800); await c.quiet(0.3);
  c.ffStart('container create', 5);
  await until(async () => (await api(`/vms/${S.ctId}`)).status === 'running', 10 * 60000, 2000, 'Sam\'s container');
  await w.click(sp, sidebar(sp, 'Dashboard')); await sp.waitForURL((u) => u.pathname === '/'); await sleep(1500); c.ffEnd();
  await c.say('The container is running now', { gap: 0.5 }); await w.move(sp, sp.getByText('vCPU', { exact: true }).first(), { fx: 0.5 });
  await zoomOn(c, sp, [sp.getByText('vCPU', { exact: true }).first(), sp.getByText('Storage', { exact: true }).first()], 30);
  await c.quiet(0.6); c.unzoom();
  return c.end(1.0);
};

CH.V15 = async (c) => {
  const w = await web(); const ap = await adminPage();
  // Off camera: Mike's guest window, opened from Alex's so that Alt+` goes back to Alex's window afterwards.
  activate(S.adminWin); await sleep(500);
  if (!S.mikeWin || !x.windows().some((q) => q.id === S.mikeWin)) {
    const before = chromeWins().map((q) => q.id);
    spawn('setsid', ['bash', path.join(TOOLS, 'asalex.sh'), '/usr/local/bin/chromium-browser', '--guest'], { stdio: 'ignore', detached: true }).unref();
    const mw = await x.waitWindow((q) => /chromium/i.test(q.cls) && !before.includes(q.id), 30000); S.mikeWin = mw.id; save(); await sleep(2000);
    if (!x.isMaximized(mw.id)) { await x.key('super+Up'); await sleep(900); }
    await w.go(`${APP_HOST}/login`); const mp = await w.page((u) => u.startsWith(APP + '/login') && true, 20000);
    await mp.waitForLoadState('load').catch(() => {}); await mp.evaluate(() => { window.name = 'pm-mike'; }); await sleep(800);
  }
  const mp = await mikePage(); activate(S.mikeWin); await sleep(400); await park(1300, 760);
  await c.begin(); await sleep(400);
  await c.say('Next, let\'s check on Mike'); await c.during(0.45); await w.click(mp, mp.getByRole('link', { name: /Forgot your password/ }).first());
  await mp.waitForURL('**/forgot-password**'); await sleep(700);
  await w.type(mp, mp.locator('#email'), MIKE.email, { cps: 16 }); await w.click(mp, btn(mp, 'Send reset request', false));
  const recv = mp.getByText('Request received', { exact: true }).first(); await recv.waitFor({ timeout: 15000 });
  await c.say('Without an email server'); await zoomOn(c, mp, [recv, mp.getByText(/your administrator has been notified/).first()], 16);
  await c.say('ProxMate doesn\'t notify me'); c.unzoom(); await c.during(0.2); await x.key('alt+grave'); await sleep(900);
  if (x.activeWindow() !== String(parseInt(S.adminWin, 16))) throw new Error('Alt+` did not bring back Alex\'s window');
  await w.click(ap, sidebar(ap, 'Users')); await ap.waitForURL('**/admin/users'); await sleep(1200);
  const req = ap.getByText(/password reset request/).first(); await req.waitFor({ timeout: 15000 });
  const row = ap.locator('tr').filter({ hasText: MIKE.email }).first();
  await c.say('Mike\'s row has a reset requested badge'); await zoomOn(c, ap, [req, row], 10); await w.move(ap, row.getByText('reset requested').first());
  await c.during(0.55); c.unzoom(); await w.click(ap, row.getByTitle('Reset password').first(), { after: 800 });
  const dlg = ap.getByRole('alertdialog').first(); await dlg.waitFor();
  await w.click(ap, dlg.getByRole('button', { name: /Generate a random password/ }).first(), { top: 0, bottom: 0, after: 600 });
  await c.say('Setting it signs Mike out'); await zoomOn(c, ap, dlg, 10); await c.during(0.6); await w.click(ap, dlg.getByRole('button', { name: 'Set password', exact: true }), { top: 0, bottom: 0 });
  await w.toast(ap, /Password reset for/, 15000).catch(() => {}); c.unzoom();
  await c.say('Send the new password to Mike');
  await c.quiet(0.6);
  return c.end(1.0);
};

CH.V16 = async (c) => {
  const w = await web(); activate(S.adminWin); await sleep(400);
  await c.begin(); await sleep(400);
  await c.say('ProxMate also protects'); await c.during(0.45); await x.key('ctrl+t'); await sleep(700); await w.go('proxmate.host/docs/config');
  const dp = await w.page((u) => u.includes('proxmate.host/docs/config'), 30000); await dp.waitForLoadState('load').catch(() => {}); await sleep(1200);
  await dp.evaluate(() => { window.name = 'pm-docs'; });
  const rate = dp.getByText('AUTH_RATE_LIMIT_MAX', { exact: true }).first(); const lockM = dp.getByText(/AUTH_LOCKOUT_MAX/).first();
  await c.say('Ten wrong passwords in a row'); await w.move(dp, lockM, { fx: 0.5, top: 300, bottom: 300 }); await zoomOn(c, dp, lockM.locator('xpath=ancestor::tr[1]'), 10);
  await c.say('While it\'s locked'); await c.during(0.3); await w.move(dp, lockM.locator('xpath=ancestor::tr[1]'), { fx: 0.75 });
  await c.say('On top of that'); c.unzoom(); await w.move(dp, rate, { fx: 0.5, top: 300, bottom: 300 }); await zoomOn(c, dp, rate.locator('xpath=ancestor::tr[1]'), 10);
  await c.say('A lock sends the alert'); c.unzoom(); await c.during(0.25); await w.go('proxmate.host/docs/security');
  const sp = await w.page((u) => u.includes('proxmate.host/docs/security'), 30000); await sp.waitForLoadState('load').catch(() => {}); await sleep(1200);
  const bf = sp.getByText(/Brute force/).first(); await w.move(sp, bf, { fx: 0.3, top: 260, bottom: 360 }); await zoomOn(c, sp, bf.locator('xpath=ancestor::li[1]').or(bf), 10);
  await c.quiet(0.6); c.unzoom();
  return c.end(1.0);
};

// Off camera before V17: Sam's end date one minute in the past (a database edit) and the backend restarted, so the
// access check runs now (about 15 s after start) instead of at :20 past the hour. Then wait for the suspension.
async function expireSam() {
  const js = "const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.user.update({where:{email:'sam@example.com'},data:{accessExpiresAt:new Date(Date.now()-60000)}}).then(()=>{console.log('expired');process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})";
  log('  ' + onBox(`docker exec proxmate-backend-1 node -e "${js.replace(/"/g, '\\"')}"`).trim());
  log('  restarting the backend'); onBox('cd ~/proxmate && docker compose restart backend >/dev/null 2>&1');
  cookie = null;
  await until(async () => (await fetch(API + '/setup/status')).ok, 120000, 2000, 'the backend');
  await until(async () => { const us = await api('/users'); const sam = (Array.isArray(us) ? us : us.users || []).find((u) => u.email === SAM.email); return sam && (sam.accessSuspendedAt || sam.suspended); }, 180000, 3000, 'Sam\'s suspension');
  await until(async () => (await api(`/vms/${S.ctId}`)).status === 'stopped', 180000, 3000, 'Sam\'s container to stop');
  S.expired = true; save(); log('  Sam suspended, container stopped');
}

CH.V17 = async (c) => {
  const w = await web();
  for (const q of w.pages()) { try { if ((await q.evaluate(() => window.name)) === 'pm-docs') await q.close(); } catch {} }
  // Mike's guest window is done: closing it leaves Alt+` going between Alex's window and Sam's.
  if (S.mikeWin && x.windows().some((q) => q.id === S.mikeWin)) { activate(S.mikeWin); await sleep(400); await x.key('ctrl+shift+w'); await sleep(1200); }
  if (!S.expired) await expireSam();
  activate(S.samWin); await sleep(300); activate(S.adminWin); await sleep(400);
  const ap = await adminPage(); await ap.goto(`${APP}/admin/users`); await sleep(1500); await park(1300, 760);
  await c.begin(); await sleep(400);
  const row = ap.locator('tr').filter({ hasText: SAM.email }).first();
  await c.say('Rather than wait a whole week'); await w.move(ap, row, { fx: 0.3 });
  await c.say('Sign-in stops the moment'); await zoomOn(c, ap, row, 10); await w.move(ap, row.getByText('Suspended', { exact: true }).first());
  await c.say('The check marked Sam as Suspended'); await c.during(0.45); c.unzoom(); await w.click(ap, sidebar(ap, 'Virtual Machines')); await ap.waitForURL('**/vms'); await sleep(1500);
  const ct = ap.locator('tr').filter({ hasText: CT.name }).first(); await w.move(ap, ct.getByText(CT.name).first()); await zoomOn(c, ap, ct, 10);
  await c.say('Sam\'s window was still open'); c.unzoom(); await c.during(0.1); await x.key('alt+grave'); await sleep(900);
  if (x.activeWindow() !== String(parseInt(S.samWin, 16))) throw new Error('Alt+` did not bring up Sam\'s window');
  const sp = await samPage(); await x.key('F5'); await sleep(2500);
  const ended = sp.getByText('Your compute access has ended.', { exact: true }).first(); await ended.waitFor({ timeout: 20000 });
  await zoomOn(c, sp, ended.locator('xpath=ancestor::*[contains(@class,"border")][1]'), 8); await w.move(sp, ended, { fx: 0.6 });
  await c.say('Signing in again is refused'); c.unzoom(); await signOut(sp, SAM.name); await typeLogin(sp, SAM.email, SAM.pw);
  const t = await w.toast(sp, /compute access ended/, 15000).catch(() => ''); log('  toast:', t.slice(0, 80));
  await zoomOn(c, sp, sp.locator('[data-sonner-toast]').first(), 10);
  await c.say('The container is only stopped'); await c.quiet(0.8); c.unzoom();
  return c.end(1.0);
};

CH.V18 = async (c) => {
  const w = await web(); activate(S.samWin); await sleep(300); activate(S.adminWin); await sleep(400);
  const ap = await adminPage(); if (!ap.url().endsWith('/vms')) { await ap.goto(`${APP}/vms`); await sleep(1500); }
  await c.begin(); await sleep(400);
  await c.say('To give Sam more time'); await c.during(0.3); await w.click(ap, sidebar(ap, 'Users')); await ap.waitForURL('**/admin/users'); await sleep(1100);
  const row = ap.locator('tr').filter({ hasText: SAM.email }).first();
  await w.click(ap, row.getByTitle('Edit profile & quota').first(), { after: 900 });
  const dlg = ap.getByRole('dialog').or(ap.getByRole('alertdialog')).first(); await dlg.waitFor();
  await c.during(0.75); await w.click(ap, dlg.getByText('Compute access', { exact: true }).first().locator('xpath=following::*[@data-slot="select-trigger"][1]'), { top: 0, bottom: 0, after: 600 });
  await w.click(ap, ap.locator('[data-slot=select-item]:visible').filter({ hasText: /^7 days from today$/ }).first(), { top: 0, bottom: 0, after: 500 });
  await c.say('Saving it lifts'); await c.during(0.1); await w.click(ap, dlg.getByRole('button', { name: /Save quota/ }).first(), { top: 0, bottom: 0 });
  await w.toast(ap, /access now runs for/, 15000).catch(() => {}); await sleep(600); await zoomOn(c, ap, row, 10);
  await c.say('The container doesn\'t start back up'); c.unzoom(); await c.during(0.15); await x.key('alt+grave'); await sleep(900);
  if (x.activeWindow() !== String(parseInt(S.samWin, 16))) throw new Error('Alt+` did not bring up Sam\'s window');
  const sp = await samPage();
  if (!sp.url().includes('/login')) { await sp.goto(`${APP}/login`); await sleep(1200); }
  await typeLogin(sp, SAM.email, SAM.pw); await twoFactorCard(sp).waitFor({ timeout: 20000 }); await sleep(400);
  await kpFront(); await kpCopyTotp('Sam', S.samSecret); await chromeFront(S.samWin);
  await w.click(sp, sp.locator('#code')); await x.key('ctrl+v'); await sleep(300); checkCode((await sp.locator('#code').inputValue()).trim(), S.samSecret);
  await w.click(sp, btn(sp, 'Verify')); await sp.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 }); await sleep(900);
  await w.click(sp, sidebar(sp, 'Virtual Machines')); await sp.waitForURL('**/vms'); await sleep(900);
  await w.click(sp, sp.getByRole('link', { name: CT.name, exact: true }).first()); await sp.waitForURL(/\/vms\/[a-z0-9]+$/); await sleep(1200);
  await w.click(sp, sp.getByRole('button', { name: /^Actions/ }).first(), { after: 600 }); await w.click(sp, menuItem(sp, /^Start/), { top: 0, bottom: 0 });
  await until(async () => (await api(`/vms/${S.ctId}`)).status === 'running', 120000, 1500, 'the container to start');
  await sleep(1500); await w.move(sp, sp.getByText('Running', { exact: true }).first());
  // a few seconds of the running container: room for an extra line here if the creator wants one
  await c.quiet(0.6); await sleep(4000);
  return c.end(1.0);
};

CH.V19 = async (c) => {
  const w = await web(); activate(S.adminWin); await sleep(400); const ap = await adminPage();
  await c.begin(); await sleep(400);
  await c.say('Almost everything we did today'); await c.during(0.2); await w.click(ap, sidebar(ap, 'Audit Log')); await ap.waitForURL('**/admin/audit'); await sleep(1200);
  await w.click(ap, btn(ap, 'Refresh', false), { top: 0, after: 1200 });
  await zoomOn(c, ap, ap.locator('thead').first(), 6); await c.during(0.6); c.unzoom();
  const action = (a) => ap.locator('tr').filter({ hasText: a }).first();
  await c.say('There\'s Sam\'s invite'); await w.move(ap, action('invite.create'), { fx: 0.4, top: 160, bottom: 200 }); await c.during(0.35);
  await w.move(ap, action('auth.2fa_enabled'), { fx: 0.4, top: 160, bottom: 200 }); await c.during(0.7); await w.move(ap, action('auth.login'), { fx: 0.4, top: 160, bottom: 200 });
  await c.say('Mike\'s password reset is here'); await w.move(ap, action('admin.reset_password'), { fx: 0.4, top: 160, bottom: 200 });
  await zoomOn(c, ap, [action('admin.update_access'), action('admin.access_suspended')], 8);
  await c.during(0.5); await w.move(ap, action('auth.login_blocked'), { fx: 0.4, top: 160, bottom: 200 });
  await c.say('Failed sign-ins and wrong codes'); c.unzoom();
  await c.say('The page doesn\'t refresh itself'); await w.move(ap, btn(ap, 'Refresh', false), { top: 0 });
  await c.quiet(0.6);
  return c.end(1.0);
};

CH.V20 = async (c) => {
  const w = await web(); activate(S.adminWin); await sleep(400);
  await c.begin(); await sleep(400);
  await c.say('The ProxMate docs have a page'); await c.during(0.2); await x.key('ctrl+t'); await sleep(700); await w.go('proxmate.host/docs/security#checklist');
  const dp = await w.page((u) => u.includes('proxmate.host/docs/security'), 30000); await dp.waitForLoadState('load').catch(() => {}); await sleep(1500);
  await dp.evaluate(() => { window.name = 'pm-docs'; });
  const table = dp.locator('#checklist').locator('xpath=following::table[1]').first();
  await w.move(dp, table, { fx: 0.4, fy: 0.05, top: 120, bottom: 200 });
  await c.say('We did the encryption key backup'); await w.move(dp, dp.getByText(/ENCRYPTION_KEY is a stable/).first(), { fx: 0.3, bottom: 300 }); await c.during(0.6); await w.move(dp, dp.getByText(/Require 2FA for tenant invites/).first(), { fx: 0.3, bottom: 300 });
  await c.say('Turning on the cluster firewall'); await w.move(dp, dp.getByText(/Cluster firewall enabled/).first(), { fx: 0.3, bottom: 300 }); await c.during(0.4); await w.move(dp, dp.getByText(/least-privilege role/).first(), { fx: 0.3, bottom: 300 });
  await c.during(0.8); await w.move(dp, dp.getByText(/SQLite database file is backed up/).first(), { fx: 0.3, bottom: 200 });
  await c.say('HTTPS is near the top'); await w.move(dp, dp.getByText(/Served over a single HTTPS domain/).first(), { fx: 0.3, top: 200 }); await zoomOn(c, dp, dp.getByText(/Served over a single HTTPS domain/).first().locator('xpath=ancestor::tr[1]'), 8);
  await c.quiet(0.6); c.unzoom();
  return c.end(1.0);
};

CH.V21 = async (c) => {
  const w = await web(); activate(S.adminWin); await sleep(400);
  for (const q of w.pages()) { try { if ((await q.evaluate(() => window.name)) === 'pm-docs') await q.close(); } catch {} }
  await sleep(600); const ap = await adminPage(); await ap.bringToFront(); await ap.goto(`${APP}/admin/audit`); await sleep(1200);
  await c.begin(); await sleep(400);
  await c.say('That\'s it for part three'); await userMenu(ap, ADMIN.name); await w.click(ap, menuItem(ap, /Security/), { top: 0, bottom: 0 }); await ap.waitForURL('**/security'); await sleep(900);
  await zoomOn(c, ap, cardOf(ap, 'Two-factor authentication is on'), 10);
  await c.say('In part four'); await c.during(0.15); c.unzoom(); await w.click(ap, sidebar(ap, 'Settings')); await ap.waitForURL('**/admin/settings**'); await sleep(900);
  await w.click(ap, tab(ap, 'Access'), { top: 0, after: 900 }); await w.move(ap, cardOf(ap, 'Single sign-on (OIDC)').locator('[data-slot=card-title]'), { fx: 2, top: 140 });
  await c.say('Let me know in the comments'); await park(1500, 800);
  return c.end(1.5);
};

// Cold open, recorded last: Sam signs in with a code and lands on the dashboard.
CH.V01 = async (c) => {
  const w = await web(); activate(S.adminWin); await sleep(300); activate(S.samWin); await sleep(400);
  const sp = await samPage();
  if (!sp.url().includes('/login')) { try { await signOut(sp, SAM.name); } catch { await sp.goto(`${APP}/login`); await sleep(1200); } }
  await park(1300, 760);
  await c.begin(); await sleep(400);
  await c.say(0); await c.during(0.2); await typeLogin(sp, SAM.email, SAM.pw);
  await twoFactorCard(sp).waitFor({ timeout: 20000 }); await sleep(300);
  await c.say(1); await zoomOn(c, sp, [twoFactorCard(sp), btn(sp, 'Verify')], 16); await c.during(0.45); c.unzoom();
  await kpFront(); await kpCopyTotp('Sam', S.samSecret); await chromeFront(S.samWin);
  await w.click(sp, sp.locator('#code')); await x.key('ctrl+v'); await sleep(300); checkCode((await sp.locator('#code').inputValue()).trim(), S.samSecret);
  await w.click(sp, btn(sp, 'Verify')); await sp.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 }); await sleep(900);
  await c.say(2); const banner = sp.getByText(/Your compute access ends in/).first(); await w.move(sp, banner, { fx: 0.5 });
  await c.say(3); await park(1400, 800);
  return c.end(1.0);
};

(async () => {
  const order = (process.env.ONLY || 'PREP,V02,V03,V04,V05,V06,V07,V08,V09,V10,V11,V12,V13,V14,V15,V16,V17,V18,V19,V20,V21,V01').split(',');
  for (const id of order) {
    if (id === 'PREP') { try { await CH.PREP(); continue; } catch (e) { log(`!!! PREP failed: ${e.message.split('\n')[0]}`); process.exitCode = 1; break; } }
    // EXPIRE (no capture): Sam's window ends again off camera, e.g. before a retake of V18
    if (id === 'EXPIRE') { S.expired = false; await expireSam(); continue; }
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
