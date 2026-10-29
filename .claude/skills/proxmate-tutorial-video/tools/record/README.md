# Recording tools

Everything on camera is a real X11 event on a real Ubuntu (GNOME Shell) desktop: xdotool moves the pointer, clicks
and types; Chromium's DevTools protocol is only used to *read* where things are. Each chapter is captured losslessly
(x11grab, RGB) while a virtual narrator schedules the narration lines against what actually happens, and the
recorder logs every click, zoom request and fast-forward span for the edit (`../edit/`).

Needs: node with `playwright` (1.63.0 on the original rig, resolved from the global node path), python3 with
Pillow, ffmpeg, xdotool, wmctrl, xwininfo, xprop, xclip, ImageMagick `import`, Xvfb, GNOME Shell (Yaru theme).
Chromium must listen for DevTools on `$PMV_CDP`: on the original rig the dock's `chromium.desktop` runs
`/usr/local/bin/chromium-browser`, a wrapper (`../lab/chromium-browser`) that starts `/opt/chromium/chrome` with
`--remote-debugging-port=9222 --remote-allow-origins=* --force-device-scale-factor=1`, its own profile
(`~/.config/chromium-alex`) and optional proxy settings. The desktop user is `alex` (hostname `alex-desktop`).

## Working folder and environment

One working folder per video, `$PMV_WORK` (default `~/pmv/work`):

```
$PMV_WORK/narr/voice/            narration manifest.json + line WAVs (from ../voice), read by the recorder
$PMV_WORK/rec/<take>/state.json  what carries over between runs (window ids, VM ids...)
$PMV_WORK/rec/<take>/chapters/   <id>.mkv (lossless capture) and <id>.json (timeline, below)
$PMV_WORK/rec/<take>/fx-edits.json   the editor's decisions (see ../edit/README.md)
$PMV_WORK/logs/                  xvfb.log, session.log
```

| Variable | Meaning | Default |
|---|---|---|
| `PMV_WORK` | per-video working folder | `~/pmv/work` |
| `PMV_DISPLAY` | X display of the desktop | `:1` |
| `PMV_CDP` | Chromium DevTools endpoint | `http://127.0.0.1:9222` |
| `VOICE_DIR` | narration folder the recorder reads | `$PMV_WORK/narr/voice` |
| `PROXMATE_URL` | the ProxMate web app | `http://192.168.1.50:3000` |
| `PROXMATE_API` | ProxMate API (part two polls it) | `http://192.168.1.50:4000/api` |
| `TAKE`, `ONLY` | take name; chapters to record, in order | per recorder |
| `PMV_ADMIN_PASSWORD`, `PMV_FRIEND_PASSWORD`, `PMV_VM_PASSWORD`, `PMV_CT_PASSWORD` | lab passwords typed on camera | none: set them |

Never write a password into a recorder: read it with `env('PMV_...')`.

A chapter timeline (`chapters/<id>.json`) is `{id, title, file, duration, events}`; events have `type` and `t`
(seconds from the first captured frame): `say` (`idx, file, dur, text`), `click` (`x, y`), `zoom` (`rect: [x, y, w, h]`),
`unzoom`, `ffStart` (`label, target` seconds) and `ffEnd`.

## Tools

**start-desktop.sh**: starts Xvfb (1920x1080, 96 dpi) on `$PMV_DISPLAY`, the system D-Bus, and alex's GNOME Shell
session in its own UTS namespace (hostname `alex-desktop`). Run as root: `bash start-desktop.sh`. Logs in `$PMV_WORK/logs`.

**session.sh**: the session itself (dark Yaru theme, dock favourites Files/Chromium/Terminal, no idle lock, no
notification banners, no hot corners). Install it once as `/home/alex/.desktop-session.sh`; start-desktop.sh runs it.

**asalex.sh**: runs a command as alex inside the live session (same namespace and D-Bus session bus as GNOME Shell),
e.g. for `gsettings`. `bash asalex.sh gsettings set org.gnome.desktop.interface cursor-size 32`

**xin.cjs**: real input. Human-ish pointer paths (eased, slightly arced), clicks, drags, wheel scrolls, typing with
a natural rhythm, key combos, clipboard (as alex, waiting until X really serves it), window lists and geometry
(visible rect without the client-side shadow). Set `x.onClick` to log clicks (the recorders do). `const x = require('./xin.cjs')`

**web.cjs**: `Web.connect()` attaches to Chromium over DevTools; `w.page(pred)`, `w.click/move/type/select(p, locator)`
scroll the element into view with the real wheel, then act with xin.cjs; `w.go(url)` types into the address bar;
`w.toast(p, re)` reads a toast. `captionButtons(id, kind)` gives close/maximize/minimize positions on a title bar.

**stage.cjs**: `new Chapter(id, loadNarration(voiceDir), outDir)`. `begin()` starts the capture, `say(i | text)`
starts a narration line once the previous one has finished (actions run while it plays), `during(frac)` waits to a
point in the current line, `quiet()` waits for it to end, `zoom(rect)`/`unzoom()` ask the edit for an eased zoom,
`ffStart(label, target)`/`ffEnd()` mark a real wait to speed up, `end()` stops and writes the timeline. Also
`waitPrompt` (terminal prompt stamps from alex's PROMPT_COMMAND, installed in ../../reference/setup.md section 2) and `waitInput` (a process blocked reading its tty).

**tzpin.cjs**: keeps every Chromium page on the desktop clock's UTC offset (DevTools time-zone override), so
times ProxMate shows agree with the top bar. Run in the background for the whole take: `node tzpin.cjs &`

**calib.cjs**: checks the page-to-screen mapping web.cjs relies on: puts a marker at page (200, 150), screenshots
the screen and prints the window metrics and where the marker landed. `node calib.cjs [screenshot.png]`

**sheet.py**: contact sheet of one chapter capture, one frame per narration line. `python3 sheet.py <take dir> <id> [fraction]`
writes `<take>/sheets/<id>-sheet.png`.

**clicklag.py**: how late each logged click is against the first visible change under the pointer (median and
quartiles); what `ripple_lead` in fx-edits.json corrects. `python3 clicklag.py <take dir> <id> [<id>...]`

**clickchange.py**: frame-by-frame change around one click, to check fx.py's page-change detection before writing a
`page_change` override. `python3 clickchange.py <take dir> S06@41.2 [...]`

## Examples (copy one to start a new video's recorder)

**examples/record-part2.cjs**: part two's recorder (templates, cloud-init, VMs, consoles, against real Proxmox
node pve1): the newest patterns, e.g. API polling for waits, confirm() dialogs clicked on screen, xterm text
positions, Ctrl-click, pop-out windows, a second (incognito) user. Chapters V02..V20, then the cold open V01.
`PMV_WORK=~/pmv/work/part2 TAKE=t2a ONLY=V02,V03 node examples/record-part2.cjs`

**examples/prep-part2.cjs**: part two's off-camera pre-roll: Chromium maximized, signed in, the admin tab tagged
`pm-admin` on the Template Store. Run before the recorder: `TAKE=t2a node examples/prep-part2.cjs`

**examples/record-part1.cjs**: part one's recorder (first-time setup: docs, Proxmox API token, installer, setup
wizard, settings, invite, a friend's first VM). Chapters S02..S15, then the cold open S01. It also calls part one's
lab scripts (`$PMV_LAB/pve-real.sh`, `s03-preroll.cjs`, `setclock.sh`), reads Proxmox tokens from
`$PMV_PVE_TOKENS` (default `/etc/pve-lab/tokens.json`) and finds the friend's VM with `lxc-ls`/`lxc-attach`. `pve-real.sh` and
`s03-preroll.cjs` are in `../lab` (link them into `$PMV_LAB`, see `../lab/README.md`); `setclock.sh` was not kept.
