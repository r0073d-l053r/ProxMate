// Keep every Chromium page (incognito windows included) on the desktop clock's time zone.
// The lab clock is a fixed-offset zone ICU does not know, so Chromium falls back to UTC and ProxMate's
// "Created" and "Expires" times disagree with the top bar. This pins each page to the same offset
// (DevTools time-zone override, e.g. "GMT-09:51"); it holds while this process stays attached.
// Run in the background for the whole take: node tzpin.cjs   (prints one line per pinned page; env PMV_CDP, default http://127.0.0.1:9222)
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const CDP = process.env.PMV_CDP || 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const zoneId = () => { const z = execFileSync('date', ['+%z'], { encoding: 'utf8' }).trim(); return `GMT${z.slice(0, 3)}:${z.slice(3)}`; };

(async () => {
  let b = null;
  for (;;) { try { b = await chromium.connectOverCDP(CDP); break; } catch { await sleep(1000); } }
  const pinned = new Map(); // page -> { session, id }
  for (;;) {
    const id = zoneId();
    for (const ctx of b.contexts()) for (const p of ctx.pages()) {
      const cur = pinned.get(p); if (cur && cur.id === id) continue;
      try {
        const session = cur ? cur.session : await ctx.newCDPSession(p);
        await session.send('Emulation.setTimezoneOverride', { timezoneId: id });
        if (!cur) p.on('dialog', () => {}); // leave confirm() prompts on screen for a real click (no auto-dismiss)
        pinned.set(p, { session, id }); console.log(`pinned ${id} ${p.url().slice(0, 80)}`);
        p.once('close', () => pinned.delete(p));
      } catch (e) { /* page still starting or already gone: try again next round */ }
    }
    if (!b.isConnected()) process.exit(0);
    await sleep(200);
  }
})().catch((e) => { console.error('tzpin:', e.message); process.exit(1); });
