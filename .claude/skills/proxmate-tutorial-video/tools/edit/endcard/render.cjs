// Render endcard.html frame-accurately: every CSS animation is paused and set to the exact frame time,
// then screenshotted. usage: node render.cjs <outdir> [onlyTimeSeconds]
// Only needed to change the end card; endcard.mp4 next to this file is the finished one (frames -> MP4: see ../README.md).
const { chromium } = require('playwright');
const path = require('path'); const fs = require('fs');
const FPS = 30, DUR = 7.5;
(async () => {
  const out = process.argv[2]; const only = process.argv[3] !== undefined ? parseFloat(process.argv[3]) : null;
  fs.mkdirSync(out, { recursive: true });
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await p.goto('file://' + path.join(__dirname, 'endcard.html'));
  await p.evaluate(async () => {
    await Promise.all([document.fonts.load('640 148px Geist'), document.fonts.load('420 62px Geist'), document.fonts.load('italic 76px "Instrument Serif"')]);
    await document.fonts.ready; document.getAnimations().forEach((a) => a.pause());
  });
  const ok = await p.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family));
  console.log('fonts loaded:', [...new Set(ok)].join(', '));
  const times = only !== null ? [only] : Array.from({ length: Math.round(DUR * FPS) }, (_, i) => i / FPS);
  for (let i = 0; i < times.length; i++) {
    await p.evaluate((ms) => document.getAnimations().forEach((a) => { a.currentTime = ms; }), times[i] * 1000);
    await p.screenshot({ path: path.join(out, `${String(i).padStart(4, '0')}.png`) });
  }
  await b.close(); console.log('frames', times.length);
})().catch((e) => { console.error(e); process.exit(1); });
