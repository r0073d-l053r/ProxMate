# Write YouTube chapter lines from the assembler's chapters.json: youtube-chapters.txt next to it, and print them.
# YouTube's rules are checked first: the first chapter at 0:00, at least 3 chapters, each at least 10 seconds.
# usage: ytchapters.py titles.json chapters.json [chapters.json ...]
#   titles.json: {"V01": "A VM that comes ready", ...} (the chapter titles viewers see; examples/titles-part2.json)
import json, os, sys
TITLES = json.load(open(sys.argv[1]))
for p in sys.argv[2:]:
    m = json.load(open(p)); ch = m["chapters"]
    lines = [f"{int(t)//3600}:{int(t)%3600//60:02d}:{int(t)%60:02d} {TITLES[c]}" if m["duration"] >= 3600 else f"{int(t)//60:02d}:{int(t)%60:02d} {TITLES[c]}" for t, c in ch]
    short = [(c, round(b[0] - a[0], 1)) for (a, b, c) in [(ch[i], ch[i + 1], ch[i][1]) for i in range(len(ch) - 1)] if b[0] - a[0] < 10]
    assert ch[0][0] == 0 and len(ch) >= 3 and not short and m["duration"] - ch[-1][0] >= 10, short
    open(os.path.join(os.path.dirname(p), "youtube-chapters.txt"), "w").write("\n".join(lines) + "\n")
    print(p, f"{int(m['duration'])//60}:{int(m['duration'])%60:02d}"); print("\n".join(lines))
