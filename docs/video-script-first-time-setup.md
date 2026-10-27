# ProxMate first-time setup: video script

A friendly, start-to-finish walkthrough for people who already run Proxmox VE and have never
installed ProxMate. Recorded on a real Ubuntu desktop: Chromium for the docs and the dashboard,
GNOME Terminal for SSH and the installer.

- **Working title:** ProxMate setup: give friends their own VMs on Proxmox (v1.3.3)
- **Length:** 1,441 spoken words; the recorded video runs 10:43 with three real waits sped up, then a 7.5-second end card
- **Voices:** two versions of the same footage: Kokoro `af_heart` (female) and Kokoro `am_michael` (male),
  each line paced to the same slot (ElevenLabs was not reachable from the recording sandbox)
- **Written with:** the `script-writer` skill (tutorial template, casual-friendly tone) and
  `yt-script/hookscore.py` for the hook
- **Follows:** the docs at https://proxmate.host/docs (Proxmox Integration, Setup Wizard,
  Deployment, VMs), shown live from the public site in the recording

## Hooks (scored with `hookscore.py`)

| Score | Hook | Formula |
|---|---|---|
| **61, workable** | Your friend wants a server, but your Proxmox login can wipe your whole cluster. Here's how you say yes without that risk. | The Impossible Claim |
| 58, workable | Your friend wants a server, but handing over your Proxmox login risks your whole cluster. Here's how you say yes with 1 invite link. | unclassified |

The winner names the real cost of the usual workaround (sharing a Proxmox login) and promises
the opposite, then the cold open proves it with the finished result on screen.

## Lab used in the recording

| Thing | Value |
|---|---|
| Presenter's desktop | Ubuntu 24.04, user `alex`, host `alex-desktop` |
| ProxMate box | Ubuntu 24.04 server `proxmate`, 192.168.1.50 |
| Proxmox VE node | `pve1`, https://192.168.1.10:8006 |
| Token scene (S03) | a real Proxmox VE 9.2.2 web UI (Proxmox Dark theme), opened in a second tab |
| ProxMate version | v1.3.3 (whatever `install.sh` checks out) |
| Friend | Mike (signs up in an incognito window) |
| Cloud-init extra Mike ticks | Install Cockpit |

Markers: `[ON SCREEN: ...]` is what the viewer sees. `[FF]` is a real wait that gets sped up in
the edit, with a small fast-forward badge.

---

## S01 · Cold open and welcome

[ON SCREEN: the finished result first. Mike's console tab in Chromium, logged into his Ubuntu VM, then the admin dashboard listing his VM under his name.]

Your friend wants a server, but your Proxmox login can wipe your whole cluster. Here's how you say yes without that risk.
That's my friend Mike, logged into his own Ubuntu VM on my Proxmox box.
He picked the size, he clicked deploy, and he has never seen my Proxmox panel.
Hey, I'm really glad you're here.
Today we're setting up ProxMate from scratch, and I mean scratch: a fresh Ubuntu box, one install script, and a short wizard.
By the end, you'll have your own invite-only cloud, ready for friends.
And there's one sneaky Proxmox checkbox that trips people up.
I fell for it, so I'll show you exactly what that looks like.
Let's go!

## S02 · The plan, and the docs

[ON SCREEN: the Ubuntu desktop. Click Chromium in the dock, maximize it, type proxmate.host, scroll the landing page, then open Docs.]

Everything I do today is in the official docs at proxmate.host, so feel free to read along.
Here's the idea.
ProxMate is a web dashboard that sits in front of Proxmox.
Your friends get an invite link, a quota you choose, and VMs of their own.
Proxmox itself stays private.
You need three things.
A Proxmox VE node, and I'm on version nine.
A small Linux machine for ProxMate itself. Mine is an Ubuntu 24.04 VM called proxmate.
And an API token, so ProxMate can talk to Proxmox.
Let's start with that token, because that's where the trouble hides.

## S03 · The token, and the sneaky checkbox

[ON SCREEN: start on the docs, Proxmox Integration. Open a new tab to the Proxmox web UI at https://192.168.1.10:8006, logged in as root@pam. Datacenter, Permissions, API Tokens, Add. User stays root@pam, type proxmate as the Token ID, point at Privilege Separation (ticked), untick it, Add. The Token Secret window appears: Copy Secret Value, close it, and the new token sits in the list with Privilege Separation No. Close the tab, back on the docs, scroll to the Least-privilege token script section.]

Let's make one together. I'll open my Proxmox in a new tab.
In the Proxmox web UI, go to Datacenter, Permissions, API Tokens, and click Add.
Pick a user. For a homelab, root@pam is fine. Then name the token proxmate.
Now, the sneaky checkbox.
Privilege Separation is ticked by default.
Leave it ticked, and your token logs in just fine, but it can't actually do anything.
The docs call it the number one setup pitfall.
So untick it, click Add, and copy the secret right away, because Proxmox only shows it once.
There it is in the list. Privilege Separation: No. That's the one that works.
Prefer least privilege? There's a script for that, proxmox-token.sh.
It creates a dedicated user with only what ProxMate needs.
Confession time: the first token I made, I left that box ticked.
I kept it around, so in a few minutes we'll watch it fail.

## S04 · Hop onto the ProxMate box

[ON SCREEN: click Terminal in the dock, maximize. ssh alex@proxmate, the Ubuntu welcome text, then curl and less.]

Now let's hop onto the ProxMate box.
I'll open a terminal and SSH in.
And we're in. A pretty fresh Ubuntu server. All I've added is Docker.
Grab the installer with curl.
Quick tip: before you run any script from the internet, open it and skim it.
This one is plain bash, and it explains every step as it goes.
Here it's checking for Docker, and it offers to install it if it's missing.
Looks friendly. Let's run it.

## S05 · Run the installer

[ON SCREEN: bash install.sh. Prerequisite checks, the "How will you reach ProxMate?" question, choice 1, then the Docker build. FF through the build. End on "ProxMate is up" and the yellow warning.]

First it checks the basics: Docker, Compose, and whether it can generate an encryption key.
Then just one question. How will you reach ProxMate?
Option one is plain HTTP on this machine's address. Perfect for a first try on your home network.
Option two is HTTPS on your own domain, for later.
I'll pick one.
Now it grabs the latest release, writes the config, and builds everything with Docker.
This part takes a few minutes, so let's skip ahead.
[FF]
And there it is. ProxMate is up!
See this warning right here?
Until you finish the setup wizard, anyone who can reach this address can claim the admin account.
So let's not keep it waiting.

## S06 · Wizard: your account, and Proxmox

[ON SCREEN: new browser tab, http://192.168.1.50:3000, which lands on the wizard. Fill the admin form. Then the Proxmox step: first the broken token (error toast), then the good one (Connected toast).]

Over to the browser, and open the address it printed.
Welcome to ProxMate! Step one is your admin account.
Name, email, and a nice long password.
Step two connects to Proxmox.
The host is my node's address, with https and port 8006.
For the token, I'll use my broken one first. The one with the box still ticked.
Paste the secret, and Test connection.
Nope! The token logs in, but it holds no permissions at all.
And ProxMate tells you exactly why, and how to fix it. No guessing games.
Now the good token. Same steps. Test connection.
Yes! Connected to Proxmox VE. That's the moment.
The note underneath just means this node has no VMs yet. That's expected.
Leave Verify TLS unticked for now, since Proxmox ships with a self-signed certificate.
Continue.

## S07 · Wizard: defaults and finish

[ON SCREEN: storage, network bridge and ISO storage pickers, the "Installed on every cloud-init VM" list, Continue, Finish setup, the dashboard appears.]

Step three picks the defaults for new VMs.
Where the disks go, which network bridge, and where ISOs live.
These lists come straight from your node, so there's nothing to type.
The list at the bottom is installed on every cloud-init VM.
Security updates, fail2ban, and btop are already on. Nice.
Continue, and Finish setup.
We have a dashboard!

## S08 · Back up the key

[ON SCREEN: the yellow "Back up ENCRYPTION_KEY" banner. Switch to the terminal, show where the key lives with the value masked, switch back, tick the box, Confirm backup.]

The very first thing it asks for is a backup of your encryption key.
Every secret ProxMate stores, including that Proxmox token, is locked with it.
It lives in the .env file on the ProxMate box. Here's where, without showing you mine.
Copy it into your password manager, tick the box, and Confirm backup.
Future you says thanks.

## S09 · Switch on isolation

[ON SCREEN: Settings, Proxmox tab, scroll to Tenant network isolation, Enable enforcement, confirm, green banner.]

Next, the important one. Settings, then the Proxmox tab, and scroll down to Tenant network isolation.
ProxMate gives every tenant VM a firewall that blocks your home network, your other VMs, and the Proxmox host.
They can still reach the internet. They just can't reach your stuff.
But those rules do nothing until the cluster firewall is switched on.
So, Enable enforcement, confirm, and isolation is enforced.
That green banner is what keeps a friend's VM out of your network.

## S10 · Unlock cloud-init extras

[ON SCREEN: the browser on proxmate.host/docs/deployment, scrolled to Environment Variables and the SNIPPET_DIR / SNIPPET_STORAGE row. Then the terminal on the ProxMate box: apt install sshfs, mount the node's snippets folder, write docker-compose.override.yml in nano, add two lines to .env, docker compose up -d backend.]

One more power-up before we make templates.
ProxMate can install extras on a new VM's first boot. Things like Docker, Tailscale, or a web dashboard.
To do that, it writes little cloud-init files called snippets.
The docs cover it under Deployment. It's these two settings, SNIPPET_DIR and SNIPPET_STORAGE.
Those files have to land somewhere Proxmox can read.
So I'll mount my node's snippets folder on the ProxMate box. I'm using SSHFS here, and NFS works too.
Then I tell ProxMate where it is, with a tiny override file for Docker Compose and two lines in .env.
docker compose up -d backend, and ProxMate restarts with extras switched on.

## S11 · One-click templates

[ON SCREEN: Template Store, Add a cloud image, pick Ubuntu 24.04 LTS, store name, Add to store, progress bar. FF through the build. The new card with its Cloud-init badge, then the Cloud-init extras card showing automatic, and Configure to peek at the options.]

Back to the browser.
Right now, the only way to make a VM is from an ISO, which means clicking through an installer.
Let's make it one click instead.
Template Store, Add a cloud image.
There's a whole list. I'll pick Ubuntu 24.04, and call it Ubuntu 24.04.
Add to store.
Proxmox downloads the image, boots it once to bake in the guest agent, tidies up, and turns it into a template.
That takes a few minutes, so, fast forward.
[FF]
Done! See that Cloud-init badge?
It means: paste an SSH key, get a working server. No installer.
And look at Cloud-init extras. It says automatic. That's the folder we just mounted.
Every option ticked in here becomes a checkbox your friends can pick when they deploy.

## S12 · Invite a friend

[ON SCREEN: Invites. Max vCPU 4, Max RAM 8, Max storage 80, label Mike, Generate invite, copy the link.]

Now for the fun part. Invites!
You decide how much each friend gets.
I'll give Mike four vCPUs, eight gigs of RAM, and eighty gigs of disk.
Label it Mike, Generate invite, and copy the link.
Send it however you like. Text, email, carrier pigeon.

## S13 · Be Mike

[ON SCREEN: Ctrl+Shift+N for an incognito window, paste the link, the sign-up page with the quota, create the account, Mike's dashboard, New VM, Ubuntu 24.04, Medium, name, username, SSH key, password, tick Install Cockpit, Create. FF through the boot. VM shows Running.]

To see what Mike sees, I'll open an incognito window and paste the link.
His quota is right there on the sign-up page.
Name, email, password, and Create account.
This is Mike's dashboard.
He can't see my Proxmox, my other VMs, or my network. Just his own little corner.
Virtual Machines, New VM.
Source, Ubuntu 24.04. Size, Medium.
Give it a name and a username, and paste an SSH key.
I'll set a password too, so we can use the console in a second.
And here are those extras. Mike wants Cockpit, a slick web dashboard for his server. Tick it, and Create!
ProxMate clones the template, boots it, and cloud-init does the rest.
Let's skip the waiting again.
[FF]
It's running!

## S14 · Log in, in the browser

[ON SCREEN: the VM page, Console, Text, a real login prompt. Log in as mike, run cloud-init status and systemctl is-active cockpit.socket, open btop for a moment and quit it. Then Help & Docs.]

Open the VM, then Console, and Text.
That's a real login prompt, right in the browser. No SSH, no open ports.
Log in as mike, and we're in.
cloud-init says done, and Cockpit is active. That's our checkbox, working.
And btop came along from the always-on list. Pretty, right?
Want to reach it from anywhere?
Help and Docs has a guide for Tailscale, and one for Cloudflare Tunnels if Mike wants to host a website.
No port forwarding needed.

## S15 · Payoff

[ON SCREEN: back in the admin window. The dashboard lists Mike's VM under his name, inside his quota.]

Back on my side, the dashboard shows Mike's VM under his name, inside his quota.
So, here's what we did.
A fresh Ubuntu box, one script, a four-step wizard, and that sneaky checkbox, handled.
Your friends get their own servers. You keep the keys.
The docs at proxmate.host go much deeper, with backups, single sign-on, and the API.
Tell me in the comments what your friends are going to run first.
Happy homelabbing!

## End card · 7.5 seconds, no narration

[ON SCREEN: the ProxMate logo badge settles in, then "ProxMate." rises beside it. The tagline
"Your cluster *shared* safely" wipes in underneath, a thin rule grows, and "Visit proxmate.host
to learn more" fades up. Dark ProxMate background, slow glow and grid drift, fade to black.]
