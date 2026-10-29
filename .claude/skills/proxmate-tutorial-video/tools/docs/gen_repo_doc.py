# Rebuild a committed video script document (docs/video-script-*.md) with the final narration: same lab table, same
# [ON SCREEN] notes and chapter titles, the new lines with the time each starts in the finished video, [FF] markers
# for the long sped-up waits, and the metadata bullets brought up to date. The old "## Hooks" section is dropped.
# usage: gen_repo_doc.py <doc path in repo> narration.json beats.json chapters.json out.md
#          [--repo DIR] [--ref HEAD] [--runtime M:SS] [--voice TEXT] [--narration-note TEXT] [--drop TEXT ...] [--ff-min 40]
#   doc path: e.g. docs/video-script-vms-templates-consoles.md, read from git at --ref (default HEAD) in --repo
#     (default: the git repository this script is in)
#   narration.json: [{"id", "chapter", "at", "text"}]; beats.json: from build_beats.py; chapters.json: the final cut's
#   --runtime: the finished length for the Length bullet (default: chapters.json "duration", rounded, as M:SS)
#   --voice: replaces the "Voice:"/"Voices:" bullet, e.g. "Kokoro `af_heart` at normal speed"; left alone if not given
#   --narration-note: replaces the "Written with:"/"Narration:" bullet; left alone if not given
#   --drop: a sentence to delete from the intro (repeatable), e.g. " The ProxMate IDE is left for its own video."
#   --ff-min: a sped-up wait gets an [FF] marker when it was at least this many real seconds (default 40)
# Part two's call: see examples/part2-gen_repo_doc.txt.
import argparse, json, os, re, subprocess, sys, textwrap
HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser(description="Rebuild a committed video script document with the final narration.")
ap.add_argument("doc"); ap.add_argument("narration"); ap.add_argument("beats"); ap.add_argument("chapters"); ap.add_argument("out")
ap.add_argument("--repo"); ap.add_argument("--ref", default="HEAD"); ap.add_argument("--runtime"); ap.add_argument("--voice")
ap.add_argument("--narration-note"); ap.add_argument("--drop", action="append", default=[]); ap.add_argument("--ff-min", type=float, default=40)
a = ap.parse_args()
repo = a.repo or subprocess.run(["git", "-C", HERE, "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True).stdout.strip()
lines = json.load(open(a.narration)); out = a.out
old = subprocess.run(["git", "-C", repo, "show", f"{a.ref}:{a.doc}"], capture_output=True, text=True, check=True).stdout
beats = {b["chapter"]: b for b in json.load(open(a.beats))}
chap = json.load(open(a.chapters)); off = {c: t for t, c in chap["chapters"]}
def mmss(t): return f"{int(t) // 60}:{int(t) % 60:02d}"
runtime = a.runtime or mmss(round(chap["duration"]))
words = sum(len(l["text"].split()) for l in lines)
# header: keep the lab table, replace the metadata bullets and drop the old hooks section
if "\n## Hooks" in old: head, rest = old.split("\n## Hooks", 1)
else: head, rest = old.split("\n## Lab used in the recording", 1)[0], old
lab = "## Lab used in the recording" + rest.split("## Lab used in the recording", 1)[1].split("\n---\n", 1)[0].split("\nMarkers:", 1)[0]
for s in a.drop: head = head.replace(s, "")
head = re.sub(r"- \*\*Length:\*\*.*\n", f"- **Length:** about {round(words, -1):,} spoken words; the finished video runs {runtime}, end card included, with the real waits sped up\n", head)
if a.voice: head = re.sub(r"- \*\*Voices?:\*\*.*\n", lambda m: f"- **Voice:** {a.voice}\n", head)
if a.narration_note:
    note = textwrap.fill(f"- **Narration:** {a.narration_note}", width=105, subsequent_indent="  ", break_long_words=False, break_on_hyphens=False)
    head = re.sub(r"- \*\*(Written with|Narration):\*\*.*\n(  .*\n)*", lambda m: note + "\n", head)
doc = [head.rstrip() + "\n", lab.rstrip() + "\n",
       "Markers: `[ON SCREEN: ...]` is what the viewer sees. `[FF]` is a real wait that is sped up in the\n"
       "edit, with a small fast-forward badge. The time in front of each line is where it starts in the finished video.\n", "---\n"]
# chapter sections: keep each section's title and ON SCREEN note from the committed doc
secs = re.findall(r"^(## (V\d\d) · .*?)\n\n(\[ON SCREEN: .*?\])\n", old, re.M)
assert len(secs) == len(beats), (len(secs), len(beats))
for title, cid, onscreen in secs:
    ls = sorted([l for l in lines if l["chapter"] == cid], key=lambda l: l["at"])
    ffs = [f for s in beats[cid]["slots"] for f in s["fast_forwards_in_slot"] if f["real_seconds"] >= a.ff_min]
    body = []
    for l in ls:
        for f in [f for f in ffs if f["from"] <= l["at"]]: body.append("[FF]\n"); ffs.remove(f)
        body.append(f"`{mmss(off[cid] + l['at'])}` {l['text']}\n")
    body += ["[FF]\n" for _ in ffs]
    # American English for the ON SCREEN notes too (the narration style guide bans "untick" and "bin")
    onscreen = onscreen.replace("untick ", "uncheck ").replace("the bin", "the trash icon").replace("The bin", "The trash icon")
    doc.append(f"{title}\n\n{onscreen}\n\n" + "\n".join(body))
endcard = "## End card" + old.split("## End card", 1)[1]
doc.append(endcard.rstrip() + "\n")
open(out, "w").write("\n".join(doc))
print(out, len(lines), "lines", words, "words")
