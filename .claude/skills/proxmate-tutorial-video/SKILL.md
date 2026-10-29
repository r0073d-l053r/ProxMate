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
- `reference/narration-style-guide.md`: the narration rules. It's a copy of the repo's
  `docs/narration-style-guide.md`, so keep the two in sync.
- `reference/lessons.md`: what went wrong before and the fix for each.

In commands, `$SK` is the absolute path of this skill's folder. In the ProxMate repo:

```
SK=$(git rev-parse --show-toplevel)/.claude/skills/proxmate-tutorial-video
```

Anywhere else, it's wherever the skill was unpacked (see `INSTALL.md`).

`$PMV_WORK` is the video's working folder (default `~/pmv/work`).

## Standing rules (from the creator)

- **Nothing fake on screen.** Use the real ProxMate frontend and backend, a real Ubuntu desktop, a real terminal,
  real windows moved by real input, and the docs website (https://proxmate.host) in the browser. When viewers
  must change something in Proxmox, show the real Proxmox web UI in a browser tab, in Proxmox's dark theme. When
  the sandbox can't provide something, use a stand-in and disclose it in the production notes.
- **One cut, the female voice:** Kokoro `af_heart` at speed 1.0. Never speed a line up to fit; shorten it.
- **The same end card on every video:** `tools/edit/endcard/endcard.mp4` (7.5 s, "ProxMate. Your cluster shared
  safely. Visit proxmate.host to learn more"). Append it as is and never re-encode it. Its sha256 is
  `b4706f9dbad93fb2e49039bcc0707531fdc40659db56469b400d7160d2b7f1e4`.
- **Show the script before voicing it.** The creator approves the narration in writing before anything is voiced
  for the final mix. Changed wording needs approval again.
- **Write in the creator's voice** (`reference/voice.md`). The opener follows their form: "Welcome back to part
  N of the Set Up Your ProxMate series."
- **pve1 is the creator's node.** Ask before using it for anything new. Keep the work to exactly what was
  approved, with no extra safeguards or "improvements" (the creator: "you're overthinking"). Never touch its
  firewall or the production cluster. Clean up everything a video created after the creator accepts the final
  cut, or when they ask.
- **Secrets.** Never print, log or commit a token, password, key or ticket, and never ask the creator to paste
  one. Read them programmatically, write new ones straight to 0600 files, and type lab passwords from environment
  variables.
- **Repo.** Commit and push only to the branch the session names, with no pull request unless asked. End
  commits with the attribution trailers from the session's instructions. Keep model identifiers out of files and
  commit bodies. Scripts live in `docs/video-script-<slug>.md`.
- **Every video ships a YouTube description and tags**, ready to paste, alongside the video, plus a LinkedIn
  teaser clip that ends on the same end card, with a short post to go with it.

## Production timeline

Each step names its tools (all under `$SK/tools/`, one README per folder) and ends at a check. **GATE** marks a
point where the creator must answer before work continues.

### 1. Set up or restore the machine
Follow `reference/setup.md`.
- **Fresh container:** install everything, then copy `reference/voice.md` to `~/.claude/youtube/voice.md`.
- **After a restart:** run `tools/lab/bring-up.sh`, which also starts the desktop. When pve1 is needed, also run
  `tools/lab/pve-real.sh on` and mount pve1's snippets.
- Check the disk; it is small.

**GATE (fresh container only):** the creator has to act before anything can reach pve1. Send step-by-step
instructions with exact links, written as if they've never done it:
- Keep the allowed domains: proxmate.host (optionally challenges.cloudflare.com, never analytics.proxmate.host)
  and `*.tailscale.com`.
- Approve the new Tailscale device in a private window, and remove the stale one.
- Add the new pve1-lab public key through pve1's web shell, and remove the old one.

### 2. Map the feature from the code and the live docs
- Find the ProxMate version the lab box runs. Clone that tag into a scratch folder
  (`git clone --depth 1 --branch vX.Y.Z ...`) and map from there. Never check out over the repo's working tree:
  the working branch is not the release, so its labels and routes can differ from the screen.
- Run a workflow of parallel readers, one per area (for example templates, cloud-init, create VM, VM page,
  consoles, docs). Each returns exact UI labels, roles and ids, routes, who can use what, prerequisites and
  known bugs. Read the docs from https://proxmate.host.
- Every claim in the script must trace back to this map or the code.

### 3. Plan the lab and the chapters
- Start with a read-only inventory of pve1: `pveversion`, CPUs and KVM, free memory, `pvesm status`,
  `qm list`, storage.cfg.
- Write `PLAN.md` (`tools/lab/examples/plan-part2.md` is the model). It lists every change to pve1 with its
  restore command:
  - the API token;
  - storage content (`snippets`, and `images,rootdir` on `local`);
  - the write-cache cap;
  - snippet files, ISOs, container templates and hand-made templates;
  - the `/root/proxmate-lab` working folder and its CLEANUP file;
  - the VMs, which get home-LAN addresses.
- Add the honesty rules: what is real, what is a stand-in, and how it's disclosed.
- Chapters are `V01`, `V02`, and so on. V01 is a cold open showing the finished result; it plays first and is
  recorded last.

**GATE:** ask before using pve1. List exactly what will be created or changed, and say that everything is
deleted afterwards. Nothing else on pve1 is in scope.

### 4. Prepare the lab and rehearse (go/no-go)
`tools/lab/README.md` has the commands.
- Create the API token, writing its secret straight to a 0600 file and never printing it. Point the lab address
  at pve1 (`pve-real.sh on`) and sshfs-mount pve1's `/var/lib/vz/snippets` on `/mnt/pve-snippets`. Without the
  mount, cloud-init extras land in the wrong folder.
- Put VM disks on the `local` directory storage and cap pve1's write cache, as approved.
- Fetch the assets the video needs (ISOs, container templates, images) and keep the CLEANUP list on pve1.
- Reset ProxMate and set it up off camera through its API (`pmapi.py`; the order of calls is in the lab
  README), then build the templates the script assumes already exist (`build_ubuntu.py`).
- Rehearse every on-camera action for real (`rehearse_deploy.py`, `rehearse_ops.py`) and time the waits. Probe
  any rig behaviour the recorder depends on.
- Delete the rehearsal guests and backups. Confirm through the API that the world matches the script's lab
  table.

Go only when every action works.

### 5. Write the script
- Use the format of part two's script (`docs/video-script-vms-templates-consoles.md` in the repo, copied to
  `reference/examples/video-script-part2.md`): a header, the lab table, then
  `## Vnn · title` sections, each with an `[ON SCREEN: ...]` note and the narration lines.
- Write in the creator's voice, a little shorter than each chapter's action needs.
- Turn it into `$PMV_WORK/narration.json` with `voice/script_to_narration.py`.
- Check it with `voice/lint.py --no-fit` and `voice/sayform.py`. The OOV list must be empty: Kokoro skips unknown
  words silently.
- Commit the script doc.

**GATE:** send the creator the script as downloadable markdown, and wait for "go" or their edits. When they
rewrite lines, their wording wins: fix only real typos and grammar, list every fix, and update
`reference/voice.md` with what their rewrite shows.

### 6. Voice the approved script for recording
- Render with `voice/render2.py`, then check with Moonshine (`qa/asr.py`). Add missing words with
  `voice/lexadd.py`; they go into `lexicon-additions.txt`, so commit that file.
- Convert the render with `voice/to_recorder.py` into `$PMV_WORK/narr/voice`. The recorder paces itself with
  these clips, so the real fit check comes in step 9.
- Never use part one's text-path renderer: it ran words together.

### 7. Record
- Write the recorder for this part from `record/examples/record-part2.cjs`, using `stage.cjs` (Chapter, `say`,
  `zoom`, `ffStart`/`ffEnd`), `xin.cjs` (real input) and `web.cjs` (read-only DevTools). Take labels, roles and
  ids from the frontend source. Check recorders with `node --check`; never `require()` one.
- Before a take, stop any old `tzpin.cjs`, close Chromium (`pkill -x chrome`) so it picks up the 32 px cursor,
  run the prep script (`record/examples/prep-part2.cjs`), then start `tzpin.cjs`.
- Record in chapter groups, with the cold open last. Never encode or assemble while recording.
- After each group, check contact sheets (`record/sheet.py`) and retake what's wrong.

### 8. Edit the picture
- Put the editor's decisions in `<take>/fx-edits.json` (keys in `edit/README.md`; part two's are in
  `edit/examples`): click rings, zooms, extra zooms, sped-up waits, moved or split lines, dissolves and fades.
- Build:

  ```
  mkdir -p $PMV_WORK/out
  FX=1 ENDCARD=$SK/tools/edit/endcard/endcard.mp4 VOICE_DIR=$PMV_WORK/narr/voice \
    python3 $SK/tools/edit/assemble.py $PMV_WORK/rec/<take> $PMV_WORK/out/<name>.mp4 V01 V02 ... Vnn
  ```

- Review every ring and zoom (`edit/qa_fx.py`) and the colour (`edit/verifycolor.py <take> V03@20 V08@10 ...`).
  An independent skeptic review, a subagent pulling frames for every caption, catches what you miss.

**GATE (optional):** if the creator wants to see the picture first, send it now.

### 9. Final narration and captions over the locked picture
- Make `beats.json` from the cut (`voice/build_beats.py`, which runs with the system python3). Set each line's
  `at` from its slot's start, or from the beat windows (`voice/windows.py`) when lines change.
- Run the full `voice/lint.py`, render (`render2.py`) and check the fit (`fit.py`).
- Time the captions (`align.py`, with hand overrides in `$PMV_WORK/align-overrides.json`).
- Place everything over the picture with `place.py`: -16 LUFS, the video stream copied untouched, and an SRT.

**GATE:** if any line's wording differs from the script approved in step 5, send the changed script
(`voice/to_markdown.py`) and wait before the final render. Test renders for fit and OOV checks are fine before
approval. QA's factual fixes (like part two's V08 line) are listed to the creator at delivery.

### 10. QA, then fix, then QA again
- Build review sheets (`qa/sheets.py`, which runs with the system python3).
- Run `qa/workflows/sync-review.js`: one sync reviewer per chapter, an adversarial verify of each finding, and
  the technical and speech checks.
- Fix what is confirmed. Then run `round2-verify.js` on the changes and `captions-verify.js` on the subtitles.
  `qa/README.md` lists the args each needs.

Done means:
- no blocker or should-fix finding is open;
- every word is heard;
- loudness is between -17 and -15 LUFS, with true peak at or below -1 dBTP;
- no narration plays over the end card;
- the picture is bit-identical to the approved edit;
- captions have no overlaps, at most two rows each, read at 20 characters a second or slower, and none is
  shorter than 1.4 s.

### 11. Package
- **Chapters:** `tools/docs/ytchapters.py` with a `titles.json`. The first chapter is 00:00, there are at least
  three, and each is at least 10 s.
- **YouTube description and tags:** run the `yt-seo` skill with `reference/voice.md`.
  `reference/examples/youtube-description-part2.md` is the model. It has:
  - first two lines carrying the words people search for;
  - links (proxmate.host, the docs page, GitHub, the previous part);
  - the chapters, what's covered, who it's for and what it assumes;
  - the versions recorded on, known bugs viewers will hit, and an optional text-to-speech note;
  - up to 15 tags (names and spellings, not a wall);
  - the three target searches checked against the first two lines.

  Check the limits with a one-liner: description under 5,000 characters with no `<` or `>`, tags under 500
  characters counting commas. Mark placeholders the creator must fill, such as the previous part's link. End with
  "Ship it, or change it?"
- **LinkedIn teaser:** about 30 s made with `tools/edit/teaser.sh <full.mp4> <start> <end> <out.mp4>`. Pick about
  23 s that open on a complete thought and end on a finished line (part two used its cold open, 0:00 to 0:23.6).
  The script fades out, appends the end card unchanged (and checks it frame by frame), and cuts the captions.
  LinkedIn autoplays muted, so the creator uploads the `.srt` with it.
- **LinkedIn post:** a short post in the creator's voice, with the YouTube link going in the first comment
  (`reference/examples/linkedin-post-part2.md`). Don't use "excited to share", and don't invent numbers.
- **Production notes:** what is real on screen, the sped-up waits table, everything to disclose (stand-ins,
  ProxMate bugs, passwords seen on screen, sandbox-only accommodations), how the narration and captions were
  made and checked, and the lab clean-up. `reference/examples/production-notes-part2.md` is the model.
- **Repo:** regenerate the script doc with the start time of each line (`tools/docs/gen_repo_doc.py`), then
  commit and push.

### 12. Deliver
Send the video and the teaser with SendUserFile (display `render`). Send the SRTs, chapters, description and
tags, LinkedIn post, production notes and script doc as attachments. Give the full path of the delivery folder. Say what the creator still has
to decide: placeholders, the series name, anything left open, and any wording QA changed.

**GATE:** Claude never publishes anything. The creator uploads.

### 13. Clean up the lab
Once the creator accepts the final cut, or asks:
- Run `cleanup_pve1.py`: a dry run first, then deletion through ProxMate, then leftovers on pve1.
- Restore pve1's settings and delete the API token.
- Unmount `/mnt/pve-snippets` (`fusermount -u`) and run `pve-real.sh off`.

Report what was removed and what was left on purpose. If the session may end before the creator decides, ask
whether to clean up now.

## Working with the creator

- They follow along in the Claude app. Give short progress lines during long steps. QA workflows take a while,
  because only two agents run at a time on this machine.
- When they need to do something themselves, give step-by-step instructions with links to exactly where to go,
  as if it's their first time.
- When they say to keep going (for example overnight), work on your own between gates and report at the gates.
- Use workflows for anything wide: feature mapping, reviews, QA. Verify findings adversarially before acting on
  them.
- When they give feedback on wording, apply it everywhere (part two's "no IDE" note covered the outro too) and
  say so.
- When they approve something, carry it into this skill if it should hold for future parts.

## Series state and open items (after part two)

- **Series name:** "Set Up Your ProxMate" comes from the creator's dictated opener, which said "Props Mate".
  They haven't confirmed it yet.
- **Part one:** it has no current description or tags. `reference/examples/youtube-package-part1.md` was
  written for an earlier, rejected cut. Part two's description has a placeholder for part one's link.
- **The ProxMate IDE** gets its own video. Part two doesn't mention it.
- **ProxMate bugs** seen on camera are disclosed, not fixed: the v1.3.4 dialogs that don't close, and the
  console's first resize. Open a PR only if asked.
