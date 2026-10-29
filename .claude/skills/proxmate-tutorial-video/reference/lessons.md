# Lessons from parts one and two

Every entry here cost a retake, a rejected cut or a lost hour. Read the section for the step you are on.

## What the creator rejects

- **Mockups.** The first part-one video rebuilt the UI as motion graphics: rejected ("a one for one copy of
  ProxMate ... Not mockups!"). The second used headless Playwright pages, a fake cursor and an xterm.js page posing
  as a terminal: rejected as not looking like a real computer. Only things that cannot exist in the sandbox may be
  stand-ins, and every stand-in is disclosed in the production notes.
- **Robotic narration.** Two part-two scripts were rejected ("too robotic, too artificial", then "odd and
  sterile"). Causes: clipped fragments, colon labels, counted teasers, three-item recaps, praise with no reason,
  about 7 words a sentence, and the installed script-writer skill's "short, punchy" default (stop using it). What
  worked: the creator's own rewrite of V01 to V03 as the model voice, `reference/voice.md` and
  `docs/narration-style-guide.md`.
- **A voice they dislike.** Piper's ryan voice was "horrible". Kokoro `af_heart` (female) is the voice from part
  two on; the creator found it more legible than the male `am_michael`. One cut only, female.
- **Describing what isn't on screen.** "Red!" and "Green!" over a dark grey toast; "flags issues" for a static
  tips card; "There's that busy CPU" over a flat chart; "ubuntu fills in" implying the key did it. Say only what
  the viewer can see and what ProxMate really does (check the code when a line claims behaviour).

## Writing narration

- The voice reads about 195 words a minute at speed 1.0. Fit lines to the picture by cutting words, never by
  speeding the voice up. Part two's final pace was about 140 words a minute over the picture.
- Write numbers as words. Digits are not in the lexicon, and Kokoro skips any word it cannot find **silently**
  (only an "OOV word skipped" log line). Run every line through `sayform.py` and render only with an empty OOV list.
- Spoken forms for names: web-01 is "web oh one", sudo is "sue doo", SSH is "S S H", ISO is "eye so",
  Ctrl+Alt+Del is "control alt delete". New words go into `tools/voice/spoken_forms.py` (EPISODE) or the lexicon.
- `lint.py` bans "insights", but Insights is also a tab: "the Insights tab" is allowed. Its fit check is an
  estimate; `fit.py` on a real render decides.
- The creator's sentences break some generic rules (a 28-word list sentence, a 5-word line). Their style wins over
  the linter.

## The voice renderer

- sherpa-onnx 2.0.0's text path splits at every comma, voices each piece as its own sentence, glues pieces under
  five words together with no space and concatenates with no pause. That made part two's first narration sound
  run together. `render2.py` sends lexicon phonemes for the whole line in one call instead, with spaces and
  `, . ?` kept, at speed 1.0. Never go back to the text path or to per-line speed-ups.
- Renders are not bit-reproducible (onnxruntime threads); lengths vary by milliseconds.
- Run TTS and ASR with the venv python. The system python3 lacks soundfile and sherpa_onnx, but it has Pillow
  for the contact sheets.

## Captions

- Sentence starts estimated by character share were up to 0.65 s off: Kokoro's sentence pauses are no longer
  than its comma pauses, and stop consonants make dips that look like pauses. `align.py` tries each nearby pause
  and keeps the split whose halves Moonshine hears as the right text. Compare letters, not words: the voice is
  given "G P U" and the recogniser writes "GPU".
- `align.py` still misses a few (a /k/ closure in "box"). Measure those by hand and put them in an overrides
  file.
- Long sentences are split at a comma pause into two captions. A piece under 1.4 s flashes past, so it rejoins
  its sentence. A piece faster than 20 characters a second rejoins its neighbour. At most two rows.
- Moonshine misses words at clip edges: pad 0.5 s of silence on both sides. Its quirks ("Debbie in" for Debian,
  "Proximate" for ProxMate, "WebO1", "Sue doo") are not voice errors.

## Recording rig

- GNOME Shell under Xvfb needs a system D-Bus and a tmpfs over /run/systemd (no logind). GNOME Terminal needs
  python3.12 bind-mounted over the sandbox's 3.13 inside the desktop namespace, and LANG/LC_ALL set.
- Chromium refuses remote debugging on its default profile: use `--user-data-dir=~/.config/chromium-alex`, and
  `--class=chromium-browser` with `StartupWMClass=chromium-browser` so the dock groups it. Trust the lab CA in NSS
  instead of using certificate-error flags, which show a warning bar.
- Every click is a real X11 event (xdotool); DevTools only reads positions. Both Chromium windows (incognito
  included) share one DevTools context: tag tabs with `window.name` (`pm-admin`, `pm-mike`) and find them by tag.
- Native `confirm()` dialogs only render when every DevTools client has a dialog listener: add
  `p.on('dialog', noop)` (tzpin.cjs and taggedPage do), then click OK with real input.
- The omnibox autocompletes from history: press Delete before Return. A fresh Chromium focuses the address
  bar: click the page first. Clipboard copy buttons fail on plain HTTP: triple-click and Ctrl+C, then check with
  `xclip -o`.
- The cursor is a 32 px Yaru pointer (gsettings plus `xrdb`); Chromium must be restarted to pick it up.
- A click aimed at a covered window lands on the wrong app: switch apps through the dock, move the pointer off
  the dock afterwards (tooltips).
- Ctrl-click opens a background tab, so Ctrl+W then closes the wrong one. Click the new tab first, close it,
  and check which page closed.
- Two serial-console sessions on one VM corrupt each other: leave the console page before popping one out. The
  pop-out's title bar sits about 18 px above xwininfo's visible rectangle.
- Never encode or assemble while a take records: Chromium and Xvfb were OOM-killed mid-take. Record the cold
  open last, from the finished state.
- Wait for results on screen, not for time: the cold open moved on before "Hello from Docker!" appeared.
  Use `termText` or a DevTools read and hold the zoom on the result.
- `pkill -f` and `pgrep -f` match their own shell (exit 144 or 255) and kill the tool call. Kill by PID, anchor
  the pattern (`^node record2.cjs`), use `pgrep -x`, or check `/proc/<pid>/cmdline`.
- The harness refuses foreground `sleep N`. Wait with Monitor until-loops or background tasks.

## Lab and Proxmox

- The part-one stand-in (`pve-lab.py`) runs VMs as LXC containers. It can't show the graphical console, so part
  two used the creator's real nested node pve1, after asking. Ask again before any new kind of change there.
- pve1's local-lvm thin pool wrote at about 2 MB/s, slow enough to time out ProxMate's template build (502
  "Proxmox task timed out"). VM disks go on the `local` directory storage as qcow2, and ProxMate's default storage
  is set to `local`.
- Big copies stalled Proxmox's API behind fsync (13.6 s replies; ProxMate times out at about 15 s). Cap the write
  cache for the session (`sysctl -w vm.dirty_background_bytes=8388608 vm.dirty_bytes=33554432`) and restore it
  in clean-up.
- Nested KVM: the outer VM's CPU type must be "host", and only a full Shutdown and Start applies it (a reboot
  doesn't).
- Killed imports can leave LVM stuck on a udev cookie: `dmsetup udevcomplete_all -y`, then
  `qm destroy --destroy-unreferenced-disks 1 --purge 1`.
- ProxMate API calls from scripts need the `X-CSRF-Token` header from the `proxmate_csrf` cookie. Too many
  logins trip its rate limiter (restart the backend). Lab calls must bypass the egress proxy
  (`ProxyHandler({})`, `curl --noproxy '*'`).
- Prisma resolves `file:` database paths relative to `backend/prisma`.
- part one's `s03-preroll.cjs` deletes the `proxmate` token that later parts use. Don't run it.
- Keep the world honest for the camera. If something exists off camera before its scene (a template published
  before the scene that publishes it), hide it first (part two flipped `published` with Prisma) and restore it
  afterwards.
- Clean up pve1 only after final QA, so retakes stay possible. Dry-run first, delete through ProxMate first
  (so its records follow), then remove leftovers on pve1 and restore its settings.

## ProxMate itself (v1.3.4)

- The Roll back, snapshot Delete, MateState Restore and Delete, and Settings "Enable enforcement" dialogs never
  close. `AlertDialogAction` is a plain Button, not `AlertDialogPrimitive.Close`, and those dialogs keep no open
  state. The recorder waits for the result toast, then presses Esc. Disclose it in the notes.
- The browser console can start at 80x24, because ProxMate attaches its message handler after an await. A real
  window resize makes xterm send its size again.
- "Keep on top" for the pop-out console needs HTTPS (Document Picture-in-Picture). On the plain-HTTP lab, name
  it instead of clicking it.
- The Optimization tips card is static (it always suggests the guest agent).
- The wizard sets the cloud username from the template's OS before a key is picked.

## Edit and colour

- Colour that drifts from dark grey to blue is an untagged or BT.601-guessed matrix. Capture lossless RGB, then
  convert with `scale=out_color_matrix=bt709:out_range=tv` and tag bt709 tv. `verifycolor.py` compares
  against the capture.
- One ffmpeg graph over every span buffered all the decoded frames and was OOM-killed: encode each span on
  its own, then concat-copy.
- Ubuntu Sans has no ▶ glyph: the fast-forward badge uses DejaVu Sans Bold.
- Review every ring and zoom on contact sheets before delivery. Zooms that are too short bounce in and out, and
  rings on clicks that only focus a black console look wrong.
- A line that runs ahead of what it names leaves dead air after it. In the edit, `move_say` and `split_say` fix
  it; over a locked picture, move the line's `at`.

## Environment

- Everything outside the repo lives in this container and disappears with it: the models, venv, lab, takes,
  deliverables and `~/.claude` skills. Commit what must last (this skill does), and say where deliverables are.
- The disk is small (it fell to 1.4 GB free). Delete superseded QA frames and builds early, keep extracted
  frames small, and never copy models or videos into the repo.
- Egress goes through an agent proxy. Hugging Face and jsdelivr are blocked; models come from the sherpa-onnx
  GitHub releases. proxmate.host and `*.tailscale.com` had to be added to the environment's allowed domains by
  the creator.
- After a container restart, files survive and processes don't. `tools/lab/bring-up.sh` restores the lab, then
  start the desktop and `ts-lab/start.sh` before using pve1.
- Secrets were printed twice in part one (`cat` of a token file, a debug log of a console ticket). Read secrets
  programmatically only, write new tokens straight to a 0600 file, and never log auth frames.
- QA workflows run two agents at a time on this 4-CPU machine. Prepare deliverables while they run, and tell the
  creator it takes a while.
