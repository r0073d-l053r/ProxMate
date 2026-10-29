export const meta = {
  name: 'tutorial-qa-round2-verify',
  description: 'Re-verify a fixed tutorial cut: moved lines, caption timing, technical and speech checks',
  phases: [
    { title: 'Verify', detail: 'three independent checkers on the fixed cut' },
  ],
}

// (A workflow script must begin with `export const meta`, so this header follows it.)
// QA round two, after the round-one fixes: three independent checkers (the changed lines against the picture, the
// captions against the final audio, technical and speech checks).
// usage: run with the Workflow tool, args = the JSON printed by tools/qa/workflow_args.py with --changed,
// --fixes-file and (optionally) --expect-file. Keys used here:
//   video, picture, chapters, srt, lines, sheets, manifest, py, asr, work   paths, as in sync-review.js
//   part              e.g. "part two"
//   fixes             markdown bullet list of what round one fixed (each line starting "- "), quoted to the checkers
//   changed           ids of the lines that were moved or reworded, e.g. ["V08-03", "V10-06"]
//   expect            optional: what each changed line should play over (one paragraph ending with a period)
//   sentences         number of sentences in lines.json      later_sentences  sentences that are not the first of their line
//   chapter_ids       ["V01", ...] (the last one names the chapter before the end card)
//   last_chapter_seconds, end_card_start   the last chapter's length and where the end card starts (seconds)
// Returns [{ job, checks, findings }, ...].

const A = typeof args !== 'undefined' && args ? args : {}
const need = (k) => {
  if (A[k] === undefined || A[k] === null || A[k] === '') throw new Error(`round2-verify: missing args.${k} (tools/qa/workflow_args.py makes them)`)
  return A[k]
}
const VID = need('video'), PICTURE = need('picture'), CHAPTERS_JSON = need('chapters'), LINES = need('lines')
const SHEETS = A.sheets || LINES.replace(/\/[^/]*$/, '') + '/sheets'
const SRT = A.srt || VID.replace(/\.mp4$/, '.srt')
const MAN = need('manifest'), PY = need('py'), ASR = need('asr'), WORK = need('work'), PART = need('part')
const FIXES = need('fixes'), CHANGED = need('changed'), EXPECT = A.expect || ''
const N_SENT = need('sentences'), LATER = need('later_sentences'), CHAPTERS = need('chapter_ids')
const LAST = CHAPTERS[CHAPTERS.length - 1], LAST_SECS = need('last_chapter_seconds'), END_START = need('end_card_start')
const CHANGED_LIST = CHANGED.join(', ')

const CONTEXT = `
You are QA on a finished screen-recorded YouTube tutorial (${PART} of a ProxMate series; ProxMate is a web app for sharing a Proxmox VE cluster with friends). The picture is locked and approved. A text-to-speech narration (Kokoro af_heart, normal speed) is laid over it. A first QA round found only small issues, and these were fixed:
${FIXES}

Files (read-only; write scratch files only under ${WORK}, make it with mkdir -p; the disk is nearly full, so keep extra files few and small):
- Final video: ${VID}. Chapter offsets: ${CHAPTERS_JSON}. The approved picture: ${PICTURE}.
- Captions: ${SRT}
- Every line: ${LINES} (id, chapter, start/end ABSOLUTE seconds, text, sentences, sentence_starts_abs, sheet). Per-line review sheets ${SHEETS}/<id>.jpg show 4 labeled frames while the line plays plus its text. Read them with the Read tool.
- Spoken form the voice was given, per line: field "say" in ${MAN}.
- Python with numpy, soundfile and sherpa_onnx: ${PY}. Speech recognition (Moonshine): see ${ASR} for loading it; pad clips with 0.5 s of silence on both sides, it misses words at clip edges otherwise. Recogniser quirks such as "Debbie in" for Debian, "Proximate" for ProxMate, "WebO1" for web oh one, "Sue doo" for sudo are not voice errors.
- Extra frames: ffmpeg -loglevel error -y -ss <abs_seconds> -i ${VID} -frames:v 1 -vf scale=1280:720 ${WORK}/<name>.png
Be calibrated: report real problems with evidence, and do not invent any. Severity: blocker (a viewer would be confused or misled), should_fix (noticeably off), nit.
`
const RESULT = {
  type: 'object',
  properties: {
    checks: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, pass: { type: 'boolean' }, detail: { type: 'string' } }, required: ['name', 'pass', 'detail'] } },
    findings: { type: 'array', items: { type: 'object', properties: {
      line_id: { type: 'string' }, severity: { type: 'string', enum: ['blocker', 'should_fix', 'nit'] }, issue: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' } },
      required: ['line_id', 'severity', 'issue', 'evidence', 'fix'] } },
  },
  required: ['checks', 'findings'],
}
const jobs = [
  { label: 'sync-changed-lines', prompt: `${CONTEXT}
Your job: check the ${CHANGED.length} changed lines (${CHANGED_LIST}) against the picture. For each, Read its sheet and pull extra frames as needed, and confirm the narration talks about what is on screen while it plays${EXPECT ? ': ' + EXPECT : '.'} Also confirm each changed line still has at least 0.25 s of silence before the next line and after the previous one (lines.json). One check per line.` },
  { label: 'captions', prompt: `${CONTEXT}
Your job: check the captions against the FINAL video's audio, independently. Parse ${SRT}. Confirm: valid numbering and timestamps, cues in order, no overlaps, no empty cues, at most two rows per cue, and that joining each cue's rows with a space gives exactly one sentence from lines.json, all ${N_SENT} in order. Then, for every cue that is not the first sentence of its line (there are ${LATER}), check the switch time against the audio: decode the final video's audio around the cue start, and use speech recognition on about 1.5 s before and 1.5 s after the cue start to confirm the previous sentence's last word is spoken before the switch and the new sentence's first word after it (allow 0.1 s). Report each boundary that is off by more than 0.15 s with the measured correct time. Also report the reading rate of every cue above 20 characters per second, and whether any cue disappears before its sentence finishes being spoken (check the last 2 words with the recogniser for the 10 longest cues).` },
  { label: 'technical-and-speech', prompt: `${CONTEXT}
Your job: technical and speech checks on the final video.
1. Loudness with ffmpeg -af ebur128=peak=true: integrated within -16 +/- 1 LUFS, true peak at most -1.0 dBTP. Report the numbers.
2. The video stream is bit-identical to the approved picture: compare ffmpeg -loglevel error -i <file> -map 0:v -c copy -f md5 - for the final video and ${PICTURE}.
3. One h264 video and one AAC 48 kHz stereo audio stream; audio and video durations agree within 0.1 s.
4. The end card (from offset(${LAST}) + ${LAST_SECS} s, about ${END_START} s, to the end) has no narration: measure the audio level there.
5. No two lines overlap and every gap is at least 0.25 s (lines.json); every line ends inside its chapter.
6. Speech: for the ${CHANGED.length} changed lines (${CHANGED_LIST}) plus 10 other lines of your choice spread across the video, decode the final video's audio from start-0.4 to end+0.4 s, recognise it, and compare with the line's "say" text. Report any real word missing, added, or garbled, and any bleed from a neighbouring line.
7. Each of the ${CHANGED.length} changed lines starts where lines.json says: find the speech onset in the final audio within 0.15 s of its listed start.` },
]
phase('Verify')
const results = await parallel(jobs.map(j => () => agent(j.prompt, { label: j.label, phase: 'Verify', schema: RESULT }).then(r => ({ job: j.label, ...r }))))
return results.filter(Boolean)
