# Transcribe each rendered line (render2 manifest) with Moonshine and score it against what the voice was told
# to say. usage: asr.py <voice dir> [n worst to show]   (run with the venv python; env PMV_MODELS for the model)
import json, sys, os, re, glob, difflib, soundfile as sf, sherpa_onnx
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pmv_env
vd = sys.argv[1]; show = int(sys.argv[2]) if len(sys.argv) > 2 else 20
M = pmv_env.moonshine(); f = lambda n: glob.glob(f"{M}/{n}*")[0]
rec = sherpa_onnx.OfflineRecognizer.from_moonshine(preprocessor=f("preprocess"), encoder=f("encode"), uncached_decoder=f("uncached_decode"),
                                                   cached_decoder=f("cached_decode"), tokens=f("tokens"), num_threads=4)
norm = lambda t: re.sub(r"[^a-z0-9' ]", " ", t.lower().replace("-", " ")).split()
rows = []
for l in json.load(open(f"{vd}/manifest.json"))["lines"]:
    s, sr = sf.read(f"{vd}/{l['file']}", dtype="float32")
    st = rec.create_stream(); st.accept_waveform(sr, s); rec.decode_stream(st); hyp = st.result.text
    a, b = norm(l["say"]), norm(hyp); sm = difflib.SequenceMatcher(None, a, b)
    lost = [" ".join(a[i1:i2]) for op, i1, i2, j1, j2 in sm.get_opcodes() if op in ("delete", "replace")]
    rows.append((sm.ratio(), l["id"], l["say"], hyp, lost))
rows.sort()
for r, i, t, h, lost in rows[:show]: print(f"{r:.2f} {i}\n   said:  {t}\n   heard: {h}\n   diff:  {lost}")
print("mean", round(sum(r[0] for r in rows) / len(rows), 3), "n", len(rows))
