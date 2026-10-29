export const meta = {
  name: 'tutorial-qa-captions-verify',
  description: 'Independently verify the final captions of a tutorial video against its audio',
  phases: [{ title: 'Verify', detail: 'caption splits and timing vs the final audio' }],
}

// (A workflow script must begin with `export const meta`, so this header follows it.)
// Final caption check: one agent verifies the subtitles (one cue per sentence, long sentences split at a comma
// pause by align.py, held and merged by place.py) against the final audio with speech recognition.
// usage: run with the Workflow tool, args = the JSON printed by tools/qa/workflow_args.py. Keys used here:
//   video, srt, manifest, chapters, py, asr, work   paths, as in sync-review.js
//   cues          number of cues in the srt          line_count   number of narration lines
//   must_check    optional: a sentence boundary to include in the spot-check, e.g. "V12-04's at about 447.11 s"
// Returns { checks, findings }.

const A = typeof args !== 'undefined' && args ? args : {}
const need = (k) => {
  if (A[k] === undefined || A[k] === null || A[k] === '') throw new Error(`captions-verify: missing args.${k} (tools/qa/workflow_args.py makes them)`)
  return A[k]
}
const VID = need('video'), SRT = A.srt || VID.replace(/\.mp4$/, '.srt'), MAN = need('manifest'), CHAPTERS_JSON = need('chapters')
const PY = need('py'), ASR = need('asr'), WORK = need('work'), N_CUES = need('cues'), N_LINES = need('line_count'), MUST = A.must_check || ''

const prompt = `You are checking the subtitles of a finished narrated tutorial video against its audio. Be precise and calibrated: report real problems with measurements, and do not invent any.

Files (read-only; write scratch files only under ${WORK}, make it with mkdir -p; the disk is nearly full, keep files few and small):
- Video: ${VID}
- Subtitles: ${SRT} (${N_CUES} cues)
- Narration manifest: ${MAN}. Each line has id, chapter, at (seconds from its chapter's start), dur, text, say (what the voice was given), sentences, sentence_starts and cues (text and start, seconds from the line's start). Chapter offsets: ${CHAPTERS_JSON}, so a line's absolute start is offset(chapter) + at.
- Python with numpy, soundfile, sherpa_onnx: ${PY}. Speech recognition (Moonshine): see ${ASR} for loading. Pad every clip with 0.5 s of silence on both sides. Recogniser quirks ("Debbie in" for Debian, "Proximate" for ProxMate, "WebO1", "Sue doo", "cloud in it", spelled letters vs acronyms) are not errors.

How the subtitles were made: one cue per sentence, except that a sentence longer than 84 characters is split at a comma into pieces, each timed to the voice's pause at that comma (found by trying each pause and keeping the one whose halves the recogniser matches best). A piece shorter than 1.4 s was joined back to its neighbour. A cue that follows silence and reads fast may appear up to 0.3 s before its voice. Each cue is held into following silence up to about 17 characters per second. Rows are broken near the middle, preferring a comma, with at most two rows.

Check:
1. Structure: numbering, timestamps, order, no overlaps, no empty cues, at most two rows, and the cue texts joined with spaces equal the narration text of all lines joined in order (all ${N_LINES} lines).
2. Every switch point where a cue continues the same sentence as the cue before it (the previous cue ends with a comma): use the recogniser on about 1.5 s before and 1.5 s after the switch, and confirm the previous piece's last word is spoken before the switch and the new piece's first word after it (allow 0.1 s). Report each one that is off, with the measured right time.
3. Every switch point between two sentences of the same line: same check (these were verified in an earlier round, so spot-check at least 15${MUST ? ', including ' + MUST : ''}).
4. No cue ends before its own words finish: for the 15 longest cues by characters, confirm with the recogniser that the last two words are spoken before the cue ends.
5. List cues faster than 20 characters per second, and cues with a row over 50 characters.
Return checks (name, pass, detail) and findings (cue number, severity blocker/should_fix/nit, issue, evidence, fix).`
const RESULT = {
  type: 'object',
  properties: {
    checks: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, pass: { type: 'boolean' }, detail: { type: 'string' } }, required: ['name', 'pass', 'detail'] } },
    findings: { type: 'array', items: { type: 'object', properties: { cue: { type: 'string' }, severity: { type: 'string', enum: ['blocker', 'should_fix', 'nit'] }, issue: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' } }, required: ['cue', 'severity', 'issue', 'evidence', 'fix'] } },
  },
  required: ['checks', 'findings'],
}
phase('Verify')
return await agent(prompt, { label: 'captions-final', phase: 'Verify', schema: RESULT })
