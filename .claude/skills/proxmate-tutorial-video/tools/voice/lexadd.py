# Add words the narration uses to the pronunciation lexicon (eSpeak IPA -> Kokoro phones, as lexgen.py does).
# Each new entry is appended to the built lexicon (PMV_LEXICON) and to lexicon-additions.txt beside this script,
# so build_lexicon.sh keeps it next time. Words already in the lexicon are skipped.
# usage: lexadd.py [--additions FILE] word [word ...]   (lowercase words; needs espeak-ng;
#        env PMV_MODELS for the Kokoro tokens, PMV_LEXICON for the lexicon)
import os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.dirname(HERE))
import pmv_env
K = pmv_env.require(pmv_env.KOKORO_DIR, "Kokoro model"); LEX = pmv_env.require(pmv_env.LEXICON, "pronunciation lexicon")
args = sys.argv[1:]; ADDS = os.path.join(HERE, "lexicon-additions.txt")
if args[:1] == ["--additions"]: ADDS, args = args[1], args[2:]
tokens = set(l.split(" ")[0] for l in open(f"{K}/tokens.txt", encoding="utf-8") if l.strip())
FIX = {"doo": "dˈu"}
def to_kokoro(ipa):
    s = ipa.replace("ː", "")
    for a, b in (("eɪ", "A"), ("aɪ", "I"), ("oʊ", "O"), ("əʊ", "O"), ("aʊ", "W"), ("ɔɪ", "Y"), ("tʃ", "ʧ"), ("dʒ", "ʤ"), ("ɝ", "ɜɹ"), ("r", "ɹ"), ("ɑ̃", "ɑ"), ("g", "ɡ")):
        s = s.replace(a, b)
    return "".join(c for c in s if c in tokens)
have = set(l.split(" ", 1)[0] for l in open(LEX, encoding="utf-8"))
add = []
for w in args:
    if w in have: continue
    ph = FIX.get(w) or to_kokoro(subprocess.run(["espeak-ng", "-v", "en-us", "-q", "--ipa", w], capture_output=True, text=True).stdout.strip().split()[0])
    add.append(f"{w} {' '.join(ph)}"); print(w, "->", ph)
if add:
    for path in (LEX, ADDS):
        with open(path, "a", encoding="utf-8") as f: f.write("\n".join(add) + "\n")
