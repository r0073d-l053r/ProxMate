# QA tools

Checks for a narrated cut before it ships: review sheets an agent can read, a speech-recognition pass, and three
Workflow scripts that fan the review out to independent agents. Paths come from `../pmv_env.py` (`PMV_MODELS`,
`PMV_WORK`); asr.py and workflow_args.py run with the venv python from `../voice/setup.sh`.

**sheets.py** makes one review sheet per narration line: four frames of the finished video while the line plays
(start, one third, two thirds, end, each labeled with its time) with the line's text underneath, plus `lines.json`
with every line's absolute start and end and sentence starts. Frames are cached in `raw/`, so delete that folder
after moving lines. Usage: `sheets.py <video.mp4> <manifest.json> <chapters.json> [out dir]` (default
`$PMV_WORK/qa`).

**asr.py** transcribes each rendered line with Moonshine and scores it against the spoken form the voice was given,
worst first, to catch skipped or garbled words before placing the voice. Usage: `asr.py <voice dir> [n worst]`.

**workflow_args.py** builds the `args` object the three workflows need: the file paths, plus the numbers their
prompts quote (resolution and length, sentence, line and cue counts, where the end card starts, five spot-check lines),
measured from the files. Usage: `workflow_args.py --video V --picture P --chapters C --lines L --beats B --manifest M
--title T --part "part three" [--creator-note TEXT] [--changed IDS --fixes-file F [--expect-file E]] [--must-check
TEXT]`; it prints JSON to pass as the Workflow's `args`.

**workflows/sync-review.js** is round one: one reviewer per chapter checks every line against its sheet (sync and
facts, with feasible moves or factual rewords only), a skeptic tries to refute each blocker or should-fix finding, and
two more agents run the technical checks (loudness, untouched video stream, end card silence, captions, clipping,
placement) and a speech-recognition pass on the final mix. Its caption check assumes one cue per sentence; when
long sentences are split at commas, rely on captions-verify.js for the captions. Usage: Workflow with
`scriptPath` set to this file and `args` from workflow_args.py.

**workflows/round2-verify.js** re-checks a cut after round one's fixes with three independent agents: the changed
lines against the picture, the captions against the final audio, and the technical and speech checks. It quotes the
fixes back to the agents, so pass `--changed`, `--fixes-file` and, if you know what each changed line should play
over, `--expect-file` to workflow_args.py. Its caption check also assumes one cue per sentence. Usage: as above.

**workflows/captions-verify.js** is the final caption check: structure, every comma-split switch point and a
spot-check of sentence switches against the audio with the recogniser, cues that end before their words do, reading
speed and row length. Usage: as above.
