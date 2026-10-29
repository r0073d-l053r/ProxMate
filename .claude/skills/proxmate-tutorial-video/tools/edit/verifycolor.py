# Compare pixels of the encoded chapter (decoded as a player would, honouring its BT.709 tags) with the
# lossless RGB capture at the same instant. Reports mean/max channel error and the blue-minus-red bias.
# Reads <take>/chapters/<id>.mkv and the per-chapter encode <take>/assemble/<id>.mp4 (left by assemble.py).
# usage: verifycolor.py <take dir> [<chapter>@<seconds> ...]   (default: part one's S06@20 S07@10 S09@20 S11@5 S12@8 S14@20 S04@12)
import subprocess, sys, json, os, tempfile
from PIL import Image
take = sys.argv[1]
checks = [(a, float(b)) for a, b in (spec.split("@") for spec in sys.argv[2:])] or \
    [("S06", 20.0), ("S07", 10.0), ("S09", 20.0), ("S11", 5.0), ("S12", 8.0), ("S14", 20.0), ("S04", 12.0)]
TMP = tempfile.mkdtemp(prefix="verifycolor-")
def grab(src, t, out, conv):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{t}", "-i", src, "-frames:v", "1"] + conv + [out], check=True)
rows = []
for cid, t in checks:
    a, b = f"{TMP}/vc_{cid}_src.png", f"{TMP}/vc_{cid}_enc.png"
    grab(f"{take}/chapters/{cid}.mkv", t, a, [])
    grab(f"{take}/assemble/{cid}.mp4", t, b, ["-vf", "scale=in_color_matrix=bt709:in_range=tv,format=rgb24"])
    A = Image.open(a).convert("RGB"); B = Image.open(b).convert("RGB"); W, H = A.size
    pa, pb = A.load(), B.load(); n = 0; err = 0; mx = 0; bias = 0
    for y in range(40, H, 9):
        for x in range(80, W, 9):
            ca, cb = pa[x, y], pb[x, y]
            d = [cb[i] - ca[i] for i in range(3)]; n += 1; err += sum(abs(v) for v in d) / 3; mx = max(mx, max(abs(v) for v in d)); bias += (d[2] - d[0])
    # the app's background colour, sampled in a flat area
    bg_a, bg_b = pa[W - 60, H - 60], pb[W - 60, H - 60]
    rows.append((cid, t, round(err / n, 2), mx, round(bias / n, 2), bg_a, bg_b))
for r in rows: print(f"{r[0]} t={r[1]:>5}  mean|err|={r[2]:>5}  max={r[3]:>3}  blue-red bias={r[4]:>5}  bg src={r[5]} enc={r[6]}")
