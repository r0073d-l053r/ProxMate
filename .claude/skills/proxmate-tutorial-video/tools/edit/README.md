# Editing tools

Turns a take's chapter captures (`$PMV_WORK/rec/<take>/chapters/`, from `../record/`) into the finished MP4: real
time except for marked waits (sped up with a small fast-forward badge), click ripples and eased zooms, explicit
BT.709 colour, narration placed where the recorder started each line, captions (SRT), a chapters file, and the
ProxMate end card. Needs python3 with Pillow, ffmpeg (libx264), and `../pmv_env.py` (shared paths: `PMV_WORK`,
the DejaVu fonts).

A typical polished cut (part two's chapter order; a new video passes its own ids, cold open first):

```
SK=$(git rev-parse --show-toplevel)/.claude/skills/proxmate-tutorial-video; mkdir -p $PMV_WORK/out
FX=1 VOICE_DIR=$PMV_WORK/narr/voice ENDCARD=$SK/tools/edit/endcard/endcard.mp4 \
  python3 $SK/tools/edit/assemble.py $PMV_WORK/rec/t2a $PMV_WORK/out/part2.mp4 V01 V02 V03 ... V20
python3 $SK/tools/edit/qa_fx.py $PMV_WORK/rec/t2a $PMV_WORK/out/part2.mp4 $PMV_WORK/qa/fx
```

## Tools

**teaser.sh**: a roughly 30 s social teaser. It takes a stretch of the finished video, fades it out over 0.5 s,
appends the end card without re-encoding it (and fails unless the end card frames match), puts the finished mix
under the stretch and silence under the card, and cuts the matching captions from the full `.srt`. Usage:
`teaser.sh <full.mp4> <start s> <end s> <out.mp4> [full.srt]`. Leave 0.5 s of air after the last word.

**assemble.py**: the assembler. `[FX=1] [VOICE_DIR=..] [ENDCARD=..] python3 assemble.py <take dir> <out.mp4> [chapter ids...]`.
Per chapter it encodes each real-time span from the lossless capture (cached in `<take>/assemble`, reused until
the capture or, with FX=1, that chapter's edits or fx.py change), lays the narration WAVs at their logged times,
then joins the chapters (with any dissolves), appends `ENDCARD` with silence, normalises loudness (-16 LUFS, AAC
192k, 48 kHz stereo) and writes `<out>.srt` and `<out>.chapters.json` (each chapter's start time and the total
duration; qa_fx.py reads it). With FX=1 it applies fx.py and the editor's `<take>/fx-edits.json` (keys below). It reads
narration from a voice folder's `manifest.json` in the OLD format (`{voice, segments: [{id, title, items: [{file,
text, dur}]}]}`, 24 kHz mono WAVs); the newer narration path is `../voice/place.py`, which places the narration over
the finished picture (see `../voice/README.md`). Default chapter ids are part one's (S01, S02..S15).

**fx.py**: the effects, used by assemble.py (FX=1) and qa_fx.py, not run on its own. Click ripples (a soft
antialiased ring, 0.48 s; a click that swaps the page under the pointer within 0.4 s gets its ring a moment early
and fades it as the page changes), eased zooms on a logged screen rectangle (16:9, padded, at most 1.9x, 0.55 s
ease, sub-pixel smooth), and `click_change`, the page-change detector on the lossless capture.

**qa_fx.py**: review frames for the polished cut. `python3 qa_fx.py <take dir> <final.mp4> <out dir>`. Crops
around every ripple (+0.10 s and +0.25 s) with the full frame, six frames per zoom (before, easing in, held, held
end, easing out, after), every narration line near its start and end, silences over 2 s, both sides of every cut,
and the end card; `index.json` lists each image with chapter, times and the line being spoken. Also a colour
check per chapter against the lossless capture (`colour.json`). Look at the images before calling a cut done.

**verifycolor.py**: colour check of the per-chapter encodes in `<take>/assemble` against the captures: mean and
max channel error and blue-minus-red bias (a shift toward blue means a wrong matrix somewhere).
`python3 verifycolor.py <take dir> [S06@20 ...]` (default: part one's chapters and times).

**endcard/**: THE ProxMate end card, the same at the end of every video. `endcard.mp4` (7.5 s, 225 frames,
1920x1080, 30 fps, H.264 High, yuv420p, BT.709 limited range, no audio; sha256
`b4706f9dbad93fb2e49039bcc0707531fdc40659db56469b400d7160d2b7f1e4`) is used as is: pass it as `ENDCARD`, never
re-encode it. qa_fx.py assumes the last 7.5 s of a video are this card. To change the card on purpose, edit
`endcard.html` (logo badge, "ProxMate.", "Your cluster *shared* safely", "Visit proxmate.host to learn more"; CSS
animations, fade to black from 6.6 s), render every frame with `node endcard/render.cjs <frames dir>` (playwright,
animations paused and stepped frame by frame), then encode. The original encode command is not recorded; this one
matches the x264 settings stored in endcard.mp4 (crf 17, preset slow, keyint 60, 2 B-frames) and the colour
handling of assemble.py:

```
ffmpeg -framerate 30 -i <frames dir>/%04d.png \
  -vf "scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p" \
  -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p -g 60 -bf 2 \
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv -r 30 -an endcard.mp4
```

Fonts (`endcard/fonts/`): Geist (`geist-normal-latin.woff2`, Copyright 2024 The Geist Project Authors) and
Instrument Serif italic (`instrument-serif-italic-latin.woff2`, Copyright 2022 The Instrument Serif Project
Authors), both under the SIL Open Font License 1.1; `OFL.txt` (kept with them) holds the notices and licence text.

## fx-edits.json keys

The editor's decisions live in `<take dir>/fx-edits.json`; times are chapter seconds of that take (the times in the
chapter's `.json` timeline, before any speed-up). `examples/fx-edits-part2.json` is part two's file, a worked
example of most keys. From `load_edits` in assemble.py:

```
The editor's decisions on top of what the recorder logged, for the polished cut (<take>/fx-edits.json):
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
                                     happened between two recordings); trims that much silence off its start
```

Notes: `_note` is ignored. The `"under_voice": true` on one `add_ff` entry in the part-two example is not read by
assemble.py (extra keys are ignored). `split_say` voices are the manifest's
`voice` names (e.g. `af_heart`, `am_michael`).
