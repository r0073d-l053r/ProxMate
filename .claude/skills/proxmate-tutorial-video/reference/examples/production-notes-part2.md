# ProxMate templates, VMs and consoles (part two): production notes

**The video:** `proxmate-vms-templates-consoles.mp4`, narrated in Kokoro `af_heart`, the same voice as part one's
polished cut. 1920×1080, 30 fps, H.264 tagged BT.709, AAC stereo, −16.4 LUFS. **Length:** 13:46, including the
same 7.5 s animated end card as part one ("ProxMate. Your cluster shared safely. Visit proxmate.host to learn more").
**Narration:** take three, the script in `docs/video-script-vms-templates-consoles.md` (about 1,980 spoken words).
V01 to V03 are your own words, and V04 to V20 follow that voice.
**Next to it:** subtitles (`.srt`) and `youtube-chapters.txt`.

**What changed from the cut you had:** only the narration and the subtitles. The picture is the same
approved edit, bit for bit (the video stream was copied, not re-encoded), so the chapter times are the same too.

This is the polished edit, made the same way as part one's: a 32 px pointer, a ring on the clicks that
matter, occasional eased zooms, real waits sped up with a ▶▶ badge, and the same end card.

## What you are looking at

Everything on screen is a real program, driven by real X11 mouse and keyboard events.

| On screen | What it really is |
|---|---|
| The desktop | The same GNOME desktop as part one, user `alex`, host `alex-desktop` |
| ProxMate | The real v1.3.4 frontend and backend, signed in as Alex (admin); Mike signs in for real in an incognito window |
| Proxmox | **Your real Proxmox VE 9.2.2 node `pve1`**, reached over the lab tailnet. Every VM, template, snapshot and backup in the video was really created on it |
| The templates | Ubuntu's `noble-server-cloudimg-amd64.img` and Debian's `debian-13-genericcloud-amd64.qcow2`, downloaded and built by ProxMate on pve1. `debian-12-golden` is a hand-made Proxmox template built from Debian's 12 genericcloud image |
| web-01 | A real KVM VM on pve1, set up by ProxMate's cloud-init: user `ubuntu`, the saved SSH key, a password set through the guest agent, Docker, Tailscale, unattended-upgrades, fail2ban, btop |
| The consoles | ProxMate's graphical (noVNC) and text (xterm.js over Proxmox termproxy) consoles, relayed by ProxMate |
| The ISO install | Debian's real `debian-13.7.0-amd64-netinst.iso`, booted to its installer menu |
| The container | A real LXC from Proxmox's `debian-12-standard_12.12-1_amd64.tar.zst` |
| The Tailscale page | The real login.tailscale.com sign-in page, opened by Ctrl-clicking the link `tailscale up` printed. Nobody signed in |
| Snapshots and the MateState | Real Proxmox snapshots of web-01 and a real vzdump backup on pve1's `local` storage; the rollback really removed and brought back `notes.txt` |

## Real waits, sped up

| Chapter | Wait | Real length | On screen |
|---|---|---|---|
| V03 | Proxmox downloads Debian 13's cloud image and ProxMate builds the template | 3 min 57 s | 7 s |
| V07 | back from the terminal to the browser | 4 s | 1 s |
| V08 | pve1 copies the Ubuntu template into web-01 | 4 min 33 s | 6 s |
| V09 | web-01's first boot: packages, Docker, Tailscale | 4 min 37 s | 7 s |
| V10 | Proxmox creates debian-iso | 7 s | 1.2 s |
| V10 | the graphical console connecting | 3 s | 0.7 s |
| V10 | back to the VM list and New VM | 5 s | 1.5 s |
| V10 | Proxmox unpacks the Debian 12 container | 1 min 26 s | 5 s |
| V16 | the resize, with its automatic snapshot first | 7 s | 1.2 s |
| V16 | web-01 shuts down cleanly | 21 s | 1 s |
| V16 | a full copy of web-01's 40 GB disk | 7 min 16 s | 6 s |
| V17 | the before-oops snapshot | 6 s | 1.5 s |
| V17 | the rollback (the dialog stays open meanwhile) | 6 s | 1.2 s |
| V17 | web-01 boots after the rollback | 46 s | 4 s |
| V17 | typing the login on the serial console | 8 s | 1.5 s |
| V17 | vzdump of web-01 to pve1's local storage | 4 min 38 s | 6 s |
| V19 | the incognito window, the address and Mike's sign-in | 11 s | 2.5 s |

## Things worth knowing (and disclosing)

- **A ProxMate bug shows up in V17.** In v1.3.4, the "Roll back" confirmation stays open after you click
  Roll back: the button doesn't close it, and nothing in the dialog shows the rollback is running. The
  recording waits for the "Rolled web-01 back" toast (about 8 s; the edit speeds that up), then closes the
  dialog with Esc. The same pattern affects the snapshot Delete dialog, the MateState Restore and Delete
  dialogs, and the "Enable" network-enforcement dialog in Settings. Cause: `AlertDialogAction`
  (`frontend/src/components/ui/alert-dialog.tsx`) is a plain button, not a Close, and those five dialogs keep no
  `open` state, so nothing closes them. Fix: give each dialog an `open` state that its handler closes (as the
  Resize and Rebuild dialogs already do), or render its action through `AlertDialogPrimitive.Close`.
- **VM disks live on pve1's `local` directory storage (qcow2), not `local-lvm`.** On this node, writes into
  the thin LVM pool ran at about 2.5 MB/s (tiny 4 KB requests), slow enough to time out ProxMate's template
  build. The `local` directory takes large writes, so the lab used it: `images` and `rootdir` were added to
  its content types for the recording, and ProxMate's default storage was set to `local`. Viewers on fast
  storage will see much shorter waits than this video's sped-up ones.
- **pve1's write cache was capped for the recording** (a runtime `vm.dirty_bytes` of 32 MB), so Proxmox's own
  API stayed responsive during big copies. It is restored in the cleanup.
- **Network isolation was not switched on for this node.** Part one turned on enforcement on its lab
  stand-in. pve1's cluster firewall was left off on purpose, because enabling it could cut the lab's remote
  access path. Nothing in the video depends on it, and the narration does not claim it is on.
- **The VMs got addresses on your home LAN**, which show in the Connection details card, the VM
  list and the cloud-init log.
- **Passwords on screen are lab-only.** web-01's console password shows for a moment in the Paste box (V12),
  and the password Reset guest password generates is on screen in V18. Both VMs are deleted.
- **The Tailscale sign-in link** shown in the text console belonged to web-01 and died with it.
- **"Keep on top"** only appears when ProxMate is served over HTTPS (the browser API it uses needs a secure
  page). The lab is plain HTTP, so the video shows the pop-out window and names Keep on top instead of
  clicking it.
- **The Activity tab has extra rows.** The many "Console opened" rows are real, from rehearsals and retakes.
  At the start of V16 the list also shows rows from resetting web-01 between two takes (Started, Snapshot
  deleted, Rolled back to snapshot, Duplicated); the edit opens V16 zoomed in on the Actions menu, so they
  are only readable later in the chapter, and only briefly.
- **Mike's incognito address bar** briefly suggests `pve1 · Proxmox Virtual Environment · 192.168.1.10:8006`
  from the browser's history while the ProxMate address is typed (V19).
- **How the narration was made.** Each line is spoken as one whole paragraph at the voice's normal speed (1.0);
  nothing is sped up or squeezed to fit. Every line was test-rendered against the footage first, and each one
  ends before the next starts, with at least a quarter second of silence between them. Words the pronunciation
  dictionary lacked ("deployed", "opens", "resizes", "mentioned") were added before rendering, so none were
  skipped. The earlier cut's audio cut every sentence at its commas and glued the pieces together, which is
  why words ran together; this one doesn't.
- **Checked twice by independent reviewers.** Every line was compared with what is on screen while it plays,
  the whole mix was run through speech recognition (every word present), and loudness, the end card and the
  subtitles were measured. That review moved eight lines so they land on what they describe (six by under
  a second; the last two in V20 later, so the sign-off leads into the end card instead of leaving seven
  silent seconds), and corrected one line: in V08, "ubuntu is already filled in as the username" (the wizard fills
  in the username from the template, before the key is picked).
- **Subtitles** follow the voice: one caption per sentence, and a long sentence split at a comma, each switch
  timed to the voice's own pause and confirmed by speech recognition. Captions stay up a little past their
  words where there is room, and none has more than two rows.
- **"That spike in the Day view" (V15).** V15 was retaken after the 90-second load from V14 had finished,
  so the Live chart is flat. The Day view in the same take shows the real spike to 100%, and the line plays over it.
- **The Optimization tips card** always suggests installing the guest agent, even on a VM that has it (the
  tip is static in v1.3.4); web-01's agent is installed and working.

## Lab clean-up

Done right after delivery (next time: once the creator accepts the final cut, SKILL.md step 13), first through ProxMate (so its records and Proxmox stayed in step), then on pve1:

- **Deleted through ProxMate:** web-01's MateState backup, the VMs web-01 (102) and debian-iso (103), the
  container debian-ct (104), and the Template Store templates Ubuntu 24.04 (100), Debian 13 (101) and
  debian-12-golden (9100). ProxMate removed each one from Proxmox too, disks included.
- **Removed on pve1:** the Debian 13 netinst ISO, the Debian 12 container template, ProxMate's two cloud-init
  snippets, and the lab's working folder `/root/proxmate-lab` (the Debian 12 image used for the golden template).
- **Restored on pve1:** `local` storage content back to `iso,vztmpl,backup,import`; the write cache back to
  `vm.dirty_ratio=20` and `vm.dirty_background_ratio=10` (the 32 MB cap was runtime only, so a reboot would have
  cleared it too).
- **API token `root@pam!proxmate` deleted.**
- **Checked afterwards:** no VMs or containers on pve1, empty `images` and `dump` folders, `local` at 4.3 GB used.
- **Left as it was:** pve1's cluster firewall (never touched), and the lab's remote access to pve1 (the tailnet
  and its SSH key), which you set up before part one.
