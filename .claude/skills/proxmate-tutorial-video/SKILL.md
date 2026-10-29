---
name: proxmate-tutorial-video
description: Produce a ProxMate YouTube tutorial end to end the way parts one and two were made - plan from the code and docs, record the real ProxMate UI on a real Ubuntu desktop against a real Proxmox node, edit with zooms and sped-up waits, narrate in the creator's voice with Kokoro af_heart, time captions from the audio, QA with review workflows, and deliver the video, captions, chapters, YouTube description and tags, production notes and the repo script. Use for any new ProxMate tutorial, a re-voice or re-edit of an existing one, or upload packaging.
---

# ProxMate tutorial video

This is how the "Set Up Your ProxMate" series is made. Part one (first-time setup, 10:41) and part two
(templates, VMs and consoles, 13:46) were produced this way, and the creator called part two's final cut
"perfection". Follow the same steps for every new part.

Start by reading these:
- `reference/voice.md`: how the creator talks. It overrides everything else about wording.
- `docs/narration-style-guide.md` (repo root): the narration rules.
- `reference/lessons.md`: what went wrong before and the fix for each.

## Standing rules (from the creator)

- **Nothing fake on screen.** Use the real ProxMate frontend and backend, a real Ubuntu desktop, a real terminal,
  real windows moved by real input, and the docs website (https://proxmate.host) in the browser. When the
  sandbox can't provide something (a Proxmox feature, a network path), use a stand-in and disclose it in the
  production notes.
- **One cut, the female voice:** Kokoro `af_heart` at speed 1.0. Never speed a line up to fit; shorten it.
- **The same end card on every video:** `tools/edit/endcard/endcard.mp4` (7.5 s, "ProxMate. Your cluster shared
  safely. Visit proxmate.host to learn more"). Append it as is and never re-encode it. Its sha256 is
  `b4706f9dbad93fb2e49039bcc0707531fdc40659db56469b400d7160d2b7f1e4`.
- **Show the script before voicing it.** The creator approves the narration in writing before anything is
  voiced or re-voiced.
- **Write in the creator's voice** (`reference/voice.md`). The opener follows their form: "Welcome back to part
  N of the Set Up Your ProxMate series." The series name was still awaiting the creator's confirmation after
  part two, so ask if it is unconfirmed.
- **Ask before using the creator's Proxmox node pve1 for anything new.** Never touch its firewall or the
  production cluster. Clean up everything a video created, after final QA.
- **Secrets:** never print, log or commit a token, password, key or ticket. Read them programmatically, write
  new ones straight to 0600 files, and type lab passwords from environment variables.
- **Repo:** commit and push only to the branch the session names; no pull request unless asked; never put a model
  identifier in a commit or file. Scripts live in `docs/video-script-<slug>.md`.
- **Every video ships a YouTube description and tags**, ready to paste, alongside the video.

## Production timeline

Each step names its tools (all under `tools/`, each folder has a README) and ends at a check. **GATE** marks a
point where the creator must answer before work continues.

### 1. Set up or restore the machine
`reference/setup.md`. On a fresh container, install everything. After a restart, run `bring-up.sh` and
`start-desktop.sh`. Copy `reference/voice.md` to `~/.claude/youtube/voice.md`. Check the disk, which is small.

### 2. Map the feature from the code and the live docs
Run a workflow of parallel readers, one per area (for example templates, cloud-init, create VM, VM page,
consoles, docs). Each returns exact UI labels, routes, who can use what, prerequisites and known bugs. Read the
docs from https://proxmate.host. Every claim in the script must trace back to this map or the code.

### 3. Plan the lab and the chapters
Write `PLAN.md` (`tools/lab/examples/plan-part2.md` is the model). It lists the approval scope, everything that
will be created on pve1, the clean-up list, and the honesty rules (what is real, what is a stand-in, and how
that's disclosed). Chapters are `V01`, `V02`, and so on. V01 is a cold open showing the finished result; it plays
first and is recorded last.
**GATE:** ask before using pve1, and spell out what will be created and that everything is deleted afterwards.

### 4. Prepare the lab and rehearse (go/no-go)
- Create a dedicated Proxmox API token, writing its secret straight to a 0600 file. Use the `local`
  directory storage for VM disks.
- Cap pve1's write cache for the session.
- Fetch the assets the video needs (ISOs, container templates, images) and keep a CLEANUP list on pve1.
- Set ProxMate up through its API off camera (`pmapi.py`, `build_ubuntu.py`).
- Rehearse every on-camera action for real (`rehearse_deploy.py`, `rehearse_ops.py`) and time the waits.
- Probe any rig behaviour the recorder depends on.
Go only when every action works.

### 5. Write the script
- Use the format of `docs/video-script-vms-templates-consoles.md`: a header, the lab table, then
  `## Vnn · title` sections, each with an `[ON SCREEN: ...]` note and the narration lines.
- Write in the creator's voice. Lint with `voice/lint.py` and check spoken forms with `voice/sayform.py`.
- Keep each chapter's narration a little shorter than its action needs.
- Commit the script doc.
**GATE:** send the creator the script as downloadable markdown, and wait for "go" or their edits. When they
rewrite lines, their wording wins: fix only real typos and grammar, list every fix, and update
`reference/voice.md` with what their rewrite shows.

### 6. Voice the approved script for recording
- Render with `voice/render2.py`, then check `fit.py` and Moonshine (`qa/asr.py`). Add missing words with
  `voice/lexadd.py`; they go into `lexicon-additions.txt`, so commit that file.
- Convert the render with `voice/to_recorder.py` into `$PMV_WORK/narr/voice` for the recorder.

### 7. Record
- Write the recorder for this part from `record/examples/record-part2.cjs`, using `stage.cjs` (Chapter, `say`,
  `zoom`, `ffStart`/`ffEnd`), `xin.cjs` (real input) and `web.cjs` (read-only DevTools).
- Prepare with a prep script (`record/examples/prep-part2.cjs`) and start `tzpin.cjs`.
- Record in chapter groups, with the cold open last, and never assemble while recording.
- After each group, check contact sheets (`record/sheet.py`) and retake what's wrong.

### 8. Edit the picture
- Put the editor's decisions in `<take>/fx-edits.json` (keys in `edit/README.md`; part two's are in
  `edit/examples`): click rings, zooms, extra zooms, sped-up waits, moved or split lines, dissolves and fades.
- Build with `FX=1 ENDCARD=$SK/tools/edit/endcard/endcard.mp4 VOICE_DIR=$PMV_WORK/narr/voice python3
  edit/assemble.py <take> <out.mp4> V01 ... Vnn`.
- Review every ring and zoom (`edit/qa_fx.py`), colour (`edit/verifycolor.py`) and sync. An independent
  skeptic review (a subagent pulling frames for every caption) catches what you miss.
**GATE (optional):** if the creator wants to see the picture first, send it now.

### 9. Final narration and captions over the locked picture
- Make `beats.json` from the cut (`voice/build_beats.py`) and write the final narration with `at` times
  (`voice/windows.py` shows each window).
- Render (`render2.py`), check fit (`fit.py`), time the captions (`align.py`, plus hand overrides in
  `$PMV_WORK/align-overrides.json`), and place everything over the picture (`place.py`: -16 LUFS, the video
  stream copied untouched, an SRT).
- When the narration from step 6 is already final, this step still runs, because it gives the captions and
  loudness their final form.

### 10. QA, then fix, then QA again
- Build review sheets (`qa/sheets.py`).
- Run `qa/workflows/sync-review.js`: one sync reviewer per chapter, an adversarial verify of each finding, and
  the technical and speech checks.
- Fix what is confirmed, then run `round2-verify.js` on the changes and `captions-verify.js` on the subtitles.
  `qa/README.md` lists the args each needs.
- Done means: no blocker or should-fix finding open, every word heard, loudness between -17 and -15 LUFS, no
  narration over the end card, and the picture bit-identical to the approved edit.

### 11. Package
- **Chapters:** `docs/ytchapters.py` with a `titles.json`. The first chapter is 00:00, there are at least
  three, and each is at least 10 s.
- **YouTube description and tags:** run the `yt-seo` skill with `reference/voice.md`.
  `reference/examples/youtube-description-part2.md` is the model. It has:
  - first two lines carrying the words people search for;
  - links (proxmate.host, the docs page, GitHub, the previous part);
  - the chapters, what's covered, who it's for and what it assumes;
  - the versions recorded on, known bugs viewers will hit, and an optional text-to-speech note;
  - up to 15 tags (names and spellings, not a wall);
  - the three target searches checked against the first two lines.
  Mark placeholders the creator must fill (the previous part's link). End with "Ship it, or change it?"
- **Production notes:** what is real on screen, the sped-up waits table, everything to disclose (stand-ins,
  ProxMate bugs, passwords seen on screen, sandbox-only accommodations), how the narration and captions were
  made and checked, and the lab clean-up. Part two's notes are the model.
- **Repo:** regenerate the script doc with the start time of each line (`docs/gen_repo_doc.py`), then commit and
  push.

### 12. Deliver
Send the video with SendUserFile (display `render`). Send the SRT, chapters, description and tags, production
notes and script doc as attachments. Give the full path of the delivery folder, and say what the creator
still has to decide: placeholders, series name, anything left open.
**GATE:** nothing is published by Claude. The creator uploads.

### 13. Clean up the lab
Once the creator accepts the cut, run `cleanup_pve1.py` (dry run first, then through ProxMate, then
leftovers on pve1). Restore pve1's settings, delete the API token, and report what was removed and what was
left on purpose.

## Working with the creator

- They follow along in the Claude app. Give short progress lines during long steps. QA workflows take a while,
  because only two agents run at a time on this machine.
- Use workflows for anything wide: feature mapping, reviews, QA. Verify findings adversarially before acting
  on them.
- When they give feedback on wording, apply it everywhere (part two's "no IDE" note covered the outro too) and
  say so.
- When they approve something, carry it into this skill if it should hold for future parts.
