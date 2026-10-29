// Find how page (viewport) coordinates map to screen coordinates for the desktop Chromium window.
// Puts a magenta marker at page (200, 150), screenshots the X screen and prints the window metrics plus where the
// marker landed on screen (compare with web.cjs metrics()). usage: node calib.cjs [screenshot.png]
// (default $PMV_WORK/cal.png; env PMV_CDP, default http://127.0.0.1:9222; PMV_DISPLAY, default :1)
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const os = require('os'); const path = require('path');
const CDP = process.env.PMV_CDP || 'http://127.0.0.1:9222';
const DISPLAY = process.env.PMV_DISPLAY || ':1';
const SHOT = process.argv[2] || path.join(process.env.PMV_WORK || path.join(os.homedir(), 'pmv', 'work'), 'cal.png');
const { PNG } = (() => { try { return require('pngjs'); } catch { return {}; } })();
(async () => {
  const b = await chromium.connectOverCDP(CDP);
  const ctx = b.contexts()[0]; const p = ctx.pages().find((q) => !q.url().startsWith('devtools')) || ctx.pages()[0];
  const m = await p.evaluate(() => ({ sx: screenX, sy: screenY, ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio }));
  await p.evaluate(() => { const d = document.createElement('div'); d.id = '__cal'; d.style.cssText = 'position:fixed;left:200px;top:150px;width:6px;height:6px;background:#ff00ff;z-index:2147483647'; document.documentElement.appendChild(d); });
  await new Promise((r) => setTimeout(r, 400));
  require('fs').mkdirSync(path.dirname(SHOT), { recursive: true });
  execFileSync('import', ['-window', 'root', SHOT], { env: { ...process.env, DISPLAY } });
  await p.evaluate(() => document.getElementById('__cal').remove());
  const out = execFileSync('python3', ['-c', `
import sys
from PIL import Image
im=Image.open(sys.argv[1]).convert('RGB'); w,h=im.size; px=im.load()
for y in range(h):
  for x in range(w):
    if px[x,y]==(255,0,255): print(x,y); raise SystemExit
print('none')`, SHOT]).toString().trim();
  console.log(JSON.stringify({ ...m, marker: out }));
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
