// Real X11 input on the Ubuntu desktop (DISPLAY from PMV_DISPLAY, default :1) for the screen-recorded tutorial.
// Every pointer move, click and keystroke in the video is an actual X event from xdotool, so the
// on-screen cursor, hover states, focus and window manager behave exactly as for a person.
// usage: const x = require('./xin.cjs'); await x.click(400, 300); await x.type('hello');   (env PMV_DISPLAY, default :1)
const { execFileSync, spawnSync } = require('child_process');
const DISPLAY = process.env.PMV_DISPLAY || ':1';
const ENV = { ...process.env, DISPLAY };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);

function xdo(args, opts = {}) {
  const r = spawnSync('xdotool', args, { env: ENV, encoding: 'utf8', timeout: opts.timeout || 120000 });
  if (r.status !== 0 && !opts.quiet) throw new Error(`xdotool ${args.slice(0, 4).join(' ')} failed: ${r.stderr}`);
  return (r.stdout || '').trim();
}

function pointer() {
  const out = xdo(['getmouselocation', '--shell']);
  const m = Object.fromEntries(out.split('\n').map((l) => l.split('=')));
  return { x: +m.X, y: +m.Y };
}

// Human-ish move: eased path with a slight arc, duration scaled by distance.
async function moveTo(x, y, { speed = 1, jitter = 2 } = {}) {
  x = Math.round(x); y = Math.round(y);
  const p = pointer(); const dx = x - p.x; const dy = y - p.y; const dist = Math.hypot(dx, dy);
  if (dist < 2) return;
  const dur = Math.min(900, Math.max(180, 220 + dist * 0.45)) / speed;
  const steps = Math.max(8, Math.round(dur / 12));
  const bend = (Math.random() - 0.5) * Math.min(80, dist * 0.12);
  const nx = -dy / (dist || 1), ny = dx / (dist || 1);
  const args = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps; const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const arc = Math.sin(Math.PI * t) * bend;
    const j = i === steps ? 0 : (Math.random() - 0.5) * jitter;
    args.push('mousemove', String(Math.round(p.x + dx * e + nx * arc + j)), String(Math.round(p.y + dy * e + ny * arc + j)), 'sleep', (dur / steps / 1000).toFixed(3));
  }
  xdo(args);
}

async function click(x, y, { button = 1, double = false, pause = [90, 180] } = {}) {
  if (x !== undefined) await moveTo(x, y);
  await sleep(rnd(...pause));
  xdo(['click', ...(double ? ['--repeat', '2', '--delay', '90'] : []), String(button)]);
  if (module.exports.onClick) module.exports.onClick(pointer(), button); // the recorder logs it for the edit
  await sleep(rnd(60, 140));
}

async function drag(x1, y1, x2, y2) {
  await moveTo(x1, y1); await sleep(rnd(120, 200));
  xdo(['mousedown', '1']); await sleep(rnd(120, 180));
  await moveTo(x2, y2, { speed: 0.8, jitter: 1 }); await sleep(rnd(120, 200));
  xdo(['mouseup', '1']); await sleep(150);
}

async function scroll(clicks, { delay = 70 } = {}) {
  const btn = clicks > 0 ? '5' : '4';
  for (let i = 0; i < Math.abs(clicks); i++) { xdo(['click', btn]); await sleep(delay + Math.random() * 40); }
}

// Typing: human rhythm (slightly faster inside words, pauses after punctuation/spaces).
async function type(text, { cps = 14, minDelay = 25 } = {}) {
  const base = 1000 / cps;
  let buf = '';
  const flush = async (d) => { if (buf) { xdo(['type', '--delay', String(Math.round(d)), '--', buf]); buf = ''; } };
  for (const ch of text) {
    buf += ch;
    if (ch === ' ' || /[.,:;/@!?=-]/.test(ch) || buf.length >= 4) {
      await flush(Math.max(minDelay, base * rnd(0.6, 1.25)));
      if (ch === ' ' || /[.,:;!?]/.test(ch)) await sleep(rnd(20, 120));
    }
  }
  await flush(Math.max(minDelay, base * rnd(0.6, 1.25)));
}

async function key(...combos) { for (const c of combos) { xdo(['key', '--clearmodifiers', c]); await sleep(rnd(60, 130)); } }

function setClipboard(text) {
  // As alex, like copying from a password manager or a text message.
  execFileSync('runuser', ['-u', 'alex', '--', 'env', `DISPLAY=${DISPLAY}`, 'xclip', '-selection', 'clipboard', '-loops', '3'], { input: text, timeout: 5000, stdio: ['pipe', 'ignore', 'ignore'] });
}
function startClipboard(text) {
  const { spawn } = require('child_process');
  const p = spawn('runuser', ['-u', 'alex', '--', 'env', `DISPLAY=${DISPLAY}`, 'xclip', '-selection', 'clipboard'], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
  p.stdin.end(text); p.unref();
}

function windows() {
  const out = spawnSync('wmctrl', ['-lxG'], { env: ENV, encoding: 'utf8' }).stdout || '';
  return out.trim().split('\n').filter(Boolean).map((l) => {
    const p = l.split(/\s+/); return { id: p[0], desk: p[1], x: +p[2], y: +p[3], w: +p[4], h: +p[5], cls: p[6], title: p.slice(8).join(' ') };
  });
}
function activeWindow() { return xdo(['getactivewindow'], { quiet: true }); }
function geometry(id) {
  const out = xdo(['getwindowgeometry', '--shell', String(parseInt(id, 16) || id)]);
  const m = Object.fromEntries(out.split('\n').map((l) => l.split('='))); return { x: +m.X, y: +m.Y, w: +m.WIDTH, h: +m.HEIGHT };
}
async function waitWindow(pred, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const w = windows().find(pred); if (w) return w; await sleep(200); }
  throw new Error('window did not appear');
}

module.exports = { xdo, pointer, moveTo, click, drag, scroll, type, key, setClipboard, startClipboard, windows, activeWindow, geometry, waitWindow, sleep, rnd, DISPLAY, ENV };

// Visible rectangle of a top-level window: X geometry minus the invisible client-side shadow
// (_GTK_FRAME_EXTENTS), so title-bar buttons can be targeted like a person would aim at them.
function visibleRect(id) {
  const wid = String(parseInt(id, 16) || id);
  const info = spawnSync('xwininfo', ['-id', wid], { env: ENV, encoding: 'utf8' }).stdout || '';
  const g = (k) => +((info.match(new RegExp(k + ':\\s+(-?\\d+)')) || [])[1] || 0);
  let [l, r, t, b] = [0, 0, 0, 0];
  const fe = spawnSync('xprop', ['-id', wid, '_GTK_FRAME_EXTENTS'], { env: ENV, encoding: 'utf8' }).stdout || '';
  const m = fe.match(/=\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)/); if (m) [l, r, t, b] = m.slice(1).map(Number);
  const x0 = g('Absolute upper-left X') + l, y0 = g('Absolute upper-left Y') + t;
  return { x: x0, y: y0, w: g('Width') - l - r, h: g('Height') - t - b, frame: { l, r, t, b } };
}
function isMaximized(id) {
  const out = spawnSync('xprop', ['-id', String(parseInt(id, 16) || id), '_NET_WM_STATE'], { env: ENV, encoding: 'utf8' }).stdout || '';
  return /MAXIMIZED_VERT/.test(out) && /MAXIMIZED_HORZ/.test(out);
}
function isMinimized(id) {
  const out = spawnSync('xprop', ['-id', String(parseInt(id, 16) || id), '_NET_WM_STATE'], { env: ENV, encoding: 'utf8' }).stdout || '';
  return /HIDDEN/.test(out);
}
module.exports.visibleRect = visibleRect; module.exports.isMaximized = isMaximized; module.exports.isMinimized = isMinimized;

// Put text on the clipboard and wait until the X selection really serves it (a paste right after a
// cold xclip start can otherwise get the previous, empty clipboard).
async function clipboard(text, timeout = 5000) {
  startClipboard(text); const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    await sleep(150);
    const r = spawnSync('runuser', ['-u', 'alex', '--', 'env', `DISPLAY=${DISPLAY}`, 'xclip', '-o', '-selection', 'clipboard'], { encoding: 'utf8', timeout: 2000 });
    if ((r.stdout || '') === text) return true;
  }
  throw new Error('clipboard never held the text');
}
module.exports.clipboard = clipboard;
