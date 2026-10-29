# Spoken form of a narration line for Kokoro (the spoken forms in spoken_forms.py, plus numbers as words),
# and a check for words the pronunciation lexicon lacks (Kokoro skips those silently).
# usage: sayform.py "line one" ["line two" ...]   prints each spoken form and its out-of-lexicon words
#        (env PMV_LEXICON, default ~/pmv/models/lexicon-us-en-lab.txt)
import os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.dirname(HERE))
import pmv_env
from spoken_forms import spoken

LEX = pmv_env.require(pmv_env.LEXICON, "pronunciation lexicon")
WORDS = set(l.split(" ", 1)[0] for l in open(LEX, encoding="utf-8"))
ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()

def num(n):
    if n < 20: return ONES[n]
    if n < 100: return TENS[n // 10] + ("" if n % 10 == 0 else " " + ONES[n % 10])
    if n < 1000: return ONES[n // 100] + " hundred" + ("" if n % 100 == 0 else " " + num(n % 100))
    return " ".join(ONES[int(d)] for d in str(n))

def say(text):
    t = spoken(text)
    t = re.sub(r"\b(\d+)\s?GB\b", lambda m: f"{num(int(m.group(1)))} gigabytes", t)
    t = re.sub(r"\b(\d+)\s?MB\b", lambda m: f"{num(int(m.group(1)))} megabytes", t)
    t = re.sub(r"\b\d+\b", lambda m: num(int(m.group(0))), t)
    return t

def oov(s):
    bad = []
    for w in s.split():
        w0 = w.strip(".,!?;:\"()…—'").lower()
        if not w0 or w0 in WORDS: continue
        parts = [p for p in re.split(r"-", w0) if p]
        if len(parts) > 1 and all(p in WORDS for p in parts): continue
        bad.append(w0)
    return bad

if __name__ == "__main__":
    for line in sys.argv[1:]:
        s = say(line); print(s, "| OOV:", oov(s))
