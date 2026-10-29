# Caption boundary nudges after place.py: where speech runs back to back faster than the 20-characters-a-second
# reading rule, move the boundary between caption n and n+1 by dt seconds into the neighbour that has room
# (negative = earlier). Prints any caption still shorter than 1.4 s, faster than 20 chars/s, or overlapping.
# usage: nudge_srt.py in.srt nudges.json out.srt     nudges.json: {"nudges": [[n, dt], ...]} (1-based caption numbers)
import json, sys
src, nf, out = sys.argv[1:4]
def t(x): h, m, r = x.split(':'); s, ms = r.split(','); return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000
def st(v): ms = int(round(v * 1000)); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000); return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
cues = []
for c in open(src).read().strip().split('\n\n'):
    L = c.split('\n'); a, z = [t(v) for v in L[1].split(' --> ')]; cues.append([a, z, L[2:]])
for n, dt in json.load(open(nf))['nudges']:
    i = n - 1; cues[i][1] += dt; cues[i + 1][0] += dt
open(out, 'w').write('\n\n'.join(f"{k}\n{st(a)} --> {st(z)}\n" + '\n'.join(txt) for k, (a, z, txt) in enumerate(cues, 1)) + '\n')
bad = []
for k, (a, z, txt) in enumerate(cues, 1):
    s = ' '.join(txt)
    if z - a < 1.4: bad.append((k, 'short', round(z - a, 2)))
    if len(s) / (z - a) > 20: bad.append((k, 'fast', round(len(s) / (z - a), 1)))
    if k > 1 and a < cues[k - 2][1] - 1e-6: bad.append((k, 'overlap'))
print('captions', len(cues), 'remaining issues', bad)
