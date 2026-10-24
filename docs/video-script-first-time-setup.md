# ProxMate from zero: install, set up, and hand out your first VM

**Video script, step-by-step tutorial. Written for ProxMate 1.2 on Proxmox VE 9.**

Target length: 20 to 25 minutes. Spoken lines are plain text. Stage directions are in
brackets. Terminal commands and exact UI labels are in code so you can read them off
the screen as you go.

---

## Before you hit record

Have these ready so the video flows without dead air:

- A clean Linux VM or box for ProxMate (Debian or Ubuntu is easiest), with sudo, about
  4 GB RAM and 5 GB free disk. It must reach your Proxmox host on port 8006.
- A Proxmox VE 8 or 9 node or cluster you can log into as root.
- Two browser windows: one normal (you, the admin), one private or incognito (the
  tenant you are about to invite).
- An SSH public key on your clipboard, or a saved one ready to paste.
- The Proxmox web UI already open on the Datacenter view.
- Optional: run the install once beforehand on a throwaway box so you know how long
  the Docker build takes on your hardware, then wipe it. A six-minute build is fine to
  time-lapse, but you want to know it is six and not sixteen.

Things that will bite you on camera:

- Do the API token step **before** the installer finishes. The wizard needs it and
  Proxmox only shows the secret once.
- Blur or regenerate the token secret before publishing. Same for the ENCRYPTION_KEY
  if it ends up on screen.
- Pick the HTTP "trial" mode for the video. It skips the reverse proxy and TLS, which
  is a separate video.

---

## 0. Cold open (0:00 to 0:45)

[ON SCREEN: the ProxMate dashboard with a few VMs, then cut to you.]

So here's a problem I kept running into. I've got a Proxmox cluster. Friends, family,
a couple of people from work, they all want a VM on it. And every time, I'd end up
either making them a Proxmox account, which gives them way too much, or doing it all
by hand, which means I'm tech support forever.

ProxMate fixes that. It's a self-hosted web dashboard that sits on top of Proxmox and
gives people a DigitalOcean-style experience. You send someone an invite link with a
quota baked in, they sign up, they click "new VM", and about a minute later they're
SSH'd into a fresh Debian box. They never see your Proxmox panel. They can't reach
your LAN. And you can see everything they're doing.

In this video I'm going to take a totally fresh machine, install ProxMate, connect it
to Proxmox, lock it down, invite a user, and create a VM as that user. Start to
finish. No skipping the annoying parts, because the annoying parts are where everyone
gets stuck.

[ON SCREEN: title card.]

---

## 1. What you need (0:45 to 1:45)

[ON SCREEN: a simple diagram. Your laptop, arrow to "ProxMate box", arrow to
"Proxmox :8006". Tenant VMs hanging off Proxmox.]

Quick checklist before we touch anything.

First, you need a Proxmox VE node or cluster. Version 8 works, version 9 is what the
project tests against. I'm on 9.2.

Second, you need a separate Linux machine to run ProxMate on. It doesn't have to be big.
Four gigs of RAM, five gigs of disk, and it needs to be able to reach your Proxmox
host on port 8006. I'm using a small Debian VM, which, yes, is itself running on the
same Proxmox cluster. That's fine. ProxMate talks to Proxmox over the API like any
other client.

Third, you need sudo on that machine, because the installer will offer to install
Docker if it's missing.

That's it. No domain name today. No certificates. We're going to do the local HTTP
trial mode, which is perfect for a homelab on a trusted network, and I'll tell you at
the end what changes when you want to put this on a real domain.

---

## 2. Create the Proxmox API token (1:45 to 4:30)

[ON SCREEN: Proxmox web UI, Datacenter selected.]

We're going to do the Proxmox side first, because the ProxMate installer stops at a
point where it's going to ask you for this, and you don't want to be scrambling.

ProxMate needs an API token. Not a password. A token. Here's how.

[ACTION: click through Datacenter → Permissions → API Tokens → Add.]

In the Proxmox UI, go to `Datacenter`, then `Permissions`, then `API Tokens`, and hit
`Add`.

For `User`, pick `root@pam`. For `Token ID`, type `proxmate`.

Now. Stop. Look at this checkbox. `Privilege Separation`.

[ON SCREEN: zoom on the Privilege Separation checkbox.]

This is the number one thing that breaks ProxMate installs, and it's not ProxMate's
fault, it's just a Proxmox default that surprises everybody. Privilege separation means
the token does **not** inherit the user's permissions. It gets its own, which start at
nothing. So you can make a token for root, it will authenticate perfectly, and it will
have zero rights. The connection test will pass. And then storage lists come back
empty and every VM create fails with a 403. People lose hours on this.

So: **uncheck Privilege Separation.** Then click `Add`.

[ACTION: uncheck, click Add. Proxmox shows the token secret dialog.]

Proxmox shows you the secret exactly once. Copy it somewhere safe right now. I'm going
to paste mine into a notes file off screen. If you lose it, you delete the token and
make a new one, no big deal, but don't lose it in the next ten minutes.

The token ID you'll be typing into ProxMate is the full thing: `root@pam!proxmate`.
User, exclamation mark, token name.

[ON SCREEN: lower-third text: "Token ID: root@pam!proxmate".]

One honest caveat. A privsep-off root token is effectively root on your cluster.
That's fine for a homelab trial, and it's what we're doing today. If this is going to
be a real deployment with people you don't fully trust, the repo ships a script,
`deploy/proxmox-token.sh`, that creates a dedicated `proxmate@pve` user and a role
with only the privileges ProxMate actually uses. It was tested end to end on a
seven-node cluster. I'll link it in the description. Today, root token, keep moving.

---

## 3. Install ProxMate (4:30 to 9:00)

[ON SCREEN: terminal on the ProxMate box.]

Over to the machine that's going to run ProxMate. Fresh Debian, nothing on it.

The install is three lines, and I want to talk about the middle one.

```bash
curl -fsSLO https://raw.githubusercontent.com/r0073d-l053r/ProxMate/main/install.sh
less install.sh
bash install.sh
```

[ACTION: run the curl line.]

First line downloads the installer. Second line opens it in a pager so you can read
it. The project is really deliberate about this. It is not a `curl | sudo bash`
one-liner, on purpose, and the comment at the top of the script says why: this
software is going to end up holding a token that's root on your cluster. Piping an
unread script into a root shell is exactly the wrong habit for that. So read it. It's
long, but it's commented like a human wrote it for another human.

[ACTION: open `less install.sh`, scroll the header comment for a few seconds, quit.]

Quick skim of what it does: checks what's missing, generates an encryption key, writes
a correct `.env`, builds the containers, and then stops at the browser wizard. The
Proxmox token is entered in the browser, not on the command line, so it never lands
in your shell history.

Okay. Run it.

[ACTION: `bash install.sh`.]

First thing it does is look for Docker, Compose v2, git, curl and openssl. On this
box Docker's missing, so it tells me what it needs and why each thing is needed, and
asks:

```
Install them now? [y/N]:
```

Yes. It'll ask for my sudo password here, that's expected. If you say no, it stops
and changes nothing on the machine, which I appreciate.

[ACTION: type y, enter password. Time-lapse the Docker install.]

[B-ROLL: speed up the package install, ~10 seconds on screen.]

Next question:

```
How will you reach ProxMate?
  1) HTTP on this machine's address — quick trial on a trusted network
  2) HTTPS on a domain, behind your reverse proxy — real deployment
  choice [1/2]:
```

One. Trial mode. It figures out this machine's LAN IP by itself, so the address I'll
open later is `http://` whatever-my-IP-is `:3000`.

[ACTION: type 1.]

Now it clones the repo at the newest release tag, writes the `.env` file with a fresh
64-character `ENCRYPTION_KEY`, and starts the build.

```
==> Building and starting (the first build takes a few minutes)
```

[B-ROLL: time-lapse the build. Put a timer in the corner. Mine took about six minutes.]

While that runs, two things worth knowing.

One: that `ENCRYPTION_KEY` it just generated is the most important string on this
machine. Every secret ProxMate stores, the Proxmox token, SMTP password, 2FA secrets,
is encrypted with it. ProxMate also backs up its own database nightly, and those
backups are useless without the key. We'll deal with backing it up in a minute, the
dashboard is going to nag us about it anyway.

Two: the installer refuses to generate a new key if it finds an old ProxMate database
volume on the box. That's a safety feature. A new key can't read an old database, and
you'd end up with a half-dead install. If you ever see that error, it's telling you to
go find your original key.

[ACTION: build finishes.]

```
==> Waiting for the API to become healthy
  the backend applies database migrations on boot, so this is not instant
  + backend is healthy
==> ProxMate is up

  Open http://192.168.1.50:3000 and complete the setup wizard.
```

And then there's a warning I want you to actually read:

[ON SCREEN: zoom on the warning text.]

Until you finish the wizard, anyone who can reach that address can claim the admin
account. The ports are open on all interfaces. So don't go make a coffee. Do the
wizard now.

It also prints a reminder about the token and privilege separation, and a line that
says "Before inviting anyone: enable the Proxmox cluster firewall." Remember that
one. We'll do it.

---

## 4. The setup wizard (9:00 to 13:00)

[ON SCREEN: browser, open http://<ip>:3000.]

Open the address in your browser. You land on `ProxMate Setup`, four steps across the
top: `Admin`, `Proxmox`, `Defaults`, `Finish`.

### Step 1: Admin

[ACTION: fill the form.]

`Welcome to ProxMate. Create the administrator account.` Display name, email, a
password of at least 8 characters, confirm it. This is the owner account. Use a real
password manager entry for it.

`Continue`.

### Step 2: Connect to Proxmox

[ON SCREEN: the Connect to Proxmox card.]

This is where the token goes.

`Proxmox host URL`: the full URL with the port. `https://192.168.1.10:8006`. Include
the `https://`, include the `:8006`. It'll tell you if you forget.

`API token ID`: `root@pam!proxmate`. The whole thing.

[ASIDE, casual:] Heads up, the placeholder in this field says `proxmate@pam!dashboard`,
which is just an example format. Don't copy it. Yours is whatever you made in Proxmox.

`API token secret`: paste the secret you copied earlier.

`Verify TLS certificate`: leave this **unchecked** if your Proxmox uses the
self-signed certificate it ships with, which is nearly everyone on a home network.
If you've put a real cert on Proxmox, check it.

`Proxmox pool (optional)`: leave empty. That's for the least-privilege pool-scoped
token setup, not today.

Now click `Test connection`.

[ACTION: click. A green toast appears.]

```
Connected to Proxmox VE 9.2 (3 nodes, 4 storages)
```

That's what you want to see. Version, node count, storage count.

[ON SCREEN: if you can reproduce it, show a yellow warning toast.]

If you get yellow warning toasts here, read them. Each one names a specific privilege
the token is missing and what will fail without it. This is the connection test
catching the privsep problem at setup instead of three screens later with an empty
dropdown. If you get a hard red error about no privileges at all, that's privilege
separation. Go back to Proxmox, fix the token, come back.

The button now says `Connection verified`. `Continue`.

### Step 3: Choose defaults

[ON SCREEN: the defaults card loading, then populated.]

`Fetching Proxmox resources…` and then three dropdowns. These are the defaults every
new VM gets.

`Default storage pool`: where VM disks go. It only lists storages that can hold disk
images. I'm picking `local-lvm`. If you have Ceph or ZFS, pick that.

`Default network`: the bridge new VMs get plugged into. Almost always `vmbr0`. It
lists Linux bridges, Open vSwitch bridges, and SDN VNets if you have them. If your
bridge isn't listed, there's a "type a name" option.

`ISO storage`: where your install ISOs live. Usually `local`. This also becomes where
ProxMate keeps its cloud-init snippets.

Below that: `Installed on every cloud-init VM`. These are packages ProxMate will
install on every cloud-image VM anyone creates. The defaults are fail2ban,
unattended-upgrades, and btop. That's a sensible baseline. I'm leaving it. You can
change it later in the Template Store.

`Continue`.

### Step 4: Review and finish

[ON SCREEN: the summary card.]

A summary of what you entered. Admin, Proxmox host, token ID, cluster version and
node count, storage, network, ISO storage. Check the host and token look right.

`Finish setup`.

[ACTION: click. Toast: "Setup complete — welcome to ProxMate!" Dashboard appears.]

And we're in. That's the whole wizard. Before anything else, two housekeeping steps
that the project is quite insistent about, and they're right.

---

## 5. Back up the encryption key (13:00 to 14:15)

[ON SCREEN: dashboard with the amber banner at the top.]

See this amber banner? `Back up ENCRYPTION_KEY.` It's going to sit on every admin
page until someone confirms it's done. Let's actually do it instead of dismissing it.

The key is in the `.env` file in the install directory. The installer defaults to a
folder called `proxmate` wherever you ran it from.

[ACTION: switch to terminal.]

```bash
grep ENCRYPTION_KEY ~/proxmate/.env
```

[ON SCREEN: blur the value.]

Copy that line into your password manager. Not a sticky note, not a text file on the
same machine. Somewhere that survives this box dying. The whole point is that if this
machine catches fire, you restore the nightly database backup, give it this key, and
every setting and secret comes back. Without the key, the backup is encrypted noise.

[ACTION: back to browser, click `Confirm backup` in the banner.]

Back in the dashboard, hit `Confirm backup`. ProxMate records who confirmed it and
when, tied to a fingerprint of the key, so if the key ever changes the banner comes
back. Nice touch.

---

## 6. Turn on tenant isolation (14:15 to 16:30)

[ON SCREEN: Admin → Settings → Proxmox tab.]

Second housekeeping step, and this one's security-relevant. Go to `Settings` in the
admin section of the sidebar, and open the `Proxmox` tab.

Here's the deal. ProxMate puts a firewall on every VM it creates: inbound drop,
outbound drop to all your private ranges, so a tenant VM can't see your LAN, your
other VMs, or the Proxmox host itself. Internet and DNS are allowed. That's how your
friend's Minecraft box doesn't end up poking at your NAS.

But Proxmox has a master switch. Per-VM firewall rules do absolutely nothing until the
**cluster** firewall is enabled at the datacenter level. And that's off by default.

[ON SCREEN: the "Proxmox cluster firewall" card showing "Not enforced yet."]

So this card says `Not enforced yet.` Click `Enable`.

[ACTION: click Enable. Dialog appears.]

`Enable the Proxmox cluster firewall?` It asks for your management subnet, and
suggests one based on the bridge you picked, something like `192.168.1.0/24`. Check
it matches the network you administer from. This matters. ProxMate adds allow rules
for the Proxmox web UI on 8006 and SSH on 22 from this subnet **before** it flips the
firewall on, specifically so you don't lock yourself out of your own cluster.

[ACTION: confirm.]

```
Cluster firewall enabled — tenant isolation is now enforced.
```

Card now says `Isolation is enforced.` Go check you can still load the Proxmox UI in
another tab. You can. Good.

[ASIDE:] The installer and the docs both say do this before you invite anyone, and
I'd listen. A VM created while this is off still gets the rules written, they just
aren't enforced until the switch is on. Turn it on now and you never have to think
about it.

---

## 7. Add a cloud image to the Template Store (16:30 to 18:30)

[ON SCREEN: sidebar → Template Store.]

Now the fun part. Right now the only way to make a VM is from an ISO, which means a
full OS install through the console. That works, but we want the one-click
experience. For that we add a cloud image.

Open `Template Store` in the sidebar. As admin you'll see `Manage templates (admin)`.

[ACTION: open the add-image flow.]

`Choose a cloud image`. There's a curated list, about twenty of them. Debian 11, 12
and 13, Ubuntu 20.04 through 24.04, Fedora, Alma, Rocky, CentOS Stream, Oracle,
openSUSE, Arch, and a few ARM64 builds if you've got ARM nodes. Or you can paste your
own `.qcow2` or `.img` URL.

I'm picking `Debian 12 (Bookworm)`. Give it a `Store name`, I'll just call it
`Debian 12`. `Add to store`.

[ACTION: click.]

```
Downloading & importing — this can take a few minutes.
```

[B-ROLL: time-lapse. Explain over it.]

What's happening: ProxMate tells Proxmox to download the official cloud image, imports
it as a disk, attaches a cloud-init drive, and converts the whole thing into a
Proxmox template. All through the API, nothing on the host. The download is a few
hundred meg so it depends on your internet. Leave the tab open.

[ACTION: template card appears with a Cloud-init badge.]

There it is. Notice the `Cloud-init` badge. That badge is what lets tenants paste an
SSH key and get a ready box in about a minute, instead of sitting through an installer.

One optional thing while we're here: there's a pencil icon to add `login notes` that
get shown to users, like a default username. And there's a section for cloud-init
extras, things like Docker, Tailscale, Cockpit, Netdata, that you can offer as
checkboxes when someone deploys. I'm turning on Docker and Tailscale. Tailscale
especially, because, remember, we just firewalled these VMs off the LAN. Tailscale is
how people are going to SSH in. It's outbound only, so it works through the isolation.

---

## 8. Invite a user (18:30 to 20:00)

[ON SCREEN: Admin → Invites.]

Time to give someone access. `Invites` in the admin sidebar, `Create an invite`.

[ACTION: fill the form while talking.]

`Label`: just for you, so you remember who this is. `Dev team member`, or in my case,
`Mike`.

Quotas. `Max vCPU`, `Max RAM (GB)`, `Max storage (GB)`. This is the total that person
can use across all their VMs, not per VM. I'm giving Mike 4 cores, 8 gigs, 80 gigs of
disk. The form reminds you: `The new user inherits the quota you set here.` You can
change it later per user.

`Invite link expires in`: how long the link itself stays valid before someone redeems
it. Seven days is the default.

`Compute access`: this is different. It's how long the person gets to use the cluster
**after** they sign up. You can say never expires, or give them a fixed term, like a
semester. When it runs out, ProxMate stops their VMs and refuses sign-in, but deletes
nothing. You extend it and everything comes back. Great for classrooms.

There's also a checkbox to require two-step authentication, which forces them to set
up an authenticator app or a passkey before they can do anything. If these are people
you don't know well, turn it on.

`Email invite to` is optional and needs SMTP configured, which we haven't done. So I'm
just going to generate the link and `Copy invite link`.

[ACTION: copy the link.]

---

## 9. Sign up and create a VM as the tenant (20:00 to 23:30)

[ON SCREEN: private browser window. Paste the invite link.]

Now I'm Mike. Private window, paste the link.

`Create your account`. Display name, email, password, confirm. Done, and Mike lands on
his own dashboard. It's the same app, but no admin section in the sidebar, and a
quota card showing 0 of 4 cores used.

[ACTION: Virtual Machines → New.]

Go to `Virtual Machines`, create a new one. The wizard says it right there:
`Build from scratch with an ISO, or clone a ready-made template — autoscaled to the
size you pick.`

`Source`: pick `Template Store`, and there's our `Debian 12`.

`Size`: there are presets, `Small`, `Medium`, `Large`, `X-Large`. Pick one and it
fills in `vCPU cores`, `Memory`, and `Disk size (GB)`, and you can tweak any of them.
The wizard won't let Mike go past his quota.

`Username`: the Linux user to create. `mike`.

`SSH public key`: paste it. This is the important one. This key is what gets you in.
There's also a `Password (optional)` field, and once you've pasted a key once you can
save it to your profile and use `Use a saved key` next time.

Then the cloud-init extras we enabled. Mike ticks `Tailscale`.

Notice what's **not** here: there's no node picker. Tenants never choose a node.
ProxMate puts the VM on whichever node has the most free capacity and can actually
see the template. Admins get an `Auto-select (recommended)` node field with an
override, tenants don't see it at all.

Create.

[ACTION: click create. Cut to the VM page.]

[B-ROLL: VM page with status going from creating to running. Timer in the corner.]

So what's happening in the background: ProxMate clones the template, sets the cores and
RAM, grows the disk to what Mike asked for, writes a cloud-init config with his user
and key and the extras, plugs the NIC into the default bridge with the isolation
firewall on, tags the VM in Proxmox as belonging to this machine, and boots it. The
status shows `deploying` until cloud-init reports done.

[ACTION: VM shows running.]

About a minute. Let's open the console.

[ACTION: open the console. Show both graphical and text if you have time.]

There's a graphical noVNC console and a text console. The text one is the nice one,
it has real copy and paste, scrollback, and you can control-click links. Here's the
login prompt. And there's the login banner telling Mike how to get in from outside.

[ON SCREEN: text console with the login prompt.]

Now, can Mike SSH to this from his laptop on the LAN? No. And that's the point. The
isolation firewall drops that. What he does instead, and the docs walk him through it,
is log in on the console once, run `sudo tailscale up --ssh`, and then he can SSH in
from anywhere on his tailnet, with no port forwarding and no holes in your network.
There's a `Help & Docs` page in the sidebar with the Tailscale guide and a Cloudflare
Tunnel guide for people who want to host a public website from their VM.

---

## 10. The quick admin tour (23:30 to 25:00)

[ON SCREEN: back in the admin window.]

Back as admin, a thirty-second tour of what you've got now, because we only scratched
the surface.

[ACTION: click through each quickly.]

`Monitor`: live CPU, memory and network sparklines for every VM, grouped by owner,
with power controls. There's a kiosk mode for a wall display too.

`Users`: everyone, their quotas, their access windows. You can edit quotas here, and
tenants can request more from their side.

`Audit Log`: who did what. Every create, delete, start, sign-in.

Back on Mike's VM page, as admin you can `Migrate` it live to another node, `Resize`
it, take snapshots, and there are `MateStates`, which are scheduled vzdump backups
with rolling retention and one-click restore. Weekly by default, per-VM schedule if
you want.

`Projects` lets people group their VMs with a tag and see totals per project.

And under `Settings` you'll find SMTP, which you want for password resets and emails,
SSO if you have Keycloak or Authentik, notifications to Discord or Slack or ntfy or
Telegram, the ProxMate IDE, which is a browser VS Code inside the tenant's own VM, and
a maintenance tab with database backups and in-app updates.

---

## 11. What to do next, and wrap-up (25:00 to 26:00)

[ON SCREEN: you, with a short on-screen list.]

Three things before you let real people onto this.

One. If you want this reachable from outside your network, or you want passkeys and
SSO to work at all, you need a real domain and HTTPS. Re-run the installer with
`--domain yourname.example.com`, put Caddy or nginx or a Cloudflare Tunnel in front,
and the repo has a ready-made Caddyfile. There's a full production runbook called
`DEPLOYMENT.md`. That's its own video.

Two. Set up SMTP under Settings. Without it, invites can't be emailed and forgotten
passwords land in a queue for you to handle by hand.

Three. Consider the least-privilege token script instead of the root token, especially
if you went the pool route. The connection test will tell you exactly which privilege
is missing if you get it wrong.

That's ProxMate. Fresh box to a tenant SSH'ing into their own VM, in one sitting. Links
to everything are in the description. If this saved you from the privilege separation
rabbit hole, you know what to do. See you in the next one.

[ON SCREEN: end card.]

---

## YouTube description (paste and edit)

```
Install ProxMate from scratch and hand out your first VM. ProxMate is a self-hosted,
invite-only cloud dashboard on top of Proxmox VE: users get a DigitalOcean-style web
UI and quota-limited VMs, you keep your Proxmox panel to yourself.

Chapters
0:00 Why ProxMate
0:45 What you need
1:45 Create the Proxmox API token (and the #1 pitfall)
4:30 Install with install.sh
9:00 The setup wizard
13:00 Back up the encryption key
14:15 Turn on tenant isolation (cluster firewall)
16:30 Add a cloud image to the Template Store
18:30 Invite a user
20:00 Create a VM as the tenant
23:30 Quick admin tour
25:00 What to do next

Links
GitHub: https://github.com/r0073d-l053r/ProxMate
Installer: https://raw.githubusercontent.com/r0073d-l053r/ProxMate/main/install.sh
Admin guide: docs/admin-guide.md
Production runbook: DEPLOYMENT.md
Security guide and least-privilege token: SECURITY.md, deploy/proxmox-token.sh
Tailscale for SSH into your VM: docs/tailscale-ssh.md

Versions in this video: ProxMate 1.2, Proxmox VE 9.2.
```

## Pinned comment (optional)

```
The one thing to get right: when you create the API token in Proxmox, UNCHECK
"Privilege Separation". A privsep token for root has zero permissions. The connection
test passes, then everything 403s. If you already made one, either recreate it with
privsep off, or run on a Proxmox node:
  pveum acl modify / --tokens 'root@pam!proxmate' --roles Administrator
```
