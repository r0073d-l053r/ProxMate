// Off camera, before re-recording S12-S15 and S01: put the desktop back exactly how S11 ends.
// Mike's invite, account and VM removed; no incognito window; the docs tab first, then the admin's ProxMate
// tab on the Template Store (top of page, cloud-init extras panel open); Chromium maximized and in front;
// the pointer on "Save selection" (S12 re-clicks it before rolling, so the "options saved" toast is on screen).
// Part one only (retakes of S12-S15 and S01).
// usage: TAKE=take5 node s12-preroll.cjs   (env PMV_WORK, PROXMATE_URL, PROXMATE_API, PMV_CDP, PMV_DISPLAY,
//        PMV_ADMIN_EMAIL default alex@example.com, PMV_ADMIN_PASSWORD only if the admin tab is signed out)
const fs = require('fs');
const os = require('os');
const path = require('path');
const x = require(path.join(__dirname, '../../record/xin.cjs'));
const { Web } = require(path.join(__dirname, '../../record/web.cjs'));
const env = (k) => { const v = process.env[k]; if (!v) throw new Error(`set ${k}`); return v; };
const WORK = process.env.PMV_WORK || path.join(os.homedir(), 'pmv', 'work');
const APP = (process.env.PROXMATE_URL || 'http://192.168.1.50:3000').replace(/\/$/, '');
const API_ORIGIN = new URL(process.env.PROXMATE_API || 'http://192.168.1.50:4000/api').origin;
const ADMIN = { email: process.env.PMV_ADMIN_EMAIL || 'alex@example.com', get pw() { return env('PMV_ADMIN_PASSWORD'); } };
const STATE_F = `${WORK}/rec/${process.env.TAKE || 'take5'}/state.json`;
const step = (m) => console.log(`  preroll: ${m}`);

(async () => {
  const w = await Web.connect(); const ctx = w.b.contexts()[0];
  // Mike's incognito window (its own browser context) goes first.
  for (const c of w.b.contexts()) if (c !== ctx) for (const q of c.pages()) { step(`close incognito ${q.url()}`); await q.close().catch(() => {}); }
  let docs = ctx.pages().find((q) => q.url().includes('proxmate.host'));
  if (!docs) { docs = await ctx.newPage(); await docs.goto('https://proxmate.host/docs/proxmox', { waitUntil: 'load', timeout: 45000 }); }
  let a = ctx.pages().find((q) => q.url().startsWith(APP));
  if (!a) { a = await ctx.newPage(); step('open the admin tab'); }
  for (const q of ctx.pages()) if (q !== docs && q !== a) await q.close();
  await a.goto(APP + '/templates', { waitUntil: 'load' }); await x.sleep(1200);
  if (/\/login/.test(a.url())) {
    step('log in as the admin');
    await a.getByLabel('Email').fill(ADMIN.email); await a.getByLabel('Password', { exact: true }).fill(ADMIN.pw);
    await a.getByRole('button', { name: /sign in|log in/i }).first().click(); await a.waitForURL((u) => !/\/login/.test(u.toString()), { timeout: 20000 });
    await a.goto(APP + '/templates', { waitUntil: 'load' }); await x.sleep(1200);
  }
  await a.evaluate(() => { window.name = 'pm-admin'; });

  // Undo the invite, sign-up and deploy (the same calls the UI makes).
  const api = (method, path) => a.evaluate(async ([m, u]) => {
    const csrf = (document.cookie.match(/(?:^|;\s*)proxmate_csrf=([^;]+)/) || [])[1];
    const r = await fetch(u, { method: m, credentials: 'include', headers: csrf ? { 'X-CSRF-Token': decodeURIComponent(csrf) } : {} });
    let b = null; try { b = await r.json(); } catch {} return { s: r.status, b };
  }, [method, API_ORIGIN + path]);
  const list = (r, k) => (Array.isArray(r.b) ? r.b : (r.b && (r.b[k] || r.b.data)) || []);
  for (const v of list(await api('GET', '/api/vms'), 'vms')) if (v.name === 'mike-ubuntu') step(`delete vm ${v.id}: ${(await api('DELETE', `/api/vms/${v.id}`)).s}`);
  for (let i = 0; i < 90 && list(await api('GET', '/api/vms'), 'vms').some((v) => v.name === 'mike-ubuntu'); i++) await x.sleep(2000);
  if (list(await api('GET', '/api/vms'), 'vms').some((v) => v.name === 'mike-ubuntu')) throw new Error("Mike's VM is still there");
  for (const u of list(await api('GET', '/api/users'), 'users')) if (u.email === 'mike@example.com') step(`delete user ${u.id}: ${(await api('DELETE', `/api/users/${u.id}`)).s}`);
  for (const i of list(await api('GET', '/api/invites'), 'invites')) step(`delete invite ${i.id}: ${(await api('DELETE', `/api/invites/${i.id}`)).s}`);

  // The page as S11 leaves it.
  await a.goto(APP + '/templates', { waitUntil: 'load' }); await x.sleep(1500);
  await a.evaluate(() => window.scrollTo(0, 0)); await x.sleep(300);
  const win = x.windows().filter((q) => /chromium/i.test(q.cls)).map((q) => { try { const r = x.visibleRect(q.id); return { q, s: r.w * r.h }; } catch { return { q, s: 0 }; } })
    .sort((m, n) => n.s - m.s).map((e) => e.q)[0];
  if (!win) throw new Error('Chromium is not running');
  x.xdo(['windowactivate', '--sync', String(parseInt(win.id, 16))], { quiet: true }); await x.sleep(400);
  if (!x.isMaximized(win.id)) throw new Error('Chromium is not maximized');
  await a.bringToFront(); await x.sleep(500);
  if (!(await a.getByRole('button', { name: 'Save selection' }).count())) { await w.click(a, a.getByRole('button', { name: 'Configure' }).first()); await x.sleep(900); }
  await a.evaluate(() => window.scrollTo(0, 0)); await x.sleep(300);
  await w.move(a, a.getByRole('button', { name: 'Save selection' }).first(), { top: 0, bottom: 0 }); await x.sleep(400);

  const S = fs.existsSync(STATE_F) ? JSON.parse(fs.readFileSync(STATE_F, 'utf8')) : {};
  S.adminWin = win.id; delete S.mikeWin; delete S.invite; fs.writeFileSync(STATE_F, JSON.stringify(S, null, 1));
  const tz = await a.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  console.log('tabs:', ctx.pages().map((q) => q.url()), '| contexts:', w.b.contexts().length, '| admin tz:', tz, '| state:', JSON.stringify(S));
  await w.b.close(); process.exit(0);
})().catch((e) => { console.error('PREROLL FAILED:', e.message.split('\n')[0]); process.exit(1); });
