# Build lexicon-us-en-lab.txt = Kokoro's US lexicon + entries for words it lacks (eSpeak IPA -> Kokoro/misaki phones).
# The original generator of the lab lexicon (part one). For day-to-day use, build_lexicon.sh rebuilds the lexicon from
# lexicon-additions.txt and lexadd.py adds new words; use this one to start a lexicon from scratch with a word list.
# usage: lexgen.py <kokoro model dir> <out lexicon> word [word ...]   (needs espeak-ng; FIX holds hand-made phones)
import subprocess, sys, os
K, out, words = sys.argv[1], sys.argv[2], sys.argv[3:]
tokens = set(l.split(" ")[0] for l in open(f"{K}/tokens.txt", encoding="utf-8") if l.strip())
FIX = {"proxmox": "pɹˈɑksmɑks", "proxmate": "pɹˈɑksmˌAt", "vm": "vˌiˈɛm", "vms": "vˌiˈɛmz", "datacenter": "dˈAɾəsˌɛnɾəɹ",
       "cloudflare": "klˈWdflˌɛɹ", "ui": "jˌuˈI", "unticked": "ʌntˈɪkt", "labbing": "lˈæbɪŋ", "superfile": "sˈupəɹfˌIl", "vm's": "vˌiˈɛmz", "dir": "dˈɜɹ", "backend": "bˈækˌɛnd"}
def to_kokoro(ipa):
    s = ipa.replace("ː", "")
    for a, b in (("eɪ", "A"), ("aɪ", "I"), ("oʊ", "O"), ("əʊ", "O"), ("aʊ", "W"), ("ɔɪ", "Y"), ("tʃ", "ʧ"), ("dʒ", "ʤ"), ("ɝ", "ɜɹ"), ("r", "ɹ"), ("ɑ̃", "ɑ"), ("g", "ɡ")):
        s = s.replace(a, b)
    return "".join(c for c in s if c in tokens)
add = []
for w in words:
    ipa = FIX.get(w) or subprocess.run(["espeak-ng", "-v", "en-us", "-q", "--ipa", w], capture_output=True, text=True).stdout.strip().split()[0]
    ph = to_kokoro(ipa) if w not in FIX else ipa
    add.append(f"{w} {' '.join(ph)}"); print(w, "->", ph)
with open(out, "w", encoding="utf-8") as f:
    f.write(open(f"{K}/lexicon-us-en.txt", encoding="utf-8").read().rstrip("\n") + "\n" + "\n".join(add) + "\n")
