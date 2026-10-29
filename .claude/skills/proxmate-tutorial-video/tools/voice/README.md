# Voice tools

Narration for the tutorials: Kokoro `af_heart` at speed 1.0 through sherpa-onnx, a pronunciation lexicon,
mechanical checks for the script, and caption timing found from the audio. Paths come from
`../pmv_env.py`: `PMV_MODELS` (default `~/pmv/models`), `PMV_LEXICON` (default
`$PMV_MODELS/lexicon-us-en-lab.txt`) and `PMV_WORK` (the video's working folder, default `~/pmv/work`).
Scripts that load a model (render2, align, and asr in `../qa`) run with the venv python, `~/pmv/venv/bin/python3`;
the others run with the venv or the system python3. Narration files are JSON lists of
`{"id": "V03-01", "chapter": "V03", "at": 1.2, "text": "..."}`, with `at` in seconds from the chapter's start in the
finished video.

**setup.sh** installs everything once: a venv at `PMV_VENV` (default `~/pmv/venv`) with the exact versions used so
far (sherpa-onnx 2.0.0, numpy 2.5.4, soundfile 0.14.0 and their dependencies), the Kokoro model and the Moonshine
recogniser from the sherpa-onnx GitHub releases into `PMV_MODELS`, then the lexicon. It warns about the system tools
it does not install (ffmpeg, espeak-ng, Pillow, DejaVu fonts). Usage: `setup.sh`.

**build_lexicon.sh** writes `PMV_LEXICON` as `lexicon-additions.txt` followed by Kokoro's own `lexicon-us-en.txt`.
Both sherpa-onnx and render2.py keep the first entry of a word, so an addition overrides the model. Usage:
`build_lexicon.sh [out]`.

**lexicon-additions.txt** holds the words the model lexicon lacks (61 so far: ProxMate, Proxmox, VM, datacenter,
contractions and plurals the narration uses), one `word p h o n e s` line each. It is the source of truth: edit it
or use lexadd.py, then rebuild.

**lexadd.py** adds words to the lexicon: eSpeak IPA mapped to Kokoro's phone set, with `FIX` for hand-made phones.
New entries go into `PMV_LEXICON` and `lexicon-additions.txt`. Usage: `lexadd.py [--additions FILE] word ...`.

**lexgen.py** is part one's original generator: model lexicon plus entries for a word list, written to a new file.
Usage: `lexgen.py <kokoro dir> <out> word ...`.

**spoken_forms.py** is the table of spoken forms Kokoro needs for names, acronyms and commands ("SSH" to "S S H",
"web-01" to "web oh one", "sudo" to "sue doo"). Part two's forms run before part one's; put a new episode's words in
`EPISODE`. Usage: `from spoken_forms import spoken`.

**sayform.py** turns a narration line into what the voice is given (spoken forms plus numbers as words) and lists
words the lexicon lacks, which Kokoro would skip silently. Usage: `sayform.py "line" ...`.

**build_beats.py** makes the beat sheet for writing narration over a locked cut: each narration slot from the cut's
captions, how many seconds it has until the next one, the fast-forwarded waits inside it, and a frame sheet per
chapter. Usage: `build_beats.py <cut.mp4> <take dir> <script.md> [out dir] [--end-card 7.5]`; writes `beats.json` and
`frames/<chapter>.png` (default into `PMV_WORK`).

**windows.py** is a writing aid: for each line, the window the picture gives it and the most words that fit at
3.25 words a second. Usage: `windows.py narration.json [beats.json]`.

**lint.py** checks a narration file against `docs/narration-style-guide.md`: banned words and AI-tell phrases,
forbidden characters, fragment and long sentences, rhythm, words the voice cannot say, and an estimated fit.
Exit code 1 on any ERROR. Usage: `lint.py narration.json [--beats beats.json] [--quiet]`.

**render2.py** voices each line as one paragraph from lexicon phonemes (so commas and sentence pauses come out
natural) and writes `<id>.wav` plus `manifest.json` with each line's length and estimated sentence starts. A line
may carry its own `"say"`. Renders differ by a few milliseconds from run to run (onnxruntime threads). Usage:
`render2.py narration.json outdir`.

**fit.py** is the real fit check on a rendered manifest: every line must end 0.25 s before the next one (or the
chapter end). Usage: `fit.py manifest.json [beats.json]`.

**align.py** times the captions from the audio: where each later sentence starts, and where a long sentence (over two
42-character rows) splits at a comma pause, choosing among the pauses with Moonshine speech recognition. It rewrites
the manifest in place. Hand measurements for the few spots it gets wrong go in an overrides file
(`examples/align-overrides-part2.json` shows the format). Usage: `align.py <voice dir> [overrides.json]` (default
`$PMV_WORK/align-overrides.json` when it exists).

**place.py** lays the lines over the picture at chapter offset + `at`, normalises to -16 LUFS, muxes with the
untouched video stream, and writes the `.srt` (comma pieces under 1.4 s rejoined, captions held up to 17 characters a
second, two rows at most). Usage: `place.py <voice dir> <picture.mp4> <out.mp4>`; needs `<picture>.chapters.json`.

**to_markdown.py** turns a narration file into a readable script: one section per chapter with its ON SCREEN note
and each line with its start time. Usage: `to_markdown.py narration.json header.md out.md --chapters chapters.json
[--beats beats.json]`.

**to_recorder.py** converts a render2 voice folder into the narration folder the recorder and the assembler read
(the older `segments`/`items` manifest), hard-linking the WAVs, so the recorder paces each chapter with the same
clips the final narration uses. Usage: `to_recorder.py <render2 voice dir> <out dir> [titles.json]`.
