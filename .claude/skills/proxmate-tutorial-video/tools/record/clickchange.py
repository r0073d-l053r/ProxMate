# For a click (chapter, logged t): mean grey-level change of the 200x200 area around it, frame by frame,
# against the frame just before the press (press = logged t - LEAD). Use it to check a click against
# fx.click_change's threshold (level=10) before writing a page_change override in fx-edits.json.
# usage: clickchange.py <take dir> <chapter>@<logged t> [...]      e.g. clickchange.py rec/take5 S06@41.2
import json, subprocess, sys
LEAD, R, FPS = 0.07, 100, 30
def profile(take, cid, t, n=16):
    m = json.load(open(f"{take}/chapters/{cid}.json")); e = min((e for e in m["events"] if e["type"] == "click"), key=lambda e: abs(e["t"] - t))
    x, y = min(max(e["x"], R), 1920 - R), min(max(e["y"], R), 1080 - R); t0 = e["t"] - LEAD - 1 / FPS
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-ss", f"{t0:.3f}", "-i", m["file"], "-frames:v", str(n + 1), "-vf", f"crop={2*R}:{2*R}:{x-R}:{y-R}",
                          "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True).stdout
    sz = (2 * R) ** 2; fr = [raw[i:i + sz] for i in range(0, len(raw) - sz + 1, sz)]
    return [round(sum(abs(a - b) for a, b in zip(f, fr[0])) / sz, 1) for f in fr[1:]]
if __name__ == "__main__":
    take = sys.argv[1]
    for spec in sys.argv[2:]:
        cid, t = spec.split("@"); print(spec, profile(take, cid, float(t)))
