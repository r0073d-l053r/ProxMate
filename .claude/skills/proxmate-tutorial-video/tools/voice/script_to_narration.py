# Turn a video script document (docs/video-script-<slug>.md) into the narration file the voice tools read:
# [{"id": "V02-01", "chapter": "V02", "at": 0.0, "text": "..."}], in script order. The script's body starts after
# the first "---" line; each "## Vnn · title" section holds an [ON SCREEN: ...] note, [FF] markers and one
# narration line per paragraph (a leading `m:ss` start time, as in the regenerated repo doc, is dropped).
# `at` is 0 until there is a cut: build_beats.py and windows.py give the real times in step 9.
# usage: script_to_narration.py <script.md> <narration.json> [titles.json]
#   titles.json (optional): also writes {"V01": "Cold open", ...} for to_recorder.py
import json, re, sys

doc = open(sys.argv[1], encoding="utf-8").read()
body = doc.split("\n---\n", 1)[1] if "\n---\n" in doc else doc
lines, titles, cid, n = [], {}, None, 0
for raw in body.splitlines():
    s = raw.strip()
    m = re.match(r"^## (V\d\d) · (.+)$", s)
    if m: cid, n = m.group(1), 0; titles[cid] = m.group(2).strip(); continue
    if s.startswith("## "): cid = None; continue  # the end card and anything after the chapters
    if not cid or not s or s.startswith("["): continue
    text = re.sub(r"^`\d+:\d\d`\s+", "", s)
    n += 1; lines.append({"id": f"{cid}-{n:02d}", "chapter": cid, "at": 0.0, "text": text})
json.dump(lines, open(sys.argv[2], "w"), indent=1)
if len(sys.argv) > 3: json.dump(titles, open(sys.argv[3], "w"), indent=1)
print(f"{sys.argv[2]}: {len(lines)} lines in {len(titles)} chapters")
