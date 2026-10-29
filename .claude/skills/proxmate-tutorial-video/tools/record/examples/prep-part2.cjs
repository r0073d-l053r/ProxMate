// Off-camera pre-roll for tutorial 2: a fresh Chromium (so the 32 px cursor applies), maximized, signed in as
// Alex, one tab tagged 'pm-admin' on the Template Store. usage: PMV_WORK=~/pmv/work/part2 TAKE=t2a node prep-part2.cjs
// env: PMV_WORK, PROXMATE_URL, PMV_CDP, PMV_DISPLAY, PMV_ADMIN_PASSWORD (only if the browser is not signed in yet)
const fs = require('fs');
const os = require('os');
const path = require('path');
const TOOLS = path.join(__dirname, '..');
const x = require(path.join(TOOLS, 'xin.cjs'));
const { captionButtons } = require(path.join(TOOLS, 'web.cjs'));
const { chromium } = require('playwright');
const env = (k) => { const v = process.env[k]; if (!v) throw new Error(`set ${k}`); return v; };
const WORK = process.env.PMV_WORK || path.join(os.homedir(), 'pmv', 'work');
const APP = (process.env.PROXMATE_URL || 'http://192.168.1.50:3000').replace(/\/$/, '');
const CDP = process.env.PMV_CDP || 'http://127.0.0.1:9222';
const TAKE = process.env.TAKE || 't2a'; const OUT = `${WORK}/rec/${TAKE}`; fs.mkdirSync(OUT, { recursive: true });
const SF = `${OUT}/state.json`; const S = fs.existsSync(SF) ? JSON.parse(fs.readFileSync(SF, 'utf8')) : {};
(async () => {
  let win = x.windows().find((w) => /chromium/i.test(w.cls));
  if (!win) { await x.click(33, 132); win = await x.waitWindow((w) => /chromium/i.test(w.cls), 30000); await x.sleep(2500); }
  if (!x.isMaximized(win.id)) { const b = captionButtons(win.id, 'chromium'); await x.click(b.max.x, b.max.y); await x.sleep(900); }
  S.adminWin = win.id;
  const b = await chromium.connectOverCDP(CDP); const ctx = b.contexts()[0];
  const pages = ctx.pages(); const p = pages[0] || await ctx.newPage();
  for (const q of pages.slice(1)) await q.close().catch(() => {});
  await p.goto(`${APP}/login`); await p.waitForTimeout(1500);
  if (p.url().includes('/login')) {
    await p.getByLabel(/email/i).fill('alex@example.com'); await p.getByLabel(/password/i).first().fill(env('PMV_ADMIN_PASSWORD'));
    await p.keyboard.press('Enter'); await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 });
  }
  await p.evaluate(() => { window.name = 'pm-admin'; });
  await p.goto(`${APP}/templates`); await p.waitForTimeout(1500);
  await p.evaluate(() => { window.name = 'pm-admin'; });
  fs.writeFileSync(SF, JSON.stringify(S, null, 1));
  console.log('ready:', p.url(), 'window', win.id);
  await x.click(1500, 1000); await x.sleep(300); await x.moveTo(1500, 900); // drops the address bar's focus
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
