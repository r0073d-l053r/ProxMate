# Per-line review sheets for a finished cut: 4 frames of the finished video while each narration line plays
# (its start, two points inside, its end), labeled, with the narration text underneath. The QA workflows read them.
# usage: sheets.py <video.mp4> <manifest.json> <chapters.json> [out dir]
#   manifest.json: the render2/align manifest of the voice that is in the video; chapters.json: the cut's
#   {"chapters": [[offset seconds, chapter id], ...]}; out dir default $PMV_WORK/qa.
#   writes <out>/raw/<id>-<k>.png (frames, reused when they exist: delete raw/ after moving lines),
#   <out>/sheets/<id>.jpg and <out>/lines.json (absolute start/end, sentences and sentence starts per line).
# Needs ffmpeg and Pillow (system python3 is fine).
import json, os, subprocess, sys, textwrap
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageDraw, ImageFont
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pmv_env
if len(sys.argv) < 4: sys.exit("usage: sheets.py <video.mp4> <manifest.json> <chapters.json> [out dir]")
VID = sys.argv[1]; Q = sys.argv[4] if len(sys.argv) > 4 else os.path.join(pmv_env.WORK, "qa")
for d in ("raw", "sheets"): os.makedirs(f"{Q}/{d}", exist_ok=True)
man = json.load(open(sys.argv[2]))["lines"]
off = {c: t for t, c in json.load(open(sys.argv[3]))["chapters"]}
F = ImageFont.truetype(pmv_env.FONT_BOLD, 26); G = ImageFont.truetype(pmv_env.FONT_REGULAR, 28)
def mmss(t): return f"{int(t)//60}:{t%60:04.1f}"
jobs, rows = [], []
for l in man:
    t0 = off[l["chapter"]] + l["at"]; d = l["dur"]
    ts = [t0 + 0.1, t0 + d / 3, t0 + 2 * d / 3, t0 + d - 0.1]
    rows.append((l, t0, ts))
    for k, t in enumerate(ts): jobs.append((t, f"{Q}/raw/{l['id']}-{k}.png"))
def grab(j):
    t, p = j
    if not os.path.exists(p):
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", f"{t:.3f}", "-i", VID, "-frames:v", "1", "-vf", "scale=960:540", p], check=True)
with ThreadPoolExecutor(4) as ex: list(ex.map(grab, jobs))
index = []
for l, t0, ts in rows:
    W, H = 1920, 1080; lines = textwrap.wrap(f"{l['id']}  [{mmss(t0)} to {mmss(t0 + l['dur'])}]  {l['text']}", 118)
    img = Image.new("RGB", (W, H + 20 + 36 * len(lines)), (16, 16, 16)); dr = ImageDraw.Draw(img)
    for k, t in enumerate(ts):
        x, y = (k % 2) * 960, (k // 2) * 540; img.paste(Image.open(f"{Q}/raw/{l['id']}-{k}.png"), (x, y))
        lab = f"{['start', '1/3', '2/3', 'end'][k]}  {mmss(t)}  (+{t - t0:.1f}s)"
        dr.rectangle([x, y, x + 12 + 15 * len(lab), y + 38], fill=(0, 0, 0)); dr.text((x + 8, y + 5), lab, font=F, fill=(255, 220, 0))
    for i, s in enumerate(lines): dr.text((16, H + 10 + 36 * i), s, font=G, fill=(255, 255, 255))
    p = f"{Q}/sheets/{l['id']}.jpg"; img.save(p, quality=82)
    index.append({"id": l["id"], "chapter": l["chapter"], "start": round(t0, 2), "end": round(t0 + l["dur"], 2), "text": l["text"], "sentences": l["sentences"],
                  "sentence_starts_abs": [round(t0 + s, 2) for s in l["sentence_starts"]], "sheet": p})
json.dump(index, open(f"{Q}/lines.json", "w"), indent=1); print(len(index), "sheets")
