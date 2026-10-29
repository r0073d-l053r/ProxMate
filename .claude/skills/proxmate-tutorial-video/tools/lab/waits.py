# The real waits the edit speeds up (recorded ffStart/ffEnd markers plus the editor's add_ff in fx-edits.json), with
# their real length: one line per wait longer than its target, "chapter, label, seconds, target".
# usage: python3 waits.py <take dir> [chapter ids...]   (default V01..V20, part two's chapters)
import json, sys
take = sys.argv[1]; ed = json.load(open(f"{take}/fx-edits.json"))
for cid in sys.argv[2:] or [f"V{i:02d}" for i in range(1, 21)]:
    m = json.load(open(f"{take}/chapters/{cid}.json")); ev = m["events"]
    ff = []; o = None
    for e in ev:
        if e["type"] == "ffStart": o = e
        elif e["type"] == "ffEnd" and o: ff.append((o["t"], e["t"], o.get("label", ""), o.get("target", 7))); o = None
    ff += [(a["from"], a["to"], a["label"], a["target"]) for a in ed.get("add_ff", {}).get(cid, [])]
    for a, b, label, tgt in sorted(ff):
        if b - a > tgt + 0.05: print(f"{cid}\t{label}\t{b - a:.0f}\t{tgt}")
