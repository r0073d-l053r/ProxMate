# Caption fixes after place.py, where back-to-back speech breaks the reading rules or a switch lands inside a word.
#   nudges: [[n, dt], ...]  move the boundary between caption n and n+1 by dt seconds (negative = earlier), toward
#           the neighbour with room; keep dt within about 0.35 s
#   set:    [[n, start, end], ...]  exact times for caption n (seconds, or null to keep), e.g. from a captions-verify
#           finding that measured the real word boundary; applied after the nudges
#   rebalance: true  re-break any two-row caption whose longer row is over 50 characters at its most even space
# Prints any caption still shorter than 1.4 s, faster than 20 characters a second, overlapping, or over 50 per row.
# usage: nudge_srt.py in.srt fixes.json out.srt     (caption numbers are 1-based; they change when lines are split)
import json, sys
src, nf, out = sys.argv[1:4]
F = json.load(open(nf))
def t(x): h, m, r = x.split(':'); s, ms = r.split(','); return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000
def st(v): ms = int(round(v * 1000)); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000); return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
cues = []
for c in open(src).read().strip().split('\n\n'):
    L = c.split('\n'); a, z = [t(v) for v in L[1].split(' --> ')]; cues.append([a, z, L[2:]])
for n, dt in F.get('nudges', []):
    i = n - 1; cues[i][1] += dt; cues[i + 1][0] += dt
for n, a, z in F.get('set', []):
    if a is not None: cues[n - 1][0] = a
    if z is not None: cues[n - 1][1] = z
if F.get('rebalance'):
    for c in cues:
        if len(c[2]) == 2 and max(map(len, c[2])) > 50:
            words = ' '.join(c[2]).split(' ')
            best = min(range(1, len(words)), key=lambda k: max(len(' '.join(words[:k])), len(' '.join(words[k:]))))
            c[2] = [' '.join(words[:best]), ' '.join(words[best:])]
open(out, 'w').write('\n\n'.join(f"{k}\n{st(a)} --> {st(z)}\n" + '\n'.join(txt) for k, (a, z, txt) in enumerate(cues, 1)) + '\n')
bad = []
for k, (a, z, txt) in enumerate(cues, 1):
    s = ' '.join(txt)
    if round(z - a, 3) < 1.4: bad.append((k, 'short', round(z - a, 2)))
    if len(s) / (z - a) > 20: bad.append((k, 'fast', round(len(s) / (z - a), 1)))
    if k > 1 and a < cues[k - 2][1] + 0.04: bad.append((k, 'overlap'))
    if max(map(len, txt)) > 50: bad.append((k, 'row', max(map(len, txt))))
print('captions', len(cues), 'remaining issues', bad)
