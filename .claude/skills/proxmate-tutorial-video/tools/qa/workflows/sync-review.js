export const meta = {
  name: 'tutorial-qa-sync-review',
  description: 'QA a re-voiced tutorial video: per-chapter sync review, adversarial verify, technical and ASR checks',
  phases: [
    { title: 'Sync review', detail: 'one reviewer per chapter, frames vs narration' },
    { title: 'Verify', detail: 'independent skeptic re-checks each blocker/should_fix finding' },
    { title: 'Technical', detail: 'loudness, streams, end card, captions' },
    { title: 'ASR', detail: 'speech recognition on the final mix, line by line' },
  ],
}

// (A workflow script must begin with `export const meta`, so this header follows it.)
// QA round one for a re-voiced tutorial cut: one reviewer per chapter checks the narration against the picture
// (review sheets from sheets.py), an independent skeptic tries to refute every blocker/should_fix finding, and two
// more agents run the technical checks and a speech-recognition pass on the final mix.
// usage: run with the Workflow tool, args = the JSON printed by tools/qa/workflow_args.py. Keys used here:
//   video          final video (mp4)                     picture       approved picture (mp4); the video stream must match it
//   chapters       chapters.json ([offset, id] pairs)    lines         sheets.py lines.json (absolute start/end per line)
//   sheets         folder of <id>.jpg review sheets      beats         beats.json (on_screen, chapter_seconds per chapter)
//   manifest       voice manifest (field "say")          srt           captions of the final video
//   narration_wav  place.py's narration mix (.wav)       work          scratch folder for the reviewers
//   py             python with numpy/soundfile/sherpa_onnx   asr       tools/qa/asr.py (how to load Moonshine)
//   moonshine      Moonshine model folder                title, part   e.g. "ProxMate templates, VMs and consoles", "part two"
//   video_info     "1920x1080, 30 fps, 825.7 s"          chapter_ids   ["V01", ...]
//   sentences      number of sentences in lines.json     spot_lines    5 line ids spread across the video
//   end_card       seconds of end card after the last chapter
//   creator_note   optional, e.g. "V01, V02 and V03 are the creator's own words."
// Returns { confirmed, refuted, nits, syncSummaries, tech, asr }.

const A = typeof args !== 'undefined' && args ? args : {}
const need = (k) => {
  if (A[k] === undefined || A[k] === null || A[k] === '') throw new Error(`sync-review: missing args.${k} (tools/qa/workflow_args.py makes them)`)
  return A[k]
}
const VID = need('video'), PICTURE = need('picture'), CHAPTERS_JSON = need('chapters'), LINES = need('lines'), BEATS = need('beats')
const MANIFEST = need('manifest'), WORK = need('work'), PY = need('py'), ASR = need('asr'), MOONSHINE = need('moonshine')
const SHEETS = A.sheets || LINES.replace(/\/[^/]*$/, '') + '/sheets'
const SRT = A.srt || VID.replace(/\.mp4$/, '.srt')
const NARR_WAV = A.narration_wav || VID.replace(/\.mp4$/, '.narration.wav')
const TITLE = need('title'), PART = need('part'), VIDEO_INFO = need('video_info'), N_SENT = need('sentences')
const SPOT = need('spot_lines'), END_CARD = A.end_card ?? 7.5, CREATOR_NOTE = A.creator_note || ''
const CHAPTERS = need('chapter_ids')
const LAST = CHAPTERS[CHAPTERS.length - 1]

const CONTEXT = `
You are QA on a finished screen-recorded YouTube tutorial: "${TITLE}" (${PART} of a series about ProxMate, a web app that lets a homelab admin share a Proxmox VE cluster with friends). The PICTURE is locked (already edited and approved). A NEW narration track (text-to-speech, Kokoro voice af_heart, normal speed) was just laid over it. Your job is to check the new narration against the picture.

Files (read-only; do not modify anything outside ${WORK}):
- Final video: ${VID} (${VIDEO_INFO}). Chapter offsets: ${CHAPTERS_JSON} ([offset_seconds, chapter_id] pairs).
- Every narration line: ${LINES}. Fields: id, chapter, start/end (ABSOLUTE seconds in the final video), text, sentences, sentence_starts_abs, sheet.
- Review sheet per line: ${SHEETS}/<id>.jpg. It shows 4 frames taken while that line plays (start, 1/3, 2/3, end, each labeled with its absolute time) and the line's text underneath. Read these images with the Read tool.
- What each chapter shows: ${BEATS} ("on_screen" per chapter, "chapter_seconds"). Its "old_line" fields are the OLD narration and are irrelevant now.
- Need a frame at another moment? Run: ffmpeg -loglevel error -y -ss <abs_seconds> -i ${VID} -frames:v 1 -vf scale=1280:720 ${WORK}/<name>.png  and Read it. Make ${WORK} first (mkdir -p). Keep extra frames few and small; the disk is nearly full.

Rules for what counts as a problem:
- The wording was approved by the video's creator.${CREATOR_NOTE ? ' ' + CREATOR_NOTE : ''} Do NOT propose rewording for style. Propose new wording only when the narration is factually wrong about what the viewer sees or about how ProxMate behaves (a wrong label, a wrong number, a claim the screen contradicts). Keep any reword in the same plain, spoken, first-person style, with no colons, dashes, semicolons, parentheses or exclamation marks.
- Sync: a line should talk about what is on screen while it plays. Naming a click a moment before it happens or as it happens is good. A line that describes something the viewer cannot see at all during the line (not yet on screen, or gone well before it starts) is a problem. Being a second or two ahead while the action is visibly starting is fine. Talking during a fast-forward (a "▶▶ N×" badge) is fine when the line is about the wait.
- Timing fixes must be feasible. You may move a line's start within its chapter. Lines cannot overlap and need at least 0.25 s of silence before the next line starts (use lines.json start/end to check), and a line must end before its chapter ends (chapter end = next chapter's offset). The picture cannot change.
- Severity: blocker = a viewer would be confused or misled; should_fix = noticeably off but understandable; nit = minor. Be calibrated. Do not invent problems to have something to report, and do not wave real ones through.
`

const FINDING = {
  type: 'object',
  properties: {
    line_id: { type: 'string' },
    severity: { type: 'string', enum: ['blocker', 'should_fix', 'nit'] },
    kind: { type: 'string', enum: ['early', 'late', 'mismatch', 'fact', 'audio', 'caption', 'technical', 'other'] },
    issue: { type: 'string' },
    evidence: { type: 'string', description: 'which frames/times show it' },
    fix_type: { type: 'string', enum: ['move', 'reword', 'none', 'other'] },
    new_start_abs: { type: 'number', description: 'for move: new absolute start time in seconds' },
    new_text: { type: 'string', description: 'for reword: the full replacement line' },
    fix_note: { type: 'string' },
  },
  required: ['line_id', 'severity', 'kind', 'issue', 'evidence', 'fix_type'],
}
const SYNC = {
  type: 'object',
  properties: {
    chapter: { type: 'string' },
    lines_reviewed: { type: 'array', items: { type: 'string' } },
    findings: { type: 'array', items: FINDING },
    summary: { type: 'string' },
  },
  required: ['chapter', 'lines_reviewed', 'findings', 'summary'],
}
const VERDICT = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean', description: 'true if the finding is wrong, not a real problem, or the proposed fix would not help' },
    reasoning: { type: 'string' },
    better_fix_type: { type: 'string', enum: ['move', 'reword', 'none', 'other', 'same'] },
    better_new_start_abs: { type: 'number' },
    better_new_text: { type: 'string' },
  },
  required: ['refuted', 'reasoning', 'better_fix_type'],
}
const TECH = {
  type: 'object',
  properties: {
    checks: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, pass: { type: 'boolean' }, detail: { type: 'string' } }, required: ['name', 'pass', 'detail'] } },
    findings: { type: 'array', items: FINDING },
  },
  required: ['checks', 'findings'],
}

const syncPrompt = (cid) => `${CONTEXT}
Your chapter: ${cid}. Review EVERY line of chapter ${cid} in lines.json, in order. For each line, Read its sheet image and decide whether the narration matches what is on screen while it plays, and whether anything it says is contradicted by the screen (labels, names, numbers, which button or menu). Pull extra frames with ffmpeg when the four frames are not enough to decide (for example, to see exactly when a click or a dialog happens). Also note any line whose start or end lands awkwardly on a scene change.
Return every line id you reviewed in lines_reviewed, every problem in findings (an empty list is fine if the chapter is clean), and a two or three sentence summary of how the chapter plays.`

const verifyPrompt = (f, cid) => `${CONTEXT}
Another reviewer reported this problem in chapter ${cid}. Your job is to try to REFUTE it. Look for yourself: Read the sheet for ${f.line_id}, the sheets of its neighbours, and pull extra frames around the times involved. Default to refuted=true if, after looking, the problem is not clearly real, or if the proposed fix would break something (overlap with the next or previous line, less than 0.25 s silence, running past the chapter end, or a reword that is not factually better).
If the problem is real but the fix is wrong, set refuted=false and give a better fix (better_fix_type plus better_new_start_abs or better_new_text). If the problem and fix are both right, refuted=false and better_fix_type="same".

Reported finding:
${JSON.stringify(f, null, 1)}`

const techPrompt = `${CONTEXT}
You are the technical checker. Run each check below with ffmpeg/ffprobe/python3 (system python3 has PIL; for numpy/soundfile use ${PY}). Report each as a check with pass and detail, and anything that needs fixing as a finding (line_id "ALL" if not about one line).
1. Loudness of the final video's audio: integrated LUFS (target -16 +/- 1), true peak (<= -1.0 dBTP), loudness range. Use ffmpeg -af ebur128=peak=true.
2. The video stream must be bit-identical to the approved picture ${PICTURE}. Compare with: ffmpeg -loglevel error -i <file> -map 0:v -c copy -f md5 -  for both.
3. Exactly one video and one audio stream; audio AAC 48 kHz stereo; durations of the audio and video streams agree within 0.1 s.
4. The animated end card (the last ~${END_CARD} s, after chapter ${LAST} ends at offset(${LAST}) + chapter_seconds(${LAST})) must have NO narration over it: measure the audio level over that span (it should be near silence) and confirm the last line in lines.json ends before the end card starts.
5. No narration before 0.3 s; no line overlaps another (check lines.json start/end).
6. Captions: ${SRT}. Parse it: valid numbering and times, cues in order, no overlapping cues, no empty cues, every cue's text equals one sentence from lines.json, and all ${N_SENT} sentences appear exactly once in order. Report the fastest reading rate (characters per second) and list any cue above 20 cps.
7. Clipping: the narration mix ${NARR_WAV} must have no samples at or near full scale (|x| >= 0.999).
8. Spot-check placement: for ${SPOT.length} lines spread across the video (${SPOT.join(', ')}), measure the audio energy in the final video from start-0.3 to start+0.3 s (from lines.json) and confirm speech begins within about 0.15 s of the listed start.
Be precise and report the actual numbers.`

const asrPrompt = `${CONTEXT}
You are the speech checker. Confirm that the FINAL video's audio says every line correctly and at the right time.
Use the Moonshine recognizer through sherpa-onnx with the venv python ${PY}. See ${ASR} for how to load the model (model dir ${MOONSHINE}). Write your script under ${WORK}.
For each line in lines.json: decode the final video's audio (not the per-line wavs) from start-0.4 to end+0.4 seconds into mono 16 kHz float, pad 0.5 s of silence on both sides (Moonshine misses words at clip edges without padding), recognise it, and compare against the spoken form the voice was given: field "say" in ${MANIFEST} (same ids).
Normalise before comparing: lowercase, drop punctuation, split hyphens, treat these as equal: "s s h"=ssh, "v m"=vm, "c p u"=cpu, "i p"=ip, "g p u"=gpu, "p c i"=pci, "o s"=os, "l x c"=lxc, "h t t p s"=https, "eye so"=iso, "sue doo"=sudo, "tail scale"=tailscale, "cloud init"/"cloud in it"=cloudinit, "web oh one"/"web 01"/"web01"=web01, numbers written as digits or words. Recognisers often hear "Debian" as "Debbie in" and "ProxMate" as "Proximate"; those are recogniser quirks, not voice errors.
Report a finding for any line where a real word is missing, added, or clearly mispronounced in a way a listener would notice, or where audio from a neighbouring line bleeds into this line's window. List the mean match score in a check. Do not report recogniser spelling quirks as problems.`

const verified = []
const nits = []
const syncSummaries = []

const sync = pipeline(
  CHAPTERS,
  (cid) => agent(syncPrompt(cid), { label: `sync:${cid}`, phase: 'Sync review', schema: SYNC }),
  async (res, cid) => {
    if (!res) { log(`${cid}: reviewer returned nothing`); return null }
    syncSummaries.push({ chapter: cid, summary: res.summary, reviewed: res.lines_reviewed.length })
    const serious = res.findings.filter(f => f.severity !== 'nit')
    nits.push(...res.findings.filter(f => f.severity === 'nit').map(f => ({ ...f, chapter: cid })))
    const out = await parallel(serious.map((f, i) => () =>
      agent(verifyPrompt(f, cid), { label: `verify:${f.line_id}#${i}`, phase: 'Verify', schema: VERDICT })
        .then(v => ({ ...f, chapter: cid, verdict: v }))))
    verified.push(...out.filter(Boolean))
    return out
  },
)

const tech = agent(techPrompt, { label: 'technical', phase: 'Technical', schema: TECH })
const asr = agent(asrPrompt, { label: 'asr', phase: 'ASR', schema: TECH })

const [_, techRes, asrRes] = await Promise.all([sync, tech, asr])
const confirmed = verified.filter(f => f.verdict && !f.verdict.refuted)
const refuted = verified.filter(f => !f.verdict || f.verdict.refuted)
log(`sync: ${syncSummaries.length}/${CHAPTERS.length} chapters reviewed, ${verified.length} serious findings, ${confirmed.length} confirmed, ${nits.length} nits`)
return { confirmed, refuted, nits, syncSummaries, tech: techRes, asr: asrRes }
