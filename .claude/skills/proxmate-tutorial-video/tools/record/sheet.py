# Contact sheet: one frame per narration line (taken mid-line) of a chapter capture.
# usage: sheet.py <take dir> <chapter id> [fraction into each line, default 0.6]   -> <take>/sheets/<id>-sheet.png
import json, subprocess, sys, os
take, cid = sys.argv[1], sys.argv[2]; frac = float(sys.argv[3]) if len(sys.argv) > 3 else 0.6
m = json.load(open(f"{take}/chapters/{cid}.json")); out = f"{take}/sheets"; os.makedirs(out, exist_ok=True)
ts = [e["t"] + e["dur"] * frac for e in m["events"] if e["type"] == "say"] + [m["duration"] - 0.3]
files = []
for i, t in enumerate(ts):
    f = f"{out}/{cid}_{i:02d}.png"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{t:.2f}", "-i", m["file"], "-frames:v", "1", "-vf", "scale=640:-1", f], check=True); files.append(f)
cols = 3; rows = (len(files) + cols - 1) // cols
subprocess.run(["ffmpeg", "-y", "-loglevel", "error"] + sum([["-i", f] for f in files], []) + ["-filter_complex",
    "".join(f"[{i}]" for i in range(len(files))) + f"xstack=inputs={len(files)}:layout=" + "|".join(f"{(i%cols)*640}_{(i//cols)*360}" for i in range(len(files))) + f":fill=black[o]" if len(files) > 1 else "[0]copy[o]",
    "-map", "[o]", f"{out}/{cid}-sheet.png"], check=True)
print(f"{out}/{cid}-sheet.png", len(files))
