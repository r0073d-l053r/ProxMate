# Turn a narration JSON into the readable script document (same layout as the earlier scripts: one section per
# chapter with its ON SCREEN note, then the narration, one paragraph per line, with the time it starts in the video).
# usage: to_markdown.py narration.json header.md out.md --chapters picture.chapters.json [--beats beats.json]
#   chapters: the cut's chapters.json ({"chapters": [[offset seconds, chapter id], ...]})
#   beats: default $PMV_WORK/beats.json (from build_beats.py; gives each chapter's title and ON SCREEN note)
import argparse, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.dirname(HERE))
import pmv_env
ap = argparse.ArgumentParser(description="Narration JSON to a readable script document.")
ap.add_argument("narration"); ap.add_argument("header"); ap.add_argument("out")
ap.add_argument("--chapters", required=True); ap.add_argument("--beats", default=os.path.join(pmv_env.WORK, "beats.json"))
a = ap.parse_args()
lines = json.load(open(a.narration)); header = open(a.header).read().rstrip() + "\n"
beats = json.load(open(a.beats))
chap = json.load(open(a.chapters))
off = {c: t for t, c in chap["chapters"]}
def mmss(t): return f"{int(t) // 60}:{int(t) % 60:02d}"
out = [header]
for b in beats:
    cid = b["chapter"]; ls = sorted([l for l in lines if l["chapter"] == cid], key=lambda l: l["at"])
    out.append(f"\n## {b['title']}\n\n[ON SCREEN: {b['on_screen']}]\n")
    for l in ls: out.append(f"`{mmss(off[cid] + l['at'])}` {l['text']}\n")
words = sum(len(l["text"].split()) for l in lines)
out.append(f"\n---\n\n{len(lines)} lines, about {words:,} spoken words.\n")
open(a.out, "w").write("\n".join(out))
print(a.out, len(lines), "lines", words, "words")
