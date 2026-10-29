# Part two: YouTube description and tags

## Description (paste as is)

```
Part two of the Set Up Your ProxMate series. We build Proxmox VM templates with cloud-init, deploy a VM with SSH keys and Docker installed, and get inside it from the browser console.
Along the way we cover the Template Store, cloud-init extras, snapshots, backups, and how to share a VM with a friend, all on a real Proxmox VE node.

ProxMate: https://proxmate.host
VM docs: https://proxmate.host/docs/vms
Source and install script: https://github.com/r0073d-l053r/ProxMate
Part one (installing ProxMate): [LINK TO PART ONE]

00:00 A VM that comes ready
00:34 Three ways to fill the store
01:02 Add a cloud image
01:47 Notes, refresh and delete
02:24 Publish a Proxmox template
02:48 Cloud-init extras
03:19 Save your SSH key once
03:45 Deploy web-01
04:46 First boot and cloud-init
05:24 ISO installs and containers
06:37 Tour the VM page
07:09 The graphical console
07:43 The text console
08:29 Pop out the console
08:54 Insights and Activity
09:11 The Actions menu
10:31 Snapshots and MateStates
11:40 Settings and recovery
12:33 Share a VM with a friend
13:01 Reach it from anywhere

What we cover:
- Adding official cloud images (Debian 13 in this video) to the Template Store, and publishing a template you already made in Proxmox
- Login notes, refreshing a template from the newest image, and the monthly refresh setting
- Cloud-init extras: what your friends can pick when they deploy, and what goes on every VM
- Saving your SSH key once so the deploy wizard offers it every time
- Deploying a VM from a template, plus ISO installs and LXC containers
- The VM page, the graphical console, the text console, and popping the console out into its own window
- Insights, Activity, the Actions menu, snapshots, MateState backups, and the Settings tab
- Sharing a VM with a friend as a Viewer, and the Tailscale and Cloudflare Tunnel guides for reaching a VM from outside

Who it's for: you run Proxmox at home or for a small team, and you want to give friends their own VMs without handing them a Proxmox login.
What it assumes: ProxMate is already installed and connected to your Proxmox node. Part one walks through that.

Recorded on ProxMate v1.3.4 and Proxmox VE 9.2.2. Everything on screen is real: the VMs, templates, snapshots and backups were created on a real Proxmox node, and the long waits are sped up (look for the fast-forward badge).

Heads-up for v1.3.4: after you click Roll back on a snapshot, the confirmation box stays open. Wait for the "rolled back" message, then press Esc.

The narration is a text-to-speech voice reading my script.

Questions? Ask in GitHub Discussions: https://github.com/r0073d-l053r/ProxMate/discussions/categories/q-a
Let me know in the comments what you're going to deploy first.
```

## Tags (15, paste into the Tags box)

```
ProxMate, Proxmate tutorial, Proxmox, Proxmox VE, Proxmox VE 9, Proxmox cloud-init, cloud-init template, Proxmox VM template, Proxmox console, noVNC, Proxmox snapshots, LXC container, homelab, Tailscale, self-hosted
```

## The three searches this video should win

| Search | Where the words are |
|---|---|
| proxmox cloud-init template | Line 1: "Proxmox VM templates with cloud-init" |
| proxmox vm browser console | Line 1: "Proxmox VM", "browser console" |
| share proxmox vm with friends | Lines 1 and 2: "Proxmox", "share a VM with a friend" |

All three pass on the first two lines alone. A title that also carries "Proxmox" and "templates" helps,
for example the working title "ProxMate templates, cloud-init and consoles: every way to use your VMs".

## Before you upload

- Replace `[LINK TO PART ONE]` with part one's URL.
- The opening line says "Set Up Your ProxMate series". If the series has another name, change it here and
  in the video's first line.
- The text-to-speech line is optional. Keep it if you want to be upfront about the voice.
- The chapters only work if the first one is 00:00, there are at least three, and each is at least 10 seconds.
  This list meets all three.
