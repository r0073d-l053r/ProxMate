# Real fit check from a render2 manifest: each line must end before the next one starts (and before the chapter
# ends), with at least GAP seconds of air.
# usage: fit.py manifest.json [beats.json]   (beats default $PMV_WORK/beats.json, from build_beats.py)
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.dirname(HERE))
import pmv_env
GAP = 0.25
BEATS = sys.argv[2] if len(sys.argv) > 2 else os.path.join(pmv_env.WORK, "beats.json")
END = {b["chapter"]: b["chapter_seconds"] for b in json.load(open(BEATS))}
m = json.load(open(sys.argv[1]))["lines"]; bad = 0
for cid in sorted(set(l["chapter"] for l in m)):
    ls = sorted([l for l in m if l["chapter"] == cid], key=lambda l: l["at"])
    for i, l in enumerate(ls):
        nxt = ls[i + 1]["at"] if i + 1 < len(ls) else END[cid]
        air = nxt - l["at"] - l["dur"]
        if air < GAP: bad += 1; print(f"{l['id']} @{l['at']:.1f}: {l['dur']:.2f}s, {air:+.2f}s before the next line | {l['text']}")
print(f"{bad} lines too tight")
