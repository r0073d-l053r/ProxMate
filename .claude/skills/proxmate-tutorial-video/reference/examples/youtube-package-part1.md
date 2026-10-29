# ProxMate setup tutorial: YouTube package

> **Superseded.** Written for an earlier, rejected cut of part one (ProxMate 1.2, a 12-minute chapter list). Its
> chapters and versions don't match the published part one (10:41), so don't reuse its description. It is kept only
> as an example of yt-package and yt-shorts output: titles scored with title.py, a thumbnail brief, and Shorts.
> Part one still needs a current description and tags.

Generated from the shipped script with the yt-package, yt-chapters, yt-seo and yt-shorts skills.
Every figure below comes from the ProxMate README, release notes or the narration manifest. Nothing is invented.

---

## Title and thumbnail (yt-package)

Ten titles were written and linted with `title.py`. Top three:

| Score | Title | Issue the linter raised |
|---|---|---|
| 98 | **ProxMate 1.2 setup: Proxmox token, install, first VM** | Mobile feed truncates after "token,"; the subject survives |
| 98 | Proxmox VE 9 + ProxMate: invite-only VMs for your homelab | Mobile truncates after "invite-only"; subject survives |
| 98 | Proxmox self-service VMs in one video (ProxMate 1.2) | Mobile truncates after "video"; subject survives |

**Winner:** `ProxMate 1.2 setup: Proxmox token, install, first VM` (52 characters, carries the version number, no all-caps, no vague words).

> **Version note (added after the real-UI recording).** The dashboard recorded in the video is the repository build (package.json `1.2.0`), while `install.sh` on screen checks out the latest GitHub release tag, `v1.3.2`. If you publish against 1.3, use `ProxMate 1.3 setup: Proxmox token, install, first VM` (52 chars, scores the same 98/100 as the 1.2 title). The version-free `ProxMate setup: Proxmox token, install, first VM` scores 80/100 because it drops the number.

**Thumbnail brief** (linted against the title: different words, same promise):

- **Three words:** `UNCHECK THIS` (two words, leaving room). Bold white, heavy black stroke, top-left, no more than 40% of the width.
- **The image:** a huge crop of the Proxmox "Add: API Token" dialog filling the left two-thirds, the `Privilege Separation` checkbox ticked, with a hand-drawn orange ring around it. This is the thing the title does not say, so title and thumbnail carry different halves of the promise.
- **Expression and framing:** you on the right third, from the chest up, looking at the checkbox, not the camera, with the "oh, that's what did it" face. Eyebrows up, mouth slightly open. Looking at the checkbox pulls the viewer's eye to it.
- **Background:** dark slate (`#0b1220`) so the orange checkbox ring and your face hold contrast at feed size. No gradients behind the text. Test at 168 pixels wide: if the checkbox is not readable as a checkbox, make it bigger.

---

## Chapters (yt-chapters)

`chapters.py` found the thirteen boundaries from the narration transcript and validated them (first at 00:00, all at least ten seconds). Retitled as the promise of each section:

```
0:00 The checkbox that bites
1:00 Why Proxmox stays quiet
2:07 What you need
3:07 Install in three lines
4:14 Wizard: admin and Proxmox
5:29 Wizard: defaults and finish
6:16 Back up the key
6:53 Turn on the cluster firewall
7:52 Add a cloud image
8:59 Invite someone
9:47 Create a VM as the tenant
10:42 Console and Tailscale
11:39 Payoff and what's next
```

---

## Description and tags (yt-seo)

This video is evergreen search traffic, not subscriber-feed, so the description matters. The first two lines are the snippet.

```
Install ProxMate on Proxmox VE and give people self-service VMs without handing out a Proxmox login. Full setup, start to finish: API token, install.sh, the setup wizard, the cluster firewall, a cloud image, an invite, and the first VM.

Also: the Proxmox API token mistake that leaves it with zero permissions (privilege separation), and why Proxmox never warns you.

GitHub: https://github.com/r0073d-l053r/ProxMate
Installer: https://raw.githubusercontent.com/r0073d-l053r/ProxMate/main/install.sh
Admin guide: docs/admin-guide.md · Production runbook: DEPLOYMENT.md · Security and the least-privilege token: SECURITY.md, deploy/proxmox-token.sh
Tailscale for SSH into your VM: docs/tailscale-ssh.md

Chapters
0:00 The checkbox that bites
1:00 Why Proxmox stays quiet
2:07 What you need
3:07 Install in three lines
4:14 Wizard: admin and Proxmox
5:29 Wizard: defaults and finish
6:16 Back up the key
6:53 Turn on the cluster firewall
7:52 Add a cloud image
8:59 Invite someone
9:47 Create a VM as the tenant
10:42 Console and Tailscale
11:39 Payoff and what's next

What this covers
ProxMate is a self-hosted, invite-only cloud dashboard that sits on top of Proxmox VE. Admins hand out invite links with CPU, RAM and disk quotas; users create VMs and containers from cloud images or ISOs and reach them through an in-browser console, without ever seeing the Proxmox panel. Every VM gets a per-VM firewall that keeps tenants off your LAN once the Proxmox cluster firewall is on.

Who it is for
Anyone running Proxmox at home or for a small team who keeps getting asked for VMs. You should be comfortable in a Linux terminal and able to log into Proxmox as root.

What it assumes
Proxmox VE 8 or 9 (this video is on 9.2 and ProxMate 1.2), a separate Linux machine with sudo for ProxMate, roughly 4 GB RAM and 5 GB disk, and network reach to Proxmox on port 8006. The video uses the local HTTP trial mode; HTTPS behind a domain is the follow-up.

Nothing in this video is sponsored. ProxMate is AGPL-licensed open source.
```

**Tags** (fifteen, for disambiguation only):

```
proxmate, proxmox, proxmox ve, proxmox 9, proxmox api token, privilege separation, proxmox tutorial, self-service vm, vm dashboard, homelab, cloud-init, tailscale, docker compose, invite only, debian 12
```

**The three queries this should win**, checked against the title and the first two lines:

| Query | Words present in title or first two lines |
|---|---|
| `proxmate setup` | title: ProxMate, setup |
| `proxmox self service vm portal` | title: Proxmox, VM; line 1: self-service |
| `proxmox api token no permissions` | title: Proxmox, token; line 2: API token, zero permissions |

---

## Shorts (yt-shorts)

Five spans that survive without the video around them. Timecodes are from the narration manifest, so they match the rendered MP4. Each gets a new first line (scored with `hookscore.py`), on-screen text for the first two seconds, and a loop point.

### 1. The checkbox explained · 0:38 to 0:59 (20 s)

- **First line in the long video:** "Here's the payoff of the hook."
- **New first line (60, WORKABLE):** "You made a root API token in Proxmox and it has zero permissions. Here's the checkbox, before you lose an afternoon."
- **On-screen text, first two seconds:** `root token · 0 permissions`
- **Loop point:** it ends on "It just can't do anything." The first line answers with what did it.
- **Vertical framing:** the checkbox dialog is centred and 1100 px wide, so a 9:16 crop keeps the checkbox row and loses only the Cancel button. Fine.

### 2. Read the installer first · 2:46 to 3:05 (19 s)

- **First line in the long video:** "Three lines."
- **New first line (55, WORKABLE):** "You're about to pipe an installer into a root shell. Stop, and here's why: it will hold a root token on your cluster."
- **On-screen text:** `curl | sudo bash?`
- **Loop point:** ends on "It's commented like a person wrote it." The first line's "stop" answers it.
- **Vertical framing:** the terminal is 1500 px wide; the curl line will wrap in a 9:16 crop. Re-set the three commands at a smaller size or crop to the middle line, which is the point anyway. One second under the 20 s floor; take the next sentence if you need it.

### 3. Why the firewall does nothing yet · 6:56 to 7:19 (23 s)

- **First line in the long video:** "Here's the deal."
- **New first line (57, WORKABLE):** "You flipped isolation on, your tenant VMs can still reach your NAS, and Proxmox never told you why. One switch."
- **On-screen text:** `isolation ON · firewall OFF`
- **Loop point:** ends on "Proxmox ships with it off." The first line's "one switch" is that switch.
- **Vertical framing:** three horizontal flow rows get wide; stack them. The hero line fits.

### 4. Two clocks on an invite · 9:15 to 9:33 (18 s)

- **First line in the long video:** "Invite link expires in is the link's clock."
- **New first line (49, WEAK, the scorer wants stakes):** "Your ProxMate invite has two clocks. One expires the link in 7 days by default. The other decides when your friend gets cut off."
- **On-screen text:** `2 clocks`
- **Loop point:** ends on "Extend it and it all comes back." The first line re-asks which clock.
- **Vertical framing:** the two cards side by side need to stack; each is 720 px wide. Two seconds under the floor; include the next sentence about two-step authentication to clear it, or accept 18 s.

### 5. Can't SSH, and that's the point · 11:12 to 11:31 (20 s)

- **First line in the long video:** "Can the friend SSH to this from their laptop on your LAN?"
- **New first line (47, WEAK, the scorer wants stakes):** "You gave a friend a VM on your Proxmox and they can't SSH to it from your LAN. Good. Here's how they get in."
- **On-screen text:** `SSH blocked. On purpose.`
- **Loop point:** ends on "no holes in your network." The first line's "can't SSH" restates the puzzle.
- **Vertical framing:** the laptop → tailnet → VM flow is horizontal; rotate it vertical for 9:16.

All five first lines scored between 47 and 60; the scorer's own fine print says a creator's hits and misses barely separate on it. The two WEAK ones are weak on stakes, which the subject does not naturally carry.

---

## Skills that could not run yet

| Skill | Why not | What it needs |
|---|---|---|
| `/yt-retention` | No audience-retention export exists before publishing | The YouTube Studio retention CSV after the video is live |
| `/yt-edit` | No raw recording to transcribe | A transcript of your recorded take |
| `/yt-comment` | No comments yet | A pasted comment thread |
| `/yt-audit` | Needs a channel | Your channel URL |
| `/yt-viral` | Reads public listings with view counts, which this sandbox cannot fetch | A collected.json of niche videos with views and channel medians |
| `/yt-plan` | A week plan needs your hours and capacity | How many hours a week you have |
