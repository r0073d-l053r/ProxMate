// Recording stage: lossless capture of the real X11 desktop per chapter, a virtual narrator that
// schedules narration lines against what actually happens on screen, and fast-forward markers.
// usage: const { Chapter, loadNarration, WORK } = require('./stage.cjs');
//        const c = new Chapter('S02', loadNarration(voiceDir), `${WORK}/rec/take1/chapters`); await c.begin(); await c.say(0); ... await c.end();
// env: PMV_WORK (per-video working folder, default ~/pmv/work), PMV_DISPLAY (default :1)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const x = require('./xin.cjs');
const WORK = process.env.PMV_WORK || path.join(os.homedir(), 'pmv', 'work');
const D = WORK; // older recorders import it as D
// alex's uid, for waitingForInput (30033 on the original rig)
const ALEX_UID = (() => { const r = spawnSync('id', ['-u', 'alex'], { encoding: 'utf8' }); return r.status === 0 ? +r.stdout.trim() : 30033; })();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(T(), ...a);

function loadNarration(voiceDir) {
  return JSON.parse(fs.readFileSync(path.join(voiceDir, 'manifest.json'), 'utf8'));
}

class Chapter {
  constructor(id, man, outDir) {
    this.id = id; this.seg = man.segments.find((s) => s.id === id);
    if (!this.seg) throw new Error(`no narration for ${id}`);
    this.lines = this.seg.items.filter((i) => !i.ff);
    this.outDir = outDir; this.events = []; this.speechEnd = 0; this.next = 0; this.ffOpen = null;
  }

  async begin() {
    fs.mkdirSync(this.outDir, { recursive: true });
    this.file = path.join(this.outDir, `${this.id}.mkv`);
    // Lossless RGB capture of the whole screen, real pointer included (draw_mouse).
    this.ff = spawn('ffmpeg', ['-y', '-loglevel', 'info', '-f', 'x11grab', '-draw_mouse', '1', '-framerate', '30', '-video_size', '1920x1080', '-i', x.DISPLAY,
      '-c:v', 'libx264rgb', '-preset', 'ultrafast', '-crf', '0', '-g', '120', this.file], { env: { ...process.env, DISPLAY: x.DISPLAY }, stdio: ['pipe', 'ignore', 'pipe'] });
    this.t0 = null; let err = '';
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('ffmpeg did not start')), 15000);
      this.ff.stderr.on('data', (d) => {
        err += d.toString();
        // x11grab stamps frames with the wall clock: "start: 1761451234.567890" is the first frame's capture time.
        const m = err.match(/start: (\d+\.\d+)/);
        if (m && this.t0 === null) { this.t0 = parseFloat(m[1]) * 1000; clearTimeout(to); resolve(); }
      });
      this.ff.on('exit', (c) => { if (this.t0 === null) reject(new Error('ffmpeg exited ' + c + ' ' + err.slice(-400))); });
    });
    log(`--- ${this.id} ${this.seg.title}  (capture ${path.basename(this.file)})`);
    this.speechEnd = this.now();
  }

  now() { return (Date.now() - this.t0) / 1000; }

  // Start narration line `i` (index among spoken lines, or a substring of its text) once the previous
  // line has finished, plus a natural breath. Returns immediately: actions happen while it plays.
  async say(i, { gap = 0.35, at = null } = {}) {
    const idx = typeof i === 'number' ? i : this.lines.findIndex((l) => l.text.includes(i));
    if (idx < 0) throw new Error(`${this.id}: no line matching ${i}`);
    const line = this.lines[idx];
    const ready = Math.max(this.speechEnd + gap, at === null ? 0 : at);
    const w = ready - this.now(); if (w > 0) await sleep(w * 1000);
    const t = this.now(); this.events.push({ type: 'say', idx, file: line.file, t, dur: line.dur, text: line.text });
    this.speechEnd = t + line.dur; this.next = idx + 1;
    return line;
  }

  // Wait until the current line has finished playing (optionally leave a little air after it).
  async quiet(after = 0) { const w = this.speechEnd + after - this.now(); if (w > 0) await sleep(w * 1000); }

  // Wait until `frac` of the current line has played, to land an action on a specific word.
  async during(frac) { const last = this.events.filter((e) => e.type === 'say').pop(); if (!last) return; const w = last.t + last.dur * frac - this.now(); if (w > 0) await sleep(w * 1000); }

  // Ask the edit to ease in on a screen rectangle [x, y, w, h], and back out (see edit/fx.py).
  zoom(rect) { if (this.t0 !== null) this.mark('zoom', { rect: rect.map((v) => Math.round(v)) }); }
  unzoom() { if (this.t0 !== null) this.mark('unzoom'); }

  mark(type, extra = {}) { const ev = { type, t: this.now(), ...extra }; this.events.push(ev); return ev; }
  ffStart(label, target = 7) { this.ffOpen = this.mark('ffStart', { label, target }); log(`  >> fast-forward: ${label}`); }
  ffEnd() { const ev = this.mark('ffEnd'); log(`  << fast-forward done after ${(ev.t - this.ffOpen.t).toFixed(1)}s`); this.ffOpen = null; this.speechEnd = Math.max(this.speechEnd, ev.t); }

  async end(tail = 1.2) {
    await this.quiet(tail);
    const tEnd = this.now();
    this.ff.stdin.write('q'); this.ff.stdin.end();
    await new Promise((r) => this.ff.on('exit', r));
    const meta = { id: this.id, title: this.seg.title, file: this.file, duration: tEnd, events: this.events };
    fs.writeFileSync(path.join(this.outDir, `${this.id}.json`), JSON.stringify(meta, null, 1));
    log(`=== ${this.id} done, ${tEnd.toFixed(1)}s`);
    return meta;
  }
}

// Terminal state helpers: a PROMPT_COMMAND in alex's .bashrc stamps ~/.cache/prompt-<host> each time a
// prompt is drawn, so the recorder can tell when a command has finished without reading the screen.
function promptStamp(host) {
  try { return fs.statSync(`/home/alex/.cache/prompt-${host}`).mtimeMs; } catch { return 0; }
}
async function waitPrompt(host, since, timeout = 600000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (promptStamp(host) > since) return; await sleep(150); }
  throw new Error(`prompt on ${host} did not return`);
}
// True when some process of alex whose command line matches `re` is blocked reading its terminal.
function waitingForInput(re) {
  for (const pid of fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try {
      const st = fs.statSync(`/proc/${pid}`); if (st.uid !== ALEX_UID) continue;
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      if (!re.test(cmd)) continue;
      const wchan = fs.readFileSync(`/proc/${pid}/wchan`, 'utf8');
      if (/tty|wait_woken|n_tty_read/.test(wchan)) return true;
    } catch { /* gone */ }
  }
  return false;
}
async function waitInput(re, timeout = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (waitingForInput(re)) return; await sleep(200); }
  throw new Error('process never asked for input: ' + re);
}

module.exports = { Chapter, loadNarration, waitPrompt, promptStamp, waitingForInput, waitInput, log, sleep, D, WORK };
