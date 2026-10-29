# Render a narration file with Kokoro af_heart at one speed (1.0) for the whole video.
#
# Each line is a short paragraph. It is turned into phonemes with the project lexicon (punctuation and spaces
# kept) and sent to the model in one call, so the voice phrases the whole paragraph with its own commas and
# sentence pauses. The plain-text path of sherpa-onnx 2.0.0 cuts at every comma, voices each piece as if it were
# a sentence, glues pieces under five words together without a space and joins everything with no pause;
# that is what made the old narration sound clipped and run together.
#
# usage: render2.py narration.json outdir
#   narration.json: [{"id": "V03-01", "chapter": "V03", "at": 1.2, "text": "...", "say": "..."(optional)}, ...]
#   writes <id>.wav per line and manifest.json (length, and an estimated start for each sentence, for captions)
#   run with the venv python (setup.sh); env PMV_MODELS (Kokoro model), PMV_LEXICON (pronunciation lexicon)
import json, os, re, sys, numpy as np, soundfile as sf, sherpa_onnx
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.dirname(HERE))
import pmv_env
from sayform import say

K = pmv_env.require(pmv_env.KOKORO_DIR, "Kokoro model"); LEX = pmv_env.require(pmv_env.LEXICON, "pronunciation lexicon")
SPEED, SR = 1.0, 24000
LEXD = {}
for l in open(LEX, encoding="utf-8"):
    p = l.rstrip("\n").split(" ")
    if len(p) > 1 and p[0] not in LEXD: LEXD[p[0]] = "".join(p[1:])
tts = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
    model=f"{K}/model.onnx", voices=f"{K}/voices.bin", tokens=f"{K}/tokens.txt", data_dir=f"{K}/espeak-ng-data",
    lexicon=LEX, lang="en-us"), num_threads=4), max_num_sentences=1))
SID = 3  # af_heart

def phonemes(spoken):
    """Lexicon phonemes for a spoken-form paragraph, with spaces and , . ? kept. Raises on any unknown word."""
    out = []
    for tok in re.findall(r"[A-Za-z']+(?:-[A-Za-z']+)*|[,.?]", spoken):
        if tok in ",.?": out.append(tok); continue
        w = tok.lower(); parts = [w] if w in LEXD else w.split("-")
        missing = [p for p in parts if p not in LEXD]
        if missing: raise ValueError(f"not in the lexicon: {missing} (in: {spoken})")
        out.append((" " if out else "") + " ".join(LEXD[p] for p in parts))
    return "".join(out)

def voice(spoken):
    g = sherpa_onnx.GenerationConfig(); g.sid = SID; g.speed = SPEED
    g.phoneme_codepoints = [[ord(c) for c in phonemes(spoken)]]
    x = np.array(tts.generate(spoken, g).samples, dtype=np.float32)
    nz = np.where(np.abs(x) > 0.003)[0]
    return x[max(0, nz[0] - int(0.05 * SR)): nz[-1] + int(0.15 * SR)] if len(nz) else x

def sentences(t):
    return [s.strip() for s in re.split(r"(?<=[.?])\s+", t.strip()) if s.strip()]

if __name__ == "__main__":
    src, out = sys.argv[1], sys.argv[2]; os.makedirs(out, exist_ok=True)
    lines = json.load(open(src)); man = []
    for ln in lines:
        spoken = ln.get("say") or say(ln["text"])
        x = voice(spoken); dur = len(x) / SR
        shown = sentences(ln["text"])
        # caption starts: proportional to characters, snapped to the nearest pause in the audio
        hop = int(0.01 * SR); env = np.array([np.abs(x[i:i + hop]).max() for i in range(0, max(1, len(x) - hop), hop)])
        quiet = [i * 0.01 for i in range(len(env)) if env[i] < 0.02]
        starts, acc, total = [0.0], 0, sum(len(s) for s in shown)
        for s in shown[:-1]:
            acc += len(s); guess = dur * acc / total
            near = [q for q in quiet if abs(q - guess) < 0.6]
            starts.append(round(min(near, key=lambda q: abs(q - guess)) + 0.05 if near else guess, 3))
        sf.write(f"{out}/{ln['id']}.wav", x, SR)
        man.append({**ln, "say": spoken, "file": f"{ln['id']}.wav", "dur": round(dur, 3), "sentences": shown, "sentence_starts": starts})
        print(f"{ln['id']}: {dur:.2f}s {len(spoken)} chars", file=sys.stderr, flush=True)
    json.dump({"voice": "af_heart", "speed": SPEED, "lines": man}, open(f"{out}/manifest.json", "w"), indent=1)
    print(f"{len(man)} lines, {sum(m['dur'] for m in man):.1f} s of speech")
