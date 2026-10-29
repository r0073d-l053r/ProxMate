#!/usr/bin/env python3
"""Assemble the recorded chapters into the final tutorial MP4.

usage: [FX=1] [VOICE_DIR=<voice dir>] [ENDCARD=<end card mp4>] assemble.py <take dir> <out.mp4> [chapter ids...]

  FX=1        click ripples, eased zooms and the editor's <take>/fx-edits.json (fx.py); without it, a plain cut
  VOICE_DIR   narration folder: manifest.json in the OLD format ({voice, segments: [{id, title, items: [{file,
              text, dur}]}]}) and the line WAVs (24 kHz mono); default $PMV_WORK/narr/voice
  ENDCARD     an end card to append with silence (unset: none). Every video uses tools/edit/endcard/endcard.mp4
  Default chapter ids are part one's (S01, then S02..S15); pass the ids for any other video, cold open first.
  Writes <out.mp4>, <out>.srt and <out>.chapters.json; intermediate parts are cached in <take>/assemble.

For each chapter capture (lossless RGB from x11grab) this:
  * keeps real time, except between ffStart/ffEnd markers (a real wait), which is sped up to the
    marker's target length with a small fast-forward badge;
  * places every narration clip at the moment the recorder started it (shifted by any speed-up);
  * converts RGB -> BT.709 limited-range YUV explicitly and tags it, so players do not guess the
    matrix (an untagged or BT.601-guessed stream is what shifts dark greys toward blue).
Chapters are concatenated in the order given (cold open S01 first). Also writes an SRT.
"""
import json, os, subprocess, sys, wave, struct, array, hashlib

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # tools/, for pmv_env
import pmv_env

VOICE = os.environ.get("VOICE_DIR", os.path.join(str(pmv_env.WORK), "narr", "voice"))  # one voice per run; video parts are shared
# The text of each rendered line, so captions follow a re-rendered line even if the recording's log is older.
SAID = {it["file"]: it["text"] for g in json.load(open(f"{VOICE}/manifest.json"))["segments"] for it in g["items"] if "file" in it}
VOICE_NAME = json.load(open(f"{VOICE}/manifest.json")).get("voice", "")
FPS = 30
SR = 24000
FONT = str(pmv_env.FONT_BOLD)  # DejaVu Sans Bold: has the ▶ glyph

def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write((r.stderr or "")[-3000:] + f"\n(rc {r.returncode})\n"); raise SystemExit(f"failed: {' '.join(cmd[:6])}")
    return r

def probe_dur(f):
    r = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f])
    return float(r.stdout.strip())

def read_wav(path):
    with wave.open(path) as w:
        assert w.getframerate() == SR and w.getnchannels() == 1
        n = w.getnframes(); raw = w.readframes(n); sw = w.getsampwidth()
    if sw == 2:
        a = array.array("h"); a.frombytes(raw); return [s / 32768.0 for s in a]
    if sw == 4:  # float32 written by soundfile? (soundfile writes PCM_16 by default for wav)
        return list(struct.unpack(f"<{n}f", raw))
    raise SystemExit("unsupported wav")

COLOR = ["-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-g", "60", "-bf", "2",
         "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", "-r", str(FPS), "-an"]

FX = os.environ.get("FX") == "1"
if FX:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import fx

def load_edits(take):
    """The editor's decisions on top of what the recorder logged, for the polished cut (<take>/fx-edits.json):
      ripple_lead: seconds to start every ripple before its logged time (the click is logged after it lands)
      drop_clicks: {chapter: [t, ...]}   no ripple for these clicks (window chrome, closing a dialog...)
      page_change: {chapter: [{"logged": t, "dt": s | null}]}   override the page-change detection for a click:
                                     dt = seconds after the press when the page changes, null = it does not
      add_clicks: {chapter: [{"t": press, "x": .., "y": .., "keep_ring": bool}]}   a click the recorder did not
                                     log (e.g. a raw triple-click); keep_ring: never fade it early
      zooms: {chapter: [{"near": t, "in": t, "out": t, "rect": [x,y,w,h]?}, ...]}   re-time / re-frame the zoom
                                                                          that starts near `near`
      add_zooms: {chapter: [{"in": t, "out": t, "rect": [x,y,w,h]}, ...]}   a zoom the recorder did not log
                                     (an "in" before 0 starts the chapter already zoomed in)
      add_ff: {chapter: [{"from": t, "to": t, "target": s, "label": str}]}   speed up another real wait
      move_say: {chapter: [{"near": t, "to": t}]}   start the line logged near `near` at `to` instead (a line
                                     said before the action it names, with silence after it to move into)
      split_say: {chapter: [{"near": t, "to": t, "at": {voice: s}, "text_at": str}]}   cut the line that starts
                                     near `near` at a pause `at` seconds in (per voice) and start the rest at `to`;
                                     its caption splits after `text_at`
      fade_out / fade_in: {chapter: seconds}   a dip through black at a cut (the cold open's flash-forward)
      hold_end: {chapter: seconds}   hold the chapter's last frame (a result that only appears at the very end)
      dissolve: {chapter: seconds}   cross-fade into this chapter from the one before (a window switch that
                                     happened between two recordings); trims that much silence off its start"""
    p = f"{take}/fx-edits.json"
    return (json.load(open(p)), os.path.getmtime(p)) if FX and os.path.exists(p) else ({}, 0.0)

def edit_sig(ed, cid):
    """Cache key for a chapter's effects parts: this chapter's edits and the effects code, so changing one
    chapter's edits re-renders only that chapter."""
    mine = {k: v.get(cid) for k, v in ed.items() if isinstance(v, dict) and k != "split_say"}; mine["lead"] = ed.get("ripple_lead")  # split_say is audio only
    code = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "fx.py"), "rb").read()
    return hashlib.sha1(json.dumps(mine, sort_keys=True).encode() + code).hexdigest()[:8]

def span_fx(src, ev, s0, s1, cid, ed):
    """Clicks and zooms the recorder logged inside one real-time span (chapter seconds, screen pixels)."""
    lead = ed.get("ripple_lead", 0.0); drop = ed.get("drop_clicks", {}).get(cid, [])
    clicks = []
    for e in ev:
        if e["type"] != "click" or not s0 <= e["t"] < s1 - 0.05 or any(abs(e["t"] - d) < 0.05 for d in drop): continue
        ov = next((o for o in ed.get("page_change", {}).get(cid, []) if abs(o["logged"] - e["t"]) < 0.05), None)
        start, cut = fx.ripple_times(src, e["t"] - lead, e["x"], e["y"], **({"dt": ov["dt"]} if ov else {}))
        clicks.append((start, e["x"], e["y"], cut))
    for a in ed.get("add_clicks", {}).get(cid, []):
        if not s0 <= a["t"] < s1 - 0.05: continue
        start, cut = (a["t"], None) if a.get("keep_ring") else fx.ripple_times(src, a["t"], a["x"], a["y"])
        clicks.append((start, a["x"], a["y"], cut))
    zooms, open_ = [], None
    for e in ev:
        if e["type"] == "zoom": open_ = e
        elif e["type"] == "unzoom" and open_: zooms.append((open_["t"], e["t"], fx.target_box(open_["rect"]))); open_ = None
    if open_: zooms.append((open_["t"], s1 - fx.EASE - 0.1, fx.target_box(open_["rect"])))
    for z in ed.get("zooms", {}).get(cid, []):
        zooms = [(z["in"], z["out"], fx.target_box(z["rect"]) if "rect" in z else b) if abs(a - z["near"]) < 0.3 else (a, o, b)
                 for a, o, b in zooms]
    zooms = sorted(zooms + [(z["in"], z["out"], fx.target_box(z["rect"])) for z in ed.get("add_zooms", {}).get(cid, [])])
    return clicks, [z for z in zooms if z[0] < s1 and z[1] + fx.EASE > s0]

def chapter(take, cid, tmp):
    meta = json.load(open(f"{take}/chapters/{cid}.json"))
    src = meta["file"]; dur = meta["duration"]; ev = meta["events"]
    ed, ed_mtime = load_edits(take)
    ev = ev + [e for a in ed.get("add_ff", {}).get(cid, []) for e in ({"type": "ffStart", "t": a["from"], "target": a["target"], "label": a.get("label", "")}, {"type": "ffEnd", "t": a["to"]})]
    for mv in ed.get("move_say", {}).get(cid, []):
        ev = [dict(e, t=mv["to"]) if e["type"] == "say" and abs(e["t"] - mv["near"]) < 0.3 else e for e in ev]
    ffs = sorted([e for e in ev if e["type"] == "ffStart"], key=lambda e: e["t"]); ffe = sorted([e for e in ev if e["type"] == "ffEnd"], key=lambda e: e["t"])
    spans = []  # (src_start, src_end, speed)
    cur = 0.0
    for a, b in zip(ffs, ffe):
        spans.append((cur, a["t"], 1.0))
        length = b["t"] - a["t"]; target = min(a.get("target", 7), length)
        spans.append((a["t"], b["t"], length / target))
        cur = b["t"]
    spans.append((cur, dur, 1.0))
    # source time -> output time
    def tmap(t):
        out = 0.0
        for s0, s1, k in spans:
            if t >= s1: out += (s1 - s0) / k
            else: return out + max(0.0, t - s0) / k
        return out
    # video: each span is encoded on its own (seeking into the lossless capture), FF spans sped up with a
    # badge, then the parts are joined without re-encoding. One graph for all spans would buffer every
    # decoded frame of the later spans in memory.
    parts = []
    for i, (s0, s1, k) in enumerate(spans):
        if s1 - s0 < 1 / FPS: continue
        vf = f"setpts=(PTS-STARTPTS)/{k:.5f},fps={FPS}"
        if k > 1.01:
            vf += (f",drawtext=fontfile='{FONT}':text='▶▶  {k:.0f}×':fontsize=34:fontcolor=white:"
                   f"box=1:boxcolor=0x000000@0.62:boxborderw=16:x=w-tw-56:y=h-th-60")
        # Explicit RGB -> BT.709 (limited range) conversion, tagged below.
        vf += ",scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p"
        if i == 0 and cid in ed.get("fade_in", {}): vf += f",fade=t=in:st=0:d={ed['fade_in'][cid]}"
        if s1 == spans[-1][1] and cid in ed.get("hold_end", {}): vf += f",tpad=stop_mode=clone:stop_duration={ed['hold_end'][cid]}"
        if s1 == spans[-1][1] and cid in ed.get("fade_out", {}):
            d = ed["fade_out"][cid]; vf += f",fade=t=out:st={(s1 - s0) / k - d:.3f}:d={d}"
        part = f"{tmp}/{cid}-p{i}{'-fx-' + edit_sig(ed, cid) if FX else ''}.mp4"
        clicks, zooms = span_fx(src, ev, s0, s1, cid, ed) if FX and k <= 1.01 else ([], [])
        if not (os.path.exists(part) and os.path.getmtime(part) > os.path.getmtime(src)):  # reuse an existing encode
            tmp_part = part[:-4] + ".partial.mp4"  # renamed only when complete: an interrupted render is never reused
            if clicks or zooms:  # click ripples and eased zooms, frame by frame (fx.py)
                fx.render_span(src, s0, s1, clicks, zooms, tmp_part, COLOR, vf.split(",", 2)[2])
            else:
                run(["ffmpeg", "-y", "-loglevel", "warning", "-ss", f"{s0:.3f}", "-to", f"{s1:.3f}", "-i", src, "-vf", vf] + COLOR + [tmp_part])
            os.replace(tmp_part, part)
        parts.append(part)
    with open(f"{tmp}/{cid}-parts.txt", "w") as f: f.writelines(f"file '{q}'\n" for q in parts)
    vout = f"{tmp}/{cid}.mp4"
    run(["ffmpeg", "-y", "-loglevel", "warning", "-f", "concat", "-safe", "0", "-i", f"{tmp}/{cid}-parts.txt", "-c", "copy", vout])
    vdur = probe_dur(vout); nframes = round(vdur * FPS); total = nframes / FPS
    # audio: narration clips at mapped times
    buf = [0.0] * int(round(total * SR) + SR)
    subs = []
    for e in ev:
        if e["type"] != "say": continue
        t = tmap(e["t"]); s = read_wav(f"{VOICE}/{e['file']}"); text = SAID.get(e["file"], e["text"])  # captions say what the voice says
        sp = next((x for x in ed.get("split_say", {}).get(cid, []) if abs(x["near"] - e["t"]) < 0.3 and VOICE_NAME in x["at"]), None)
        if sp:
            k = int(round(sp["at"][VOICE_NAME] * SR)); i = text.index(sp["text_at"]) + len(sp["text_at"])
            pieces = [(t, s[:k], text[:i].strip()), (tmap(sp["to"]), s[k:], text[i:].strip())]
        else:
            pieces = [(t, s, text)]
        for t, s, text in pieces:
            o = int(round(t * SR))
            for j, v in enumerate(s):
                if o + j < len(buf): buf[o + j] += v
            subs.append((t, t + len(s) / SR, text))
    subs.sort()  # a line the editor moved can now come before one logged earlier
    buf = buf[: int(round(total * SR))]
    wout = f"{tmp}/{cid}.wav"
    with wave.open(wout, "w") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(array.array("h", [max(-32767, min(32767, int(v * 32767))) for v in buf]).tobytes())
    print(f"{cid}: source {dur:.1f}s -> {total:.1f}s, {len(subs)} lines, ff {[round(k,1) for _,_,k in spans if k>1]}")
    return vout, wout, total, subs

def srt_time(t):
    ms = int(round(t * 1000)); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

def main():
    take, out = sys.argv[1], sys.argv[2]
    ids = sys.argv[3:] or ["S01"] + [f"S{i:02d}" for i in range(2, 16)]
    tmp = f"{take}/assemble"; os.makedirs(tmp, exist_ok=True)
    built = [[cid, *chapter(take, cid, tmp)] for cid in ids]  # cid, video, audio, length, subtitles
    ed, _ = load_edits(take)
    for i in range(1, len(built)):
        cid, v, a, total, subs = built[i]; d = ed.get("dissolve", {}).get(cid)
        if not d: continue
        if subs and subs[0][0] < d + 0.05: print(f"{cid}: no dissolve, its narration starts at {subs[0][0]:.2f}s"); continue
        pv, ptotal = built[i - 1][1], built[i - 1][3]
        xv, mv, ma = f"{tmp}/{built[i - 1][0]}-x.mp4", f"{tmp}/{cid}-x.mp4", f"{tmp}/{cid}-x.wav"
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", pv, "-i", v, "-filter_complex",
             f"[0:v][1:v]xfade=transition=fade:duration={d}:offset={ptotal - d:.4f},trim=duration={ptotal:.4f}[o]", "-map", "[o]"] + COLOR + [xv])
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", v, "-vf", f"trim=start={d},setpts=PTS-STARTPTS"] + COLOR + [mv])
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", a, "-af", f"atrim=start={d},asetpts=PTS-STARTPTS", ma])
        built[i - 1][1] = xv; built[i] = [cid, mv, ma, total - d, [(s - d, e - d, t) for s, e, t in subs]]
        print(f"{built[i - 1][0]} -> {cid}: {d}s dissolve")
    vids, wavs, srt, off, chapters = [], [], [], 0.0, []
    for cid, v, a, total, subs in built:
        vids.append(v); wavs.append(a); chapters.append((off, cid))
        srt += [(off + s, off + e, t) for s, e, t in subs]; off += total
    # Optional animated end card (already encoded with the same settings): appended with silence.
    end = os.environ.get("ENDCARD")
    if end:
        edur = probe_dur(end); n = int(round(edur * SR))
        ewav = f"{tmp}/endcard.wav"
        with wave.open(ewav, "w") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(b"\x00\x00" * n)
        vids.append(end); wavs.append(ewav); off += n / SR
        print(f"end card: {edur:.2f}s")
    with open(f"{tmp}/v.txt", "w") as f: f.writelines(f"file '{v}'\n" for v in vids)
    with open(f"{tmp}/a.txt", "w") as f: f.writelines(f"file '{a}'\n" for a in wavs)
    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", f"{tmp}/a.txt", "-c", "copy", f"{tmp}/all.wav"])
    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", f"{tmp}/v.txt", "-i", f"{tmp}/all.wav",
         "-map", "0:v", "-map", "1:a", "-c:v", "copy",
         "-af", "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000", "-c:a", "aac", "-b:a", "192k", "-ac", "2",
         "-movflags", "+faststart", "-shortest", out])
    with open(os.path.splitext(out)[0] + ".srt", "w") as f:
        for i, (s, e, t) in enumerate(srt, 1): f.write(f"{i}\n{srt_time(s)} --> {srt_time(e)}\n{t}\n\n")
    json.dump({"chapters": chapters, "duration": off}, open(os.path.splitext(out)[0] + ".chapters.json", "w"), indent=1)
    print(f"wrote {out}: {off:.1f}s")

main()
