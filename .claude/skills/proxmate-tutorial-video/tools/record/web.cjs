// Chromium on the Ubuntu desktop: the DevTools protocol is used only to READ where things are on a
// page (element boxes, URLs, toasts). Every scroll, click and keystroke is a real X11 event from
// xin.cjs, so what the camera sees is exactly what a person would get.
// usage: const { Web } = require('./web.cjs'); const w = await Web.connect(); const p = await w.page((u) => u.includes('/vms'));
//        await w.click(p, p.getByRole('button', { name: 'Deploy' }));      (env PMV_CDP, default http://127.0.0.1:9222)
const { chromium } = require('playwright');
const CDP = process.env.PMV_CDP || 'http://127.0.0.1:9222';
const x = require('./xin.cjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Web {
  static async connect() {
    const w = new Web();
    for (let i = 0; i < 60; i++) {
      try { w.b = await chromium.connectOverCDP(CDP); break; } catch { await sleep(500); }
    }
    if (!w.b) throw new Error('cannot reach Chromium DevTools');
    return w;
  }
  pages() { return this.b.contexts().flatMap((c) => c.pages()); }
  async page(pred, timeout = 30000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const p = this.pages().filter((q) => { try { return pred(q.url()); } catch { return false; } }).pop();
      if (p) { p.setDefaultTimeout(20000); return p; }
      await sleep(200);
    }
    throw new Error('page did not appear');
  }
  // Viewport origin on screen. Chromium draws its own frame: outer minus inner gives the toolbar,
  // and the invisible shadow (left/right equal, bottom 3px wider) disappears when maximized.
  async metrics(p) {
    const m = await p.evaluate(() => ({ sx: screenX, sy: screenY, ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight, z: devicePixelRatio }));
    const side = (m.ow - m.iw * m.z) / 2;
    return { ...m, dx: m.sx + side, dy: m.sy + (m.oh - m.ih * m.z) - (side > 0 ? side + 3 : 0) };
  }
  async rect(p, loc) {
    const l = loc.first(); await l.waitFor({ state: 'visible' });
    const b = await l.boundingBox(); if (!b) throw new Error('no box');
    return b;
  }
  async screen(p, loc, fx = 0.5, fy = 0.5) {
    const m = await this.metrics(p); const b = await this.rect(p, loc);
    return { x: m.dx + (b.x + b.width * fx) * m.z, y: m.dy + (b.y + b.height * fy) * m.z };
  }
  // Scroll with the real mouse wheel until the element sits comfortably in view.
  async reveal(p, loc, { top = 110, bottom = 120, at = null } = {}) {
    let lastY = null;
    // Things in fixed or sticky bars (top nav, sidebars) never scroll: leave them be if on screen.
    const pinned = await loc.first().evaluate((el) => { for (let e = el; e && e !== document.body; e = e.parentElement) { const ps = getComputedStyle(e).position; if (ps === 'fixed' || ps === 'sticky') return true; } return false; }).catch(() => false);
    if (pinned) return;
    for (let i = 0; i < 25; i++) {
      const m = await this.metrics(p); const b = await this.rect(p, loc);
      const lo = Math.min(top, Math.max(0, m.ih / 2 - 60)), hi = Math.max(m.ih - bottom, lo + 120);
      if (b.y >= lo && b.y + Math.min(b.height, hi - lo) <= hi) return;
      // Fixed headers/toasts, or the page cannot scroll further: good enough once it is on screen.
      if (lastY !== null && Math.abs(b.y - lastY) < 2) { if (b.y >= 0 && b.y + Math.min(b.height, 40) <= m.ih) return; throw new Error('cannot scroll element into view'); }
      lastY = b.y;
      const need = b.y < lo ? b.y - lo : b.y + Math.min(b.height, hi - lo) - hi;
      const px = at ? at.x : m.dx + Math.min(Math.max(b.x + 40, 40), m.iw - 40) * m.z;
      const py = at ? at.y : m.dy + m.ih * 0.55 * m.z;
      const cur = x.pointer(); if (Math.hypot(cur.x - px, cur.y - py) > 300) await x.moveTo(px, py);
      const ticks = Math.max(1, Math.min(4, Math.round(Math.abs(need) / 110)));
      await x.scroll(need > 0 ? ticks : -ticks, { delay: 60 }); await sleep(260);
    }
  }
  async move(p, loc, o = {}) { await this.reveal(p, loc, o); const s = await this.screen(p, loc, o.fx, o.fy); await x.moveTo(s.x, s.y, o); }
  async click(p, loc, o = {}) { await this.move(p, loc, o); await x.click(undefined, undefined, o); await sleep(o.after ?? 250); }
  async type(p, loc, text, o = {}) {
    await this.click(p, loc);
    // Do not type until the field really has focus (a busy renderer can lag behind the click).
    const focused = () => loc.first().evaluate((el) => el === document.activeElement || el.contains(document.activeElement)).catch(() => false);
    for (let i = 0; i < 20 && !(await focused()); i++) { await sleep(100); if (i === 9) await this.click(p, loc); }
    if (!(await focused())) throw new Error('field never took focus');
    if (o.clear) { await x.key('ctrl+a'); await sleep(120); await x.key('BackSpace'); await sleep(150); }
    await x.type(text, o); await sleep(o.after ?? 200);
  }
  async select(p, trigger, option, o = {}) {
    await this.click(p, trigger, { after: 450 });
    const opt = p.getByRole('option', { name: option, exact: false }).first();
    await this.click(p, opt, { after: 400, ...o });
  }
  // Address bar, the way people actually do it.
  async go(url, { p = null, waitFor = null } = {}) {
    await x.key('ctrl+l'); await sleep(250); await x.type(url, { cps: 16 }); await sleep(300); await x.key('Delete'); await sleep(120); await x.key('Return');
    if (p) { try { await p.waitForLoadState('load', { timeout: 30000 }); } catch {} }
    if (waitFor) await waitFor();
  }
  async toast(p, re, timeout = 30000) {
    const t = p.locator('[data-sonner-toast]').filter({ hasText: re }).first();
    await t.waitFor({ state: 'visible', timeout }); return (await t.innerText()).trim();
  }
}

// Title-bar buttons of a client-side-decorated window (Chromium or a GTK/libadwaita app).
function captionButtons(id, kind) {
  const r = x.visibleRect(id);
  const cy = kind === 'chromium' ? r.y + (x.isMaximized(id) ? 18 : 20) : r.y + 23;
  const off = kind === 'chromium' ? [23, 63, 103] : [22, 62, 102];
  return { close: { x: r.x + r.w - off[0], y: cy }, max: { x: r.x + r.w - off[1], y: cy }, min: { x: r.x + r.w - off[2], y: cy }, title: { x: r.x + r.w * 0.5, y: cy }, rect: r };
}

module.exports = { Web, captionButtons, sleep };
