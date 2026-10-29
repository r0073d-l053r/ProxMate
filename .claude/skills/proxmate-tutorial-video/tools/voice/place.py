# Lay the narration over the finished picture: each line starts at its chapter's start + `at`
# (seconds of the finished video), the voice is mixed into one track, loudness-normalised like part one
# (-16 LUFS), and muxed with the existing video stream untouched. Also writes the captions: one per sentence,
# or per comma-separated piece of a long one (timed from the audio by align.py), at most two rows each.
# usage: place.py <voice dir with manifest.json> <picture.mp4> <out.mp4>
#   needs <picture>.chapters.json beside the picture ({"chapters": [[offset seconds, chapter id], ...]});
#   writes out.mp4 and, beside it, out.narration.wav (the voice track before loudness normalising) and out.srt.
#   Needs ffmpeg/ffprobe; plain python3 is enough (no venv packages).
import json, os, subprocess, sys, wave, array
vdir, pic, out = sys.argv[1:4]
SR = 24000
man = json.load(open(f"{vdir}/manifest.json"))["lines"]
chap = json.load(open(os.path.splitext(pic)[0] + ".chapters.json"))
off = {c: t for t, c in chap["chapters"]}
dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", pic], capture_output=True, text=True).stdout)
buf = array.array("f", [0.0]) * int(dur * SR + SR)
cues, problems = [], []
for ln in sorted(man, key=lambda l: off[l["chapter"]] + l["at"]):
    t0 = off[ln["chapter"]] + ln["at"]
    with wave.open(f"{vdir}/{ln['file']}") as w:
        assert w.getframerate() == SR and w.getsampwidth() == 2
        x = array.array("h", w.readframes(w.getnframes()))
    o = int(round(t0 * SR))
    for j, v in enumerate(x):
        if o + j < len(buf): buf[o + j] += v / 32768.0
    items = ln.get("cues") or [{"text": s, "start": ln["sentence_starts"][k]} for k, s in enumerate(ln["sentences"])]
    for k, it in enumerate(items):
        a = t0 + it["start"]
        z = t0 + (items[k + 1]["start"] - 0.05 if k + 1 < len(items) else ln["dur"])
        cues.append((a, z, it["text"]))
# A comma piece shorter than 1.4 s would only flash up, so it rejoins the rest of its sentence.
i = 0
while i < len(cues):
    a, z, s = cues[i]
    if z - a < 1.4 and (s.endswith(",") or (i and cues[i - 1][2].endswith(","))):
        j = i if s.endswith(",") else i - 1  # merge cue j with cue j + 1
        cues[j:j + 2] = [(cues[j][0], cues[j + 1][1], cues[j][2] + " " + cues[j + 1][2])]; i = max(0, j - 1); continue
    i += 1
# A comma piece that reads faster than 20 characters a second rejoins its neighbour from the same sentence
# when the joined caption still fits two rows (100 characters) and reads at 20 or slower.
i = 0
while i < len(cues):
    a, z, s = cues[i]; done = False
    if len(s) / (z - a) > 20:
        for j in ([i - 1] if i and cues[i - 1][2].endswith(",") else []) + ([i] if s.endswith(",") and i + 1 < len(cues) else []):
            t = cues[j][2] + " " + cues[j + 1][2]; d = cues[j + 1][1] - cues[j][0]
            if len(t) <= 100 and len(t) / d <= 20: cues[j:j + 2] = [(cues[j][0], cues[j + 1][1], t)]; done = True; break
    i = i if done else i + 1
for (a, z, s), (b, _, s2) in zip(cues, cues[1:]):
    if b < z - 0.01: problems.append(f"overlap {z - b:.2f}s: '{s[:40]}' / '{s2[:40]}'")
# Readability: a caption may stay up into the silence after its sentence, until it reads at 17 characters a
# second or until 0.1 s before the next caption (0.05 s inside a line), and never ends before its speech does.
CPS = 17.0
# A fast caption that follows silence may also appear up to 0.3 s before its voice does.
for i in range(1, len(cues)):
    a, z, s = cues[i]; gap = a - cues[i - 1][1]
    if len(s) / (z - a) > 18 and gap > 0.2: cues[i] = (a - min(0.3, gap - 0.1), z, s)
for i, (a, z, s) in enumerate(cues):
    nxt = cues[i + 1][0] if i + 1 < len(cues) else dur - 0.1
    lim = nxt - (0.05 if nxt - z < 0.15 else 0.1)
    cues[i] = (a, max(min(z, lim), min(lim, max(z + 0.3, a + len(s) / CPS))), s)
def rows(s, width=42):
    """One row if it fits, otherwise two rows. The break goes near the middle, preferably after a comma,
    never leaves a small word (a, the, I, of...) hanging at the end of the first row, and doesn't split a name."""
    if len(s) <= width: return s
    mid, w = len(s) / 2, s.split(" ")
    weak = {"a", "an", "the", "i", "to", "of", "in", "on", "at", "for", "from", "with", "my", "your", "its", "and", "or", "but", "so", "as"}
    best = None
    for k in range(1, len(w)):
        cut = len(" ".join(w[:k])); top, bot = cut, len(s) - cut - 1
        score = abs(cut - mid) + 2 * max(0, max(top, bot) - width - 4) - (8 if w[k - 1].endswith(",") else 0) + (12 if w[k - 1].lower() in weak else 0)
        if w[k - 1][:1].isupper() and w[k][:1].isupper() and not w[k - 1].endswith(","): score += 12  # don't split a name ("Set Up Your ProxMate", "Template Store")
        if best is None or score < best[0]: best = (score, cut)
    return s[:best[1]] + "\n" + s[best[1] + 1:]

tmp = os.path.splitext(out)[0]
with wave.open(tmp + ".narration.wav", "w") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(array.array("h", [max(-32767, min(32767, int(v * 32767))) for v in buf[: int(dur * SR)]]).tobytes())
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", pic, "-i", tmp + ".narration.wav", "-map", "0:v", "-map", "1:a", "-c:v", "copy",
                "-af", "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000", "-c:a", "aac", "-b:a", "192k", "-ac", "2",
                "-movflags", "+faststart", "-shortest", out], check=True)
def st(t):
    ms = int(round(t * 1000)); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
with open(tmp + ".srt", "w") as f:
    for i, (a, z, s) in enumerate(cues, 1): f.write(f"{i}\n{st(a)} --> {st(z)}\n{rows(s)}\n\n")
print(f"wrote {out}: {len(man)} lines, {len(cues)} captions, {dur:.1f}s")
for p in problems: print("  PROBLEM", p)
