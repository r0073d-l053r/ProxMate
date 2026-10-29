# Turn a render2.py voice folder into the narration folder the recorder (../record/stage.cjs) and the
# assembler (../edit/assemble.py) read: the older manifest format {voice, speed, segments: [{id, title,
# items: [{text, file, dur}]}]}, one segment per chapter in script order. The WAVs are hard-linked (copied if
# that fails), so the recorder paces itself with exactly the clips the final narration uses.
# usage: to_recorder.py <render2 voice dir> <out dir> [titles.json]
#   titles.json: optional {"V01": "Cold open", ...} for the recorder's log lines
import json, os, shutil, sys

src, out = sys.argv[1], sys.argv[2]
titles = json.load(open(sys.argv[3])) if len(sys.argv) > 3 else {}
man = json.load(open(f"{src}/manifest.json"))
os.makedirs(out, exist_ok=True)
segs = {}
for l in man["lines"]:  # render2 keeps the narration file's order
    seg = segs.setdefault(l["chapter"], {"id": l["chapter"], "title": titles.get(l["chapter"], l["chapter"]), "items": []})
    seg["items"].append({"text": l["text"], "file": l["file"], "dur": l["dur"]})
    dst = f"{out}/{l['file']}"
    if not os.path.exists(dst):
        try: os.link(f"{src}/{l['file']}", dst)
        except OSError: shutil.copy2(f"{src}/{l['file']}", dst)
json.dump({"voice": man.get("voice", "af_heart"), "speed": man.get("speed", 1.0), "segments": list(segs.values())},
          open(f"{out}/manifest.json", "w"), indent=1)
print(f"{out}/manifest.json: {len(segs)} chapters, {len(man['lines'])} lines")
