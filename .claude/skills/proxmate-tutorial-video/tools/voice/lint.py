# Mechanical checks for a narration file (the rules are in docs/narration-style-guide.md).
# usage: lint.py narration.json [--beats beats.json | --no-fit] [--quiet]   (beats default $PMV_WORK/beats.json, from build_beats.py)
# narration.json: [{"id", "chapter", "at", "text"}], `at` = seconds from the chapter's start in the finished video.
# --no-fit: before there is a cut (no beats, no `at`), check the wording only, in file order.
# Prints one line per problem; exit code 1 if there is any ERROR. Fit here is an estimate: the render and fit.py decide.
import argparse, json, os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.dirname(HERE))
import pmv_env
from sayform import say, oov

def load_beats(path): return {b["chapter"]: b for b in json.load(open(path))}
BEATS = None  # chapter -> beat; set BEATS = load_beats(path) before calling check(); None skips the fit checks
RATE = 3.25          # af_heart at speed 1.0, words per second of speech
BANNED = ("delve tapestry testament landscape realm crucial pivotal vital robust seamless seamlessly streamline leverage harness utilize "
          "enhance elevate empower unlock unleash foster garner showcase intricate nuanced multifaceted interplay meticulous comprehensive "
          "insights notably additionally moreover furthermore importantly interestingly certainly actually quietly deeply fundamentally "
          "remarkably arguably cutting-edge groundbreaking transformative vibrant journey embark ensure various effortless magic awesome "
          "simply easy easily gonna wanna favourite tick untick bin").split()
PHRASES = [r"\bnot just\b", r"\bnot only\b", r"\bit'?s not\b[^.]*,\s*it'?s\b", r"\bdoesn'?t just\b", r"\bhere'?s the (thing|deal|kicker|catch)\b",
           r"\bhere'?s where\b", r"\blet'?s (dive|break this|unpack|explore)\b", r"\bwithout further ado\b", r"^(honestly|look|okay so|real talk)\b",
           r"\b(serves|stands|acts) as\b", r"\bboasts\b", r"\bplays a (crucial|key|vital|pivotal) role\b", r"\bit'?s (worth noting|important to)\b",
           r"\bin (summary|conclusion)\b", r"\bto sum up\b", r"\bat its core\b", r"\beverything starts\b", r"\bsimple as that\b",
           r"\blike it never happened\b", r"\bthree ways\b", r"\btwo (things|ways|reasons)\b", r"\bjust (click|pick|type|hit)\b",
           r"\bas you can see\b", r"\bthere it is\b", r"\bmy (personal )?favorite\b(?![^.]*\bbecause\b)", r"\bkey (role|part|step|feature|thing|point|factor|takeaway|benefit|difference|idea)\b",
           r", (ensuring|highlighting|making it|allowing)\b", r"\bthe (best|nice) part\b", r"\bi hope this helps\b", r"\bgame changer\b"]
BADCHARS = "!:;—–…()/\"“”’‘[]*&%"

def sentences(t): return [s for s in re.split(r"(?<=[.?])\s+", t.strip()) if s]

def check(lines, quiet=False):
    out = []; err = 0
    bych = {}
    for ln in lines: bych.setdefault(ln["chapter"], []).append(ln)
    for cid, ls in bych.items():
        fit = BEATS is not None
        if fit: ls.sort(key=lambda l: l["at"]); end = BEATS[cid]["chapter_seconds"]
        for i, ln in enumerate(ls):
            t, tag = ln["text"], (f"{ln['id']} @{ln['at']:.1f}" if fit else ln["id"])
            words = len(t.split()); ss = sentences(t)
            if not fit: pass
            elif (win := (ls[i + 1]["at"] if i + 1 < len(ls) else end) - ln["at"]) <= 0: out.append(f"ERROR {tag}: starts at or after the next line"); err += 1
            elif (est := words / RATE + 0.25 * (len(ss) - 1) + 0.2) > win - 0.25: out.append(f"WARN  {tag}: about {est:.1f}s of speech in a {win:.1f}s window ({words} words); check it with a render and fit.py")
            if words < 5: out.append(f"ERROR {tag}: only {words} words; merge it into a neighbouring line"); err += 1
            if words > 48: out.append(f"WARN  {tag}: {words} words in one line; split it");
            for c in BADCHARS:
                if c in t: out.append(f"ERROR {tag}: character {c!r} not allowed in narration"); err += 1
            if not re.search(r"[.?]$", t.strip()): out.append(f"ERROR {tag}: must end with a period"); err += 1
            if re.search(r"[.,?][A-Za-z]|  ", t): out.append(f"ERROR {tag}: spacing after punctuation"); err += 1
            # "Insights" is also the on-screen name of a VM page tab; STYLE's own example is "the Insights tab".
            lw = re.findall(r"[a-z'-]+", re.sub(r"\bInsights tab\b", "tab", t).lower())
            for w in BANNED:
                if w in lw: out.append(f"ERROR {tag}: banned word '{w}'"); err += 1
            for p in PHRASES:
                for s in ss:
                    if re.search(p, s.lower()): out.append(f"ERROR {tag}: AI-tell pattern /{p}/ in: {s}"); err += 1
            for j, s in enumerate(ss):
                n = len(s.split())
                if n <= 4: out.append(f"ERROR {tag}: fragment-length sentence ({n} words): {s}"); err += 1
                if n > 22: out.append(f"WARN  {tag}: long sentence ({n} words): {s}")
                if s.count(",") > 3: out.append(f"WARN  {tag}: {s.count(',')} commas in one sentence: {s}")
            bad = oov(say(t))
            if bad: out.append(f"ERROR {tag}: the voice can't say {bad}; rephrase or ask for a lexicon entry"); err += 1
        # rhythm across the chapter
        lens = [len(s.split()) for ln in ls for s in sentences(ln["text"])]
        for k in range(len(lens) - 2):
            if all(x < 8 for x in lens[k:k + 3]): out.append(f"WARN  {cid}: three short sentences in a row (around sentence {k + 1})"); break
        starts = [s.split()[0].lower() for ln in ls for s in sentences(ln["text"]) if s.split()]
        for k in range(len(starts) - 2):
            if starts[k] == starts[k + 1] == starts[k + 2]: out.append(f"WARN  {cid}: three sentences in a row start with '{starts[k]}'"); break
    allw = [len(s.split()) for ln in lines for s in sentences(ln["text"])]
    if allw: out.append(f"INFO  {len(lines)} lines, {len(allw)} sentences, {sum(allw)} words, mean {sum(allw) / len(allw):.1f} words per sentence")
    if not quiet: print("\n".join(out))
    return err, out

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Mechanical checks for a narration file.")
    ap.add_argument("narration"); ap.add_argument("--beats", default=os.path.join(pmv_env.WORK, "beats.json")); ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--no-fit", action="store_true", help="wording checks only (no beats or at times yet)")
    a = ap.parse_args(); BEATS = None if a.no_fit else load_beats(a.beats)
    err, _ = check(json.load(open(a.narration)), a.quiet)
    sys.exit(1 if err else 0)
