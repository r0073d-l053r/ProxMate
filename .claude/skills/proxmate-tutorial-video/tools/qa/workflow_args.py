# Make the `args` object for the QA workflows (workflows/sync-review.js, round2-verify.js, captions-verify.js):
# file paths plus the numbers the review prompts quote (sentence, line and cue counts, end card start, spot-check
# lines), measured from the files so nothing is typed by hand. Prints JSON; pass it as the Workflow's args.
# usage: workflow_args.py --video final.mp4 --picture picture.mp4 --chapters picture.chapters.json --lines qa/lines.json
#          --beats beats.json --manifest voice/manifest.json --title "ProxMate templates, VMs and consoles" --part "part two"
#          [--srt S] [--narration-wav W] [--work DIR] [--creator-note TEXT]
#          [--changed V08-03,V10-06 --fixes-file fixes.md [--expect-file expect.md]] [--must-check TEXT]
#   Run it with the venv python so "py" is the interpreter that has numpy, soundfile and sherpa_onnx.
#   --lines is sheets.py's lines.json; --srt and --narration-wav default to the video's name with .srt / .narration.wav;
#   --work (scratch folder for the reviewers) defaults to $PMV_WORK/qa/work.
#   --creator-note: sentence(s) added after "The wording was approved by the video's creator." in sync-review, e.g.
#     "V01, V02 and V03 are the creator's own words."
#   round2-verify only: --changed (line ids fixed after round one), --fixes-file (markdown bullet list of what round one
#     fixed, each line starting "- "), --expect-file (what each changed line should play over, one paragraph).
#   captions-verify only: --must-check, a boundary to include in the spot-check, e.g. "V12-04's at about 447.11 s".
import argparse, json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.dirname(HERE))
import pmv_env

ap = argparse.ArgumentParser(description="args for the QA workflows")
for k in ("video", "picture", "chapters", "lines", "beats", "manifest", "title", "part"): ap.add_argument("--" + k, required=True)
ap.add_argument("--srt"); ap.add_argument("--narration-wav"); ap.add_argument("--work", default=os.path.join(pmv_env.WORK, "qa", "work"))
ap.add_argument("--creator-note", default=""); ap.add_argument("--changed", default=""); ap.add_argument("--fixes-file"); ap.add_argument("--expect-file")
ap.add_argument("--must-check", default="")
a = ap.parse_args()
ab = lambda p: os.path.abspath(os.path.expanduser(p))
base = os.path.splitext(ab(a.video))[0]
srt = ab(a.srt) if a.srt else base + ".srt"
probe = json.loads(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,avg_frame_rate:format=duration",
                                   "-of", "json", ab(a.video)], capture_output=True, text=True, check=True).stdout)
st, dur = probe["streams"][0], float(probe["format"]["duration"])
n, d = (int(x) for x in st["avg_frame_rate"].split("/")); fps = n / d if d else 0
chap = json.load(open(a.chapters))["chapters"]; ids = [c for _, c in chap]; off = {c: t for t, c in chap}
beats = {b["chapter"]: b for b in json.load(open(a.beats))}
lines = json.load(open(a.lines))
last = ids[-1]; last_secs = beats[last]["chapter_seconds"]; end_start = off[last] + last_secs
cues = [b for b in open(srt, encoding="utf-8").read().strip().split("\n\n") if b.strip()]
pick = sorted({0, len(lines) // 4, len(lines) // 2, 3 * len(lines) // 4, len(lines) - 1}) if lines else []
out = {
    "video": ab(a.video), "picture": ab(a.picture), "chapters": ab(a.chapters), "lines": ab(a.lines),
    "sheets": os.path.join(os.path.dirname(ab(a.lines)), "sheets"), "beats": ab(a.beats), "manifest": ab(a.manifest),
    "srt": srt, "narration_wav": ab(a.narration_wav) if a.narration_wav else base + ".narration.wav", "work": ab(a.work),
    "py": sys.executable, "asr": os.path.join(HERE, "asr.py"), "moonshine": pmv_env.MOONSHINE_DIR or os.path.join(pmv_env.MODELS, "sherpa-onnx-moonshine-*"),
    "title": a.title, "part": a.part, "creator_note": a.creator_note,
    "video_info": f"{st['width']}x{st['height']}, {fps:g} fps, {dur:.1f} s",
    "chapter_ids": ids, "line_count": len(lines),
    "sentences": sum(len(l["sentences"]) for l in lines), "later_sentences": sum(len(l["sentences"]) - 1 for l in lines),
    "cues": len(cues), "spot_lines": [lines[i]["id"] for i in pick],
    "last_chapter_seconds": last_secs, "end_card_start": round(end_start, 1), "end_card": round(dur - end_start, 1),
    "changed": [x for x in a.changed.split(",") if x], "fixes": open(a.fixes_file).read().strip() if a.fixes_file else "",
    "expect": open(a.expect_file).read().strip() if a.expect_file else "", "must_check": a.must_check,
}
print(json.dumps(out, indent=1, ensure_ascii=False))
