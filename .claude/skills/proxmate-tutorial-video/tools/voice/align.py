# Caption timing for a rendered narration (render2 manifest), found from the audio itself.
#  1. Where each later sentence starts inside a multi-sentence line (written back as sentence_starts).
#  2. Captions ("cues"): a sentence longer than two 42-character rows is split at a comma, at the voice's
#     pause for that comma, so no caption needs more than two short rows (written back as cues).
# Kokoro's sentence pauses are no longer than its comma pauses, and stop consonants make short dips too, so a
# pause alone can't tell them apart. Every pause near the expected point is tried as the split, and the one
# whose two halves best match the two halves of the text, by speech recognition (Moonshine), wins.
# usage: align.py <voice dir> [overrides.json]   (run with the venv python; env PMV_MODELS for the Moonshine model)
#   rewrites <voice dir>/manifest.json in place and prints one line per decision.
#   overrides.json (optional; default $PMV_WORK/align-overrides.json when it exists) holds hand measurements for the
#   few spots the search gets wrong; see examples/align-overrides-part2.json:
#   {"starts": [["V12-04", 2, 1.64]], "cues": [["V18-05", 1, [["first piece", null], ["second piece", 2.96]]]]}
import json, glob, os, re, sys, difflib, numpy as np, soundfile as sf, sherpa_onnx
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pmv_env
M = pmv_env.moonshine(); f = lambda n: glob.glob(f"{M}/{n}*")[0]
rec = sherpa_onnx.OfflineRecognizer.from_moonshine(preprocessor=f("preprocess"), encoder=f("encode"), uncached_decoder=f("uncached_decode"),
                                                   cached_decoder=f("cached_decode"), tokens=f("tokens"), num_threads=4)
SR, HOP = 24000, 240
ROW = 42  # characters per caption row; a cue holds at most two rows
# Measured by hand where the pause search picks a stop closure instead of the gap between sentences:
# (line, sentence number) -> start in seconds from the line's start. Loaded from the overrides file ("starts").
OVERRIDE = {}
# Caption pieces measured by hand for a long sentence whose only comma comes too early to split at:
# (line, sentence number) -> [(text, start in seconds from the line's start or None for the sentence's start), ...]
# Loaded from the overrides file ("cues"); the pieces joined with spaces must equal the sentence.
CUE_OVERRIDE = {}
_ov = sys.argv[2] if len(sys.argv) > 2 else os.path.join(pmv_env.WORK, "align-overrides.json")
if len(sys.argv) > 2 or os.path.exists(_ov):
    _o = json.load(open(_ov))
    OVERRIDE = {(i, k): t for i, k, t in _o.get("starts", [])}
    CUE_OVERRIDE = {(i, k): [(tx, st) for tx, st in pieces] for i, k, pieces in _o.get("cues", [])}
norm = lambda t: re.sub(r"[^a-z0-9' ]", " ", t.lower().replace("-", " ")).split()
def heard(x):
    pad = np.zeros(int(0.5 * SR), np.float32); st = rec.create_stream()
    st.accept_waveform(SR, np.concatenate([pad, x, pad])); rec.decode_stream(st); return norm(st.result.text)
# letters only: the voice is given "G P U" and the recogniser writes "GPU" or "pc i", so compare without spaces
def sim(a, b): return difflib.SequenceMatcher(None, "".join(a), "".join(b), autojunk=False).ratio()
def sents(t): return [s for s in re.split(r"(?<=[.?])\s+", t.strip()) if s]

def pauses(x, db=-40, frames=4):
    """(start s, end s) of runs of at least `frames` 10 ms frames quieter than `db` dBFS."""
    rms = np.array([np.sqrt(np.mean(x[i:i + HOP] ** 2)) + 1e-9 for i in range(0, len(x) - HOP, HOP)])
    quiet = 20 * np.log10(rms) < db; runs, i = [], 0
    while i < len(quiet):
        if quiet[i]:
            j = i
            while j < len(quiet) and quiet[j]: j += 1
            if j - i >= frames: runs.append((i * HOP / SR, j * HOP / SR))
            i = j
        else: i += 1
    return runs

def best_split(x, runs, lo, hi, guess, left_t, right_t, reach):
    """The pause between lo and hi (seconds) within `reach` of guess whose halves best match the two texts.
    Returns (score, pause start, pause end) or None. Near-ties go to the longer pause."""
    best = None
    for a, b in runs:
        mid = (a + b) / 2
        if not (lo + 0.3 < mid < hi - 0.3 and abs(mid - guess) < reach): continue
        m = int(mid * SR)
        score = sim(heard(x[int(lo * SR):m]), left_t) + sim(heard(x[m:int(hi * SR)]), right_t)
        if best is None or score > best[0] + 0.02 or (abs(score - best[0]) <= 0.02 and b - a > best[2] - best[1]): best = (score, a, b)
    return best

def comma_parts(shown, spoken):
    """Split one sentence at commas until every part fits two rows. Each split takes the comma that leaves
    the two parts most even, and only if both parts are at least 20 characters. Returns lists of
    (shown text, spoken text) pieces whose joins give back the sentence."""
    if len(shown) <= 2 * ROW: return [(shown, spoken)]
    cs, cp = [i for i, c in enumerate(shown) if c == ","], [i for i, c in enumerate(spoken) if c == ","]
    if len(cs) != len(cp): return [(shown, spoken)]
    opts = [(max(i + 1, len(shown) - i - 2), i, j) for i, j in zip(cs, cp) if i + 1 >= 20 and len(shown) - i - 2 >= 20]
    if not opts: return [(shown, spoken)]
    _, i, j = min(opts)
    return comma_parts(shown[:i + 1], spoken[:j + 1]) + comma_parts(shown[i + 2:], spoken[j + 2:])

vd = sys.argv[1]; man = json.load(open(f"{vd}/manifest.json")); report = []
for l in man["lines"]:
    shown, spoken = l["sentences"], sents(l["say"])
    assert len(shown) == len(spoken), l["id"]
    x, sr = sf.read(f"{vd}/{l['file']}", dtype="float32"); assert sr == SR
    runs = pauses(x)
    # 1. sentence starts
    starts, lo = [0.0], 0.0; total = sum(len(s) for s in spoken)
    for k in range(1, len(spoken)):
        guess = l["dur"] * sum(len(s) for s in spoken[:k]) / total
        hi = l["dur"] * sum(len(s) for s in spoken[:k + 1]) / total + 0.6 if k + 1 < len(spoken) else l["dur"]
        if (l["id"], k + 1) in OVERRIDE: start, note = OVERRIDE[(l["id"], k + 1)], "measured by hand"
        else:
            best = best_split(x, runs, lo, min(hi, l["dur"]), guess, norm(spoken[k - 1]), norm(spoken[k]), 1.5)
            if best is None: start, note = guess, "no pause found, kept the estimate"
            else: start, note = round(best[2] - 0.02, 3), f"score {best[0]:.2f}, pause {1000 * (best[2] - best[1]):.0f} ms"
        report.append(f"{l['id']} s{k + 1}: {l['sentence_starts'][k]:.2f} -> {start:.2f} ({start - l['sentence_starts'][k]:+.2f}) {note}")
        starts.append(start); lo = start
    l["sentence_starts"] = starts
    # 2. cues: long sentences split at a comma pause
    cues = []
    for k, (s_show, s_say) in enumerate(zip(shown, spoken)):
        s0, s1 = starts[k], (starts[k + 1] if k + 1 < len(starts) else l["dur"])
        if (l["id"], k + 1) in CUE_OVERRIDE:
            cues += [{"text": tx, "start": s0 if st is None else st} for tx, st in CUE_OVERRIDE[(l["id"], k + 1)]]
            assert " ".join(tx for tx, _ in CUE_OVERRIDE[(l["id"], k + 1)]) == s_show; report.append(f"{l['id']} s{k + 1}: pieces measured by hand"); continue
        parts = comma_parts(s_show, s_say)
        t = s0; done = 0; since = 0  # since: the first piece after the last cut
        for p, (p_show, p_say) in enumerate(parts):
            if p:
                guess = s0 + (s1 - s0) * done / len(s_say)
                # comma pauses are short and shallow, so look at shallower dips too
                best = best_split(x, runs + pauses(x, -35, 3), t, s1, guess, norm(" ".join(q for _, q in parts[since:p])),
                                  norm(" ".join(q for _, q in parts[p:])), 0.9)
                if best is None:  # no pause the recogniser agrees with: keep this piece with the one before
                    cues[-1]["text"] += " " + p_show; report.append(f"{l['id']} s{k + 1}: no comma pause after '{parts[p - 1][0][-24:]}', kept together")
                    done += len(p_say) + 1; continue
                t = round(best[2] - 0.02, 3); since = p
                report.append(f"{l['id']} s{k + 1}: split after '{parts[p - 1][0][-24:]}' at {t:.2f} (score {best[0]:.2f}, pause {1000 * (best[2] - best[1]):.0f} ms)")
            cues.append({"text": p_show, "start": t}); done += len(p_say) + 1
    l["cues"] = cues
json.dump(man, open(f"{vd}/manifest.json", "w"), indent=1)
print("\n".join(report))
