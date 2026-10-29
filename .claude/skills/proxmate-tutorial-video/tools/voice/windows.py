# Writing aid: for each narration line, the window the picture gives it (until the next line or the chapter's end)
# and the most words that fit at af_heart's pace (3.25 words a second, 0.25 s per extra sentence, 0.45 s of air).
# usage: windows.py narration.json [beats.json]   (beats default $PMV_WORK/beats.json, from build_beats.py)
# prints: id, window seconds, words now, max words, slack (negative = too long), text
import json, os, sys, re
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.dirname(HERE))
import pmv_env
B = {b["chapter"]: b for b in json.load(open(sys.argv[2] if len(sys.argv) > 2 else os.path.join(pmv_env.WORK, "beats.json")))}
d = json.load(open(sys.argv[1]))
by = {}
for x in d: by.setdefault(x['chapter'], []).append(x)
for c, ls in by.items():
  ls.sort(key=lambda l: l['at'])
  for i, l in enumerate(ls):
    win = (ls[i + 1]['at'] if i + 1 < len(ls) else B[c]['chapter_seconds']) - l['at']
    ss = [s for s in re.split(r"(?<=[.?])\s+", l['text'].strip()) if s]
    w = len(l['text'].split())
    mx = (win - 0.45 - 0.25 * (len(ss) - 1)) * 3.25
    print(f"{l['id']} win={win:5.2f} w={w:2d} max={mx:4.1f} slack={mx-w:4.1f} | {l['text']}")
