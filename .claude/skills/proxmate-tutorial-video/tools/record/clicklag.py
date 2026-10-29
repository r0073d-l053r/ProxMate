# How late is each logged click? For every click, find the first frame (in the lossless capture) where the
# 120x120 area around the pointer changes, searching 0.4 s before to 0.3 s after the logged time.
# This lag is what ripple_lead in fx-edits.json corrects for.
# usage: clicklag.py <take dir> <chapter id> [chapter id...]
import json, subprocess, sys, statistics
take = sys.argv[1]; chs = sys.argv[2:]
FPS = 30; R = 60
def frames(src, t0, n, x, y):
    x0, y0 = max(0, x - R), max(0, y - R)
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-ss", f"{max(0,t0):.3f}", "-i", src, "-frames:v", str(n), "-vf", f"crop={2*R}:{2*R}:{x0}:{y0}", "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True).stdout
    sz = (2 * R) ** 2; return [raw[i:i + sz] for i in range(0, len(raw) - sz + 1, sz)]
lags = []
for c in chs:
    m = json.load(open(f"{take}/chapters/{c}.json"))
    for e in m["events"]:
        if e["type"] != "click": continue
        x, y = min(max(e["x"], R), 1920 - R), min(max(e["y"], R), 1080 - R)
        t0 = e["t"] - 0.4; fr = frames(m["file"], t0, int(0.7 * FPS), x, y)
        # the pointer itself moves into place before the click: ignore changes until it has been still 2 frames
        diffs = [sum(abs(a - b) for a, b in zip(fr[i], fr[i - 1])) / len(fr[i]) for i in range(1, len(fr))]
        still = next((i for i in range(2, len(diffs)) if diffs[i - 1] < 0.05 and diffs[i - 2] < 0.05), None)
        first = next((i for i in range(still or 0, len(diffs)) if diffs[i] > 0.4), None) if still is not None else None
        if first is None: continue
        t_change = t0 + (first + 1) / FPS; lags.append(e["t"] - t_change)
        print(f"{c} t={e['t']:.2f} ({e['x']},{e['y']}) first change {t_change:.2f}  lag {e['t'] - t_change:+.3f}")
print(f"n={len(lags)} median lag {statistics.median(lags):+.3f}s  quartiles {statistics.quantiles(lags, n=4)}")
