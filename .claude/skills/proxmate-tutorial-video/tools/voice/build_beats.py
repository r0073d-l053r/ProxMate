# Beat sheet for re-writing the narration of a locked cut: every narration slot in the finished cut (where the
# old line sat), how long the picture gives it (output seconds until the next slot or the chapter's end), what was
# said, which waits are sped up, and a frame sheet per chapter so a writer can see what is on screen during each slot.
# usage: build_beats.py <cut.mp4> <take dir> <script.md> [out dir] [--end-card 7.5]
#   cut.mp4: a finished cut with <cut>.chapters.json and <cut>.srt beside it (from the assembler and place.py)
#   take dir: the recording take, with chapters/<id>.json (events with ffStart/ffEnd) and fx-edits.json (add_ff, dissolve)
#   script.md: the committed video script (## <id> · title sections with an [ON SCREEN: ...] note)
#   out dir: default $PMV_WORK; writes beats.json and frames/<chapter>.png
#   --end-card: seconds of end card after the last chapter (default 7.5)
# Needs ffmpeg and Pillow (system python3 is fine).
import argparse, json, os, subprocess, io, sys
from PIL import Image, ImageDraw, ImageFont
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pmv_env
ap = argparse.ArgumentParser(description="Beat sheet and frame sheets for a locked cut.")
ap.add_argument("video"); ap.add_argument("take"); ap.add_argument("script"); ap.add_argument("out", nargs="?", default=pmv_env.WORK)
ap.add_argument("--end-card", type=float, default=7.5)
a = ap.parse_args()
VID, take, out = a.video, a.take, a.out; os.makedirs(f'{out}/frames', exist_ok=True)
ed = json.load(open(f'{take}/fx-edits.json')) if os.path.exists(f'{take}/fx-edits.json') else {}
chap = json.load(open(os.path.splitext(VID)[0] + '.chapters.json')); offs = [(t, c) for t, c in chap['chapters']]
ends = {c: (offs[i + 1][0] if i + 1 < len(offs) else chap['duration'] - a.end_card) for i, (t, c) in enumerate(offs)}
off = dict((c, t) for t, c in offs)
def ts(x): h, m, r = x.split(':'); s, ms = r.split(','); return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000
cues = []
for b in open(os.path.splitext(VID)[0] + '.srt').read().strip().split('\n\n'):
    L = b.split('\n'); a_, z = L[1].split(' --> '); cues.append((ts(a_), ts(z), ' '.join(L[2:])))
# sped-up stretches in output time, per chapter
def spans_for(cid):
    m = json.load(open(f'{take}/chapters/{cid}.json')); ev = m['events']
    ev = ev + [e for a in ed.get('add_ff', {}).get(cid, []) for e in ({'type': 'ffStart', 't': a['from'], 'target': a['target']}, {'type': 'ffEnd', 't': a['to']})]
    ffs = sorted([e for e in ev if e['type'] == 'ffStart'], key=lambda e: e['t']); ffe = sorted([e for e in ev if e['type'] == 'ffEnd'], key=lambda e: e['t'])
    spans = []; cur = 0.0
    for a, b in zip(ffs, ffe):
        spans.append((cur, a['t'], 1.0)); L = b['t'] - a['t']; spans.append((a['t'], b['t'], L / min(a.get('target', 7), L))); cur = b['t']
    spans.append((cur, m['duration'], 1.0)); dd = ed.get('dissolve', {}).get(cid, 0.0)
    o = 0.0; res = []
    for s0, s1, k in spans:
        d = (s1 - s0) / k
        if k > 1.01: res.append((round(off[cid] + o - dd, 2), round(off[cid] + o + d - dd, 2), round(s1 - s0)))
        o += d
    return res
script = open(a.script).read()
onscreen = {}
for part in script.split('\n## ')[1:]:
    cid = part[:3]; i = part.find('[ON SCREEN:'); onscreen[cid] = part[i + 11: part.find(']', i)].strip() if i >= 0 else ''
font = ImageFont.truetype(pmv_env.FONT_REGULAR, 16)
beats = []
for cid in [c for _, c in offs]:
    cs = [c for c in cues if off[cid] - 0.05 <= c[0] < ends[cid] - 0.05]
    ffw = spans_for(cid); slots = []
    for i, (a_, z, text) in enumerate(cs):
        nxt = cs[i + 1][0] if i + 1 < len(cs) else ends[cid]
        slots.append({'slot': f'{cid}-{i + 1:02d}', 'start': round(a_ - off[cid], 2), 'video_start': round(a_, 2), 'seconds_until_next': round(nxt - a_, 2),
                      'old_line': text, 'old_line_seconds': round(z - a_, 2),
                      'fast_forwards_in_slot': [{'from': round(x - off[cid], 2), 'to': round(y - off[cid], 2), 'real_seconds': r} for x, y, r in ffw if a_ <= x < nxt]})
    lead = round(cs[0][0] - off[cid], 2) if cs else None
    beats.append({'chapter': cid, 'title': [l for l in script.split('\n') if l.startswith(f'## {cid}')][0][3:].strip(), 'on_screen': onscreen.get(cid, ''),
                  'chapter_seconds': round(ends[cid] - off[cid], 2), 'silence_before_first_slot': lead, 'slots': slots})
    # frames: one at 35% and one at 80% of each slot
    pts = [(s['slot'], off[cid] + s['start'] + s['seconds_until_next'] * f) for s in slots for f in (0.35, 0.8)]
    tw, th, cols = 480, 270, 4; rows = (len(pts) + cols - 1) // cols
    sh = Image.new('RGB', (tw * cols, (th + 24) * rows), (18, 18, 18)); dr = ImageDraw.Draw(sh)
    for j, (sid, t) in enumerate(pts):
        png = subprocess.run(['ffmpeg', '-loglevel', 'error', '-ss', f'{t:.2f}', '-i', VID, '-frames:v', '1', '-vf', f'scale={tw}:{th}', '-f', 'image2pipe', '-vcodec', 'png', '-'], capture_output=True).stdout
        x0, y0 = (j % cols) * tw, (j // cols) * (th + 24)
        if png: sh.paste(Image.open(io.BytesIO(png)), (x0, y0))
        dr.text((x0 + 4, y0 + th + 2), f'{sid}  {"early" if j % 2 == 0 else "late"}  ({t - off[cid]:.1f}s)', fill=(240, 240, 120), font=font)
    sh.save(f'{out}/frames/{cid}.png')
json.dump(beats, open(f'{out}/beats.json', 'w'), indent=1)
print(sum(len(b['slots']) for b in beats), 'slots in', len(beats), 'chapters')
