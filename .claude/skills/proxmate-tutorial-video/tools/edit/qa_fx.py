#!/usr/bin/env python3
"""Pull review frames for the polished cut: every click ripple and every zoom, at their final-video times.

usage: qa_fx.py <take dir> <final.mp4> <out dir>

For each click: a 640x360 crop around where the ripple lands in the output frame (zoom applied) at +0.10 s
and +0.25 s into the ripple, plus the whole frame at +0.10 s. For each zoom: whole frames before, mid ease-in,
held, mid ease-out and after. index.json lists each image with its chapter, times and the line being spoken.
Also: every narration line near its start and end, silences over 2 s, the cuts between chapters and the end card
(whole frames, 1280 wide). Also checks colour against the lossless capture at moments with no zoom or ripple on screen.
Expects <final>.chapters.json and <final>.srt next to the video (assemble.py writes both) and the end card as
the last 7.5 s. Prints a summary line and a colour line for each chapter it found a clear moment in;
writes <out dir>/index.json and <out dir>/colour.json.
"""
import json, os, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fx
from PIL import Image

take, video, out = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out, exist_ok=True)
chap = json.load(open(os.path.splitext(video)[0] + ".chapters.json"))
offset = {cid: t for t, cid in chap["chapters"]}
srt = open(os.path.splitext(video)[0] + ".srt").read().strip().split("\n\n")

def ts(s):
    h, m, r = s.split(":"); sec, ms = r.split(","); return int(h) * 3600 + int(m) * 60 + int(sec) + int(ms) / 1000
subs = []
for b in srt:
    lines = b.split("\n"); a, z = lines[1].split(" --> "); subs.append((ts(a), ts(z), " ".join(lines[2:])))
def spoken(t):
    cur = [s for a, z, s in subs if a <= t <= z]
    if cur: return cur[0]
    prev = [s for a, z, s in subs if z < t]
    return f"(pause after: {prev[-1]})" if prev else "(before any line)"

def grab(t, path, vf=None):
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{t:.3f}", "-i", video, "-frames:v", "1"]
    if vf: cmd += ["-vf", vf]
    subprocess.run(cmd + [path], check=True)

# the editor's decisions applied by assemble.py (FX=1): ripple lead, dropped ripples, re-timed zooms
EDF = f"{take}/fx-edits.json"; ED = json.load(open(EDF)) if os.path.exists(EDF) else {}
LEAD = ED.get("ripple_lead", 0.0)
index = []; colour_times = []
for cid in [c for _, c in chap["chapters"]]:
    meta = json.load(open(f"{take}/chapters/{cid}.json")); ev = meta["events"]; dur = meta["duration"]
    ev = ev + [e for a in ED.get("add_ff", {}).get(cid, []) for e in ({"type": "ffStart", "t": a["from"], "target": a["target"]}, {"type": "ffEnd", "t": a["to"]})]
    for mv in ED.get("move_say", {}).get(cid, []):
        ev = [dict(e, t=mv["to"]) if e["type"] == "say" and abs(e["t"] - mv["near"]) < 0.3 else e for e in ev]
    ffs = sorted([e for e in ev if e["type"] == "ffStart"], key=lambda e: e["t"]); ffe = sorted([e for e in ev if e["type"] == "ffEnd"], key=lambda e: e["t"])
    spans = []; cur = 0.0
    for a, b in zip(ffs, ffe):
        spans.append((cur, a["t"], 1.0)); length = b["t"] - a["t"]; spans.append((a["t"], b["t"], length / min(a.get("target", 7), length))); cur = b["t"]
    spans.append((cur, dur, 1.0))
    def tmap(t):
        o = 0.0
        for s0, s1, k in spans:
            if t >= s1: o += (s1 - s0) / k
            else: return o + max(0.0, t - s0) / k
        return o
    # a chapter the editor dissolves into is trimmed by that much at its start (assemble.py)
    tmap = (lambda t, _tm=tmap, dd=ED.get("dissolve", {}).get(cid, 0.0): _tm(t) - dd)
    zooms, open_ = [], None
    for e in ev:
        if e["type"] == "zoom": open_ = e
        elif e["type"] == "unzoom" and open_: zooms.append((open_["t"], e["t"], fx.target_box(open_["rect"]), open_["rect"])); open_ = None
    if open_: zooms.append((open_["t"], dur - fx.EASE - 0.1, fx.target_box(open_["rect"]), open_["rect"]))
    for z in ED.get("zooms", {}).get(cid, []):
        zooms = [(z["in"], z["out"], fx.target_box(z.get("rect", r)), z.get("rect", r)) if abs(a - z["near"]) < 0.3 else (a, b, box, r) for a, b, box, r in zooms]
    zooms = sorted(zooms + [(z["in"], z["out"], fx.target_box(z["rect"]), z["rect"]) for z in ED.get("add_zooms", {}).get(cid, [])])
    zl = [(a, b, box) for a, b, box, _ in zooms]
    drop = ED.get("drop_clicks", {}).get(cid, [])
    clicks = []
    for e in ev:
        if e["type"] != "click" or any(abs(e["t"] - d) < 0.05 for d in drop): continue
        ov = next((o for o in ED.get("page_change", {}).get(cid, []) if abs(o["logged"] - e["t"]) < 0.05), None)
        start, cut = fx.ripple_times(meta["file"], e["t"] - LEAD, e["x"], e["y"], **({"dt": ov["dt"]} if ov else {}))
        clicks.append(dict(e, t=start, logged_t=e["t"], cut=cut))
    for a in ED.get("add_clicks", {}).get(cid, []):
        start, cut = (a["t"], None) if a.get("keep_ring") else fx.ripple_times(meta["file"], a["t"], a["x"], a["y"])
        clicks.append({"type": "click", "t": start, "x": a["x"], "y": a["y"], "logged_t": None, "cut": cut, "added": True})
    clicks.sort(key=lambda e: e["t"])
    for n, e in enumerate(clicks):
        for d in (0.10, 0.25):
            t = e["t"] + d; box = fx.view_at(t, zl); s = fx.W / (box[2] - box[0])
            px, py = (e["x"] - box[0]) * s, (e["y"] - box[1]) * s
            cx, cy = min(max(px - 320, 0), fx.W - 640), min(max(py - 180, 0), fx.H - 360)
            T = offset[cid] + tmap(t); name = f"{cid}_click{n:02d}_{int(d*100):02d}.png"
            grab(T, f"{out}/{name}", f"crop=640:360:{cx:.0f}:{cy:.0f}")
            item = {"file": name, "kind": "click-crop", "chapter": cid, "chapter_t": round(t, 2), "video_t": round(T, 2),
                    "ripple_age_s": d, "logged_t": e["logged_t"], "page_change_at": e["cut"] and round(e["cut"], 2), "click_screen_xy": [e["x"], e["y"]], "ripple_in_crop_xy": [round(px - cx), round(py - cy)],
                    "zoom_factor": round(s, 2), "spoken": spoken(T)}
            if d == 0.10:
                full = f"{cid}_click{n:02d}_full.jpg"; grab(T, f"{out}/{full}"); item["full_frame"] = full
            index.append(item)
    for n, (a, b, box, rect) in enumerate(zooms):
        for tag, t in (("before", a - 0.15), ("easein", a + fx.EASE / 2), ("held", a + fx.EASE + 0.6),
                       ("held_end", b - 0.1), ("easeout", b + fx.EASE / 2), ("after", b + fx.EASE + 0.2)):
            T = offset[cid] + tmap(t); name = f"{cid}_zoom{n}_{tag}.jpg"; grab(T, f"{out}/{name}")
            index.append({"file": name, "kind": f"zoom-{tag}", "chapter": cid, "chapter_t": round(t, 2), "video_t": round(T, 2),
                          "target_rect": rect, "zoom_factor": round(fx.W / (box[2] - box[0]), 2), "zoom_hold_s": round(b - a, 2),
                          "spoken": spoken(T)})
    # colour check: a real-time moment with nothing drawn on top
    busy = [(z[0] - 0.1, z[1] + fx.EASE + 0.1) for z in zooms] + [(c["t"] - 0.1, c["t"] + fx.RIPPLE_S + 0.1) for c in clicks]
    for t in [dur * f for f in (0.3, 0.5, 0.7, 0.2, 0.8)]:
        if all(not (x <= t <= y) for x, y in busy) and all(not (a["t"] <= t <= b["t"]) for a, b in zip(ffs, ffe)):
            colour_times.append((cid, t, offset[cid] + tmap(t), meta["file"])); break

# Narration review: every line near its start and end, long silences, the cuts between chapters, the end card.
starts = {c: t for t, c in chap["chapters"]}; order = [c for _, c in chap["chapters"]]
def chapter_at(T): return [c for c in order if starts[c] <= T + 1e-6][-1]
for n, (a, z, s) in enumerate(subs):
    for tag, f in (("a", 0.15), ("b", 0.85)):
        T = a + (z - a) * f; name = f"L{n:03d}{tag}_{chapter_at(T)}.jpg"; grab(T, f"{out}/{name}", "scale=1280:-2")
        index.append({"file": name, "kind": "line", "chapter": chapter_at(T), "video_t": round(T, 2), "line_fraction": f, "spoken": s})
    nxt = subs[n + 1][0] if n + 1 < len(subs) else chap["duration"]
    if nxt - z > 2.0:
        T = (z + nxt) / 2; name = f"L{n:03d}gap_{chapter_at(T)}.jpg"; grab(T, f"{out}/{name}", "scale=1280:-2")
        index.append({"file": name, "kind": "silence", "chapter": chapter_at(T), "video_t": round(T, 2), "silence_s": round(nxt - z, 1), "spoken": spoken(T)})
for c1, c2 in zip(order, order[1:]):
    for k, d in enumerate((-0.25, -0.04, 0.02, 0.25)):
        T = starts[c2] + d; name = f"CUT_{c1}_to_{c2}_{k}.jpg"; grab(T, f"{out}/{name}", "scale=1280:-2")
        index.append({"file": name, "kind": "cut", "chapter": c1 if d < 0 else c2, "video_t": round(T, 2), "spoken": spoken(T)})
endcard = chap["duration"] - 7.5  # the animated end card is the last 7.5 s
for k, T in enumerate((endcard + 0.5, endcard + 3.5, chap["duration"] - 0.3)):
    name = f"END_{k}.jpg"; grab(T, f"{out}/{name}", "scale=1280:-2"); index.append({"file": name, "kind": "endcard", "video_t": round(T, 2)})

json.dump(index, open(f"{out}/index.json", "w"), indent=1)
print(f"{len(index)} images, {sum(i['kind']=='click-crop' for i in index)//2} clicks, {sum(i['kind']=='zoom-held' for i in index)} zooms -> {out}")

rows = []
for cid, t, T, src in colour_times:
    a, b = f"{out}/_c_{cid}_src.png", f"{out}/_c_{cid}_enc.png"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{t:.3f}", "-i", src, "-frames:v", "1", a], check=True)
    grab(T, b, "scale=in_color_matrix=bt709:in_range=tv,format=rgb24")
    A, B = Image.open(a).convert("RGB"), Image.open(b).convert("RGB"); pa, pb = A.load(), B.load(); n = err = mx = bias = 0
    for y in range(40, fx.H, 9):
        for x in range(80, fx.W, 9):
            d = [pb[x, y][i] - pa[x, y][i] for i in range(3)]; n += 1; err += sum(map(abs, d)) / 3; mx = max(mx, *map(abs, d)); bias += d[2] - d[0]
    rows.append((cid, round(t, 1), round(err / n, 2), mx, round(bias / n, 2))); os.remove(a); os.remove(b)
for r in rows: print(f"colour {r[0]} t={r[1]:>6}  mean|err|={r[2]:>5}  max={r[3]:>3}  blue-red bias={r[4]:>5}")
json.dump(rows, open(f"{out}/colour.json", "w"))
