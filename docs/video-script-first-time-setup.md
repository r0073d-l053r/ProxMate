# ProxMate setup, start to finish (yt-script output)

Working title the hook confirms: **Self-service VMs on Proxmox: full ProxMate setup, and the token mistake that breaks it**
(run `/yt-package` on it before you publish; this run only wrote the script).

Narration runtime at 150 wpm: **13.2 minutes** (1974 spoken words). Screen time for the installer prompts, the build and the template import is on top of that; the timers on screen set the real cut.

Voice: provisional profile at `~/.claude/youtube/voice.md`, inferred from this session. Replace with transcripts.

---

## HOOK (0:00 to 0:10, 24 words)

[ON SCREEN: cold open on the Proxmox "Add API Token" dialog, cursor hovering over the Privilege Separation checkbox. No intro card.]

You're probably making the one Proxmox API token mistake that leaves it with zero permissions, and Proxmox never tells you why until something 403s.

## THE TURN (0:10 to 0:32, 56 words)

[ON SCREEN: cut to the finished ProxMate dashboard, then a tenant's VM page with the console open. Hold two seconds on each.]

I'm going to fix that in about ninety seconds, and then take a blank Linux box all the way to a friend logged into their own VM on your Proxmox, through a web dashboard where they never see your Proxmox panel and can't reach your LAN. Every click is on screen. Let's start with the checkbox.

## BEAT 1: The checkbox, and why Proxmox is quiet about it (0:32 to 2:10, 245 words)

[ON SCREEN: Proxmox web UI. Datacenter selected in the left tree.]

In Proxmox, go to `Datacenter`, `Permissions`, `API Tokens`, and click `Add`.

[ON SCREEN: the Add dialog. Fill User = root@pam, Token ID = proxmate.]

User, `root@pam`. Token ID, `proxmate`. Now look at `Privilege Separation`. It's checked by default.

[ON SCREEN: zoom in on the checkbox. Freeze.]

Here's the payoff of the hook. That checkbox means the token does not inherit root's permissions. It becomes its own thing, with its own permission list, and that list starts empty. Nothing in this dialog says that. You click Add, Proxmox hands you a secret, and it looks exactly like a working token. It will even authenticate. It just can't do anything.

And the reason Proxmox never tells you: in its model, `root@pam!proxmate` is not the same principal as `root@pam`. It's a different name. Permissions in Proxmox come from access control lists that name a principal, and nobody wrote an ACL naming this token. From Proxmox's point of view there's nothing wrong. From yours, the first real call comes back 403.

[ON SCREEN: uncheck the box. Click Add. The secret dialog appears, blurred.]

Uncheck it. Click `Add`. Copy the secret now, because Proxmox shows it exactly once. The token ID you'll type into ProxMate is the whole string, `root@pam!proxmate`.

[ON SCREEN: lower third: "Token ID: root@pam!proxmate".]

One honest caveat. Privilege separation off on a root token means ProxMate holds a key that's root on your cluster. For a homelab trial, fine, that's what we're doing. The repo ships a script, `deploy/proxmox-token.sh`, that creates a dedicated user and a role with only what ProxMate uses. The release notes say it was run end to end on a seven-node Proxmox 9.2 cluster. Link in the description. Today, root token, keep moving.

## BEAT 2: What you need (2:10 to 2:53, 107 words)

[ON SCREEN: simple diagram. Laptop, arrow to "ProxMate box", arrow to "Proxmox :8006". Tenant VMs under Proxmox.]

Quick checklist. A Proxmox VE 8 or 9 node or cluster. The project tests on 9.2 and that's what I'm on. A separate Linux machine for ProxMate itself. The README asks for roughly four gigs of RAM and five gigs of disk, and it needs to reach Proxmox on port 8006. Mine is a small Debian VM sitting on the same cluster, which is fine, it's just another API client. And sudo on that machine, because the installer offers to install Docker.

No domain and no certificates today. We're using the local HTTP trial mode. I'll tell you what changes for a real domain at the end.

## BEAT 3: Install (2:53 to 4:29, 240 words)

[ON SCREEN: terminal on the ProxMate box. Three commands typed one at a time.]

Three lines.

```
curl -fsSLO https://raw.githubusercontent.com/r0073d-l053r/ProxMate/main/install.sh
less install.sh
bash install.sh
```

The middle one isn't decoration. This is deliberately not a curl-pipe-bash one-liner, and the comment at the top of the script says why: this software ends up holding a token that's root on your cluster, so piping an unread script into a root shell is the wrong habit for exactly this. Read it. It's commented like a person wrote it.

[ON SCREEN: `less install.sh`, scroll the header comment for five seconds, quit.]

[ON SCREEN: `bash install.sh` running. First prompt.]

First thing it does is check for Docker, Compose, git, curl and openssl, and on a fresh box it tells you what's missing, why each one is needed, and asks:

```
Install them now? [y/N]:
```

Yes. Sudo will ask for your password here. If you say no, it stops and changes nothing, which I like.

[ON SCREEN: time-lapse the Docker install, ten seconds max.]

Second prompt:

```
How will you reach ProxMate?
  1) HTTP on this machine's address — quick trial on a trusted network
  2) HTTPS on a domain, behind your reverse proxy — real deployment
```

One. It works out this machine's LAN address by itself.

[ON SCREEN: the build starting. Timer in the corner.]

Now it clones the newest release, writes a `.env` with a fresh encryption key, and builds. The README says about six minutes from a clean machine to the wizard. Put a timer on screen and let it run.

While it builds, the one thing to know. That `ENCRYPTION_KEY` it just generated protects every secret ProxMate stores, your Proxmox token included, and ProxMate's own nightly database backups are useless without it. We'll back it up in a minute. The dashboard is going to nag us anyway.

[ON SCREEN: build finishes. The "ProxMate is up" block and the URL.]

```
==> ProxMate is up
  Open http://192.168.1.50:3000 and complete the setup wizard.
```

And read the warning under it: until you finish the wizard, anyone who can reach that address can claim the admin account. Don't go make a coffee. Do the wizard now.

## BEAT 4: The setup wizard (4:29 to 6:20, 279 words)

[ON SCREEN: browser. The "ProxMate Setup" page with four steps across the top: Admin, Proxmox, Defaults, Finish.]

Four steps.

[ON SCREEN: Step 1 form being filled.]

Step one, `Admin`. Display name, email, a password of at least eight characters. This is the owner account. `Continue`.

[ON SCREEN: Step 2, "Connect to Proxmox" card.]

Step two, `Connect to Proxmox`. `Proxmox host URL` is the full URL with the port, `https://` your host `:8006`. `API token ID` is `root@pam!proxmate`. The placeholder in that field shows a different example format, don't copy it, type yours. `API token secret`, paste it. `Verify TLS certificate`, leave it unchecked if Proxmox still has its self-signed cert, which is most home setups. `Proxmox pool`, leave empty.

Click `Test connection`.

[ON SCREEN: the green toast.]

```
Connected to Proxmox VE 9.2 (3 nodes, 4 storages)
```

Version, node count, storage count. That's what you want.

[ON SCREEN: cut to a second take with a privsep token. The red error toast.]

And here's what the hook was about. If you'd left privilege separation on, this is what you get instead: a red error saying the token authenticates but holds no permissions, naming privilege separation as the cause, with the exact command to fix it. ProxMate catches it here, at the test. Proxmox never would have. If you get yellow warnings instead, each one names a single privilege and what breaks without it. Read them.

[ON SCREEN: the button now reads "Connection verified". Click Continue.]

[ON SCREEN: Step 3, "Choose defaults", dropdowns populated.]

Step three, `Choose defaults`. `Default storage pool` is where VM disks go. It only offers storages that can hold disk images. `Default network` is the bridge every new VM gets plugged into, usually `vmbr0`. If yours isn't listed there's a type-a-name option. `ISO storage` is where your installers live, usually `local`.

Under that, `Installed on every cloud-init VM`. These get installed on every cloud-image VM anyone creates. The defaults are fail2ban, unattended-upgrades and btop. Leave them. `Continue`.

[ON SCREEN: Step 4, "Review & finish" summary.]

Step four. Check the host and the token ID. `Finish setup`.

[ON SCREEN: toast "Setup complete — welcome to ProxMate!" then the dashboard.]

We're in. Two housekeeping steps before anyone else touches this, and the project is right to insist on both.

## BEAT 5: Back up the key (6:20 to 6:59, 97 words)

[ON SCREEN: the amber banner on the dashboard: "Back up ENCRYPTION_KEY."]

That amber banner stays on every admin page until someone confirms the key is backed up. Let's actually do it.

[ON SCREEN: terminal. The grep, value blurred.]

```
grep ENCRYPTION_KEY ~/proxmate/.env
```

Copy that line into your password manager. Not a note on the same machine. The scenario it protects against is this box dying: you restore the nightly database backup, give it this key, and every setting and secret comes back. Without the key the backup is encrypted noise.

[ON SCREEN: click "Confirm backup" in the banner. Banner clears.]

Click `Confirm backup`. ProxMate records who confirmed and when, tied to a fingerprint of the key, so if the key ever changes the banner comes back on its own.

## BEAT 6: Turn on the cluster firewall (6:59 to 8:04, 163 words)

[ON SCREEN: sidebar, admin section, Settings. The Proxmox tab.]

Second step. `Settings`, `Proxmox` tab.

Here's the deal. ProxMate writes a firewall onto every VM it creates. Inbound dropped. Outbound to your private address ranges dropped. Internet and DNS allowed. That's how a tenant's VM can't see your NAS, your other VMs, or the Proxmox host.

But those per-VM rules do nothing until the cluster firewall is switched on at the datacenter level, and Proxmox ships with it off.

[ON SCREEN: the "Proxmox cluster firewall" card reading "Not enforced yet." Click Enable.]

This card says `Not enforced yet.` Click `Enable`.

[ON SCREEN: the dialog "Enable the Proxmox cluster firewall?" with the management subnet field.]

It asks for your management subnet and suggests one from the bridge you picked. Check it's the network you administer from, because ProxMate adds allow rules for the Proxmox web UI on 8006 and SSH on 22 from that subnet before it flips the firewall on. That ordering is what keeps you from locking yourself out of your own cluster.

[ON SCREEN: confirm. Toast "Cluster firewall enabled — tenant isolation is now enforced." Card reads "Isolation is enforced."]

Open Proxmox in another tab to prove you still can. Good. The installer tells you to do this before you invite anyone, and this is why.

## BEAT 7: Add a cloud image (8:04 to 9:11, 166 words)

[ON SCREEN: sidebar, Template Store. "Manage templates (admin)".]

Right now the only way to make a VM is from an ISO, which means a full OS install through the console. We want the one-click version. `Template Store`, then `Manage templates (admin)`.

[ON SCREEN: "Choose a cloud image" picker, scrolling the curated list.]

`Choose a cloud image`. The README lists twenty curated images: Debian 11 through 13, Ubuntu 20.04 through 24.04, Fedora, Alma, Rocky, CentOS Stream, Oracle, openSUSE, Arch, and four ARM64 builds. Or paste your own qcow2 URL. I'm taking `Debian 12 (Bookworm)`. `Store name`, `Debian 12`. `Add to store`.

[ON SCREEN: "Downloading & importing — this can take a few minutes." Time-lapse.]

ProxMate has Proxmox download the official image, import it as a disk, attach a cloud-init drive and convert it to a template, all through the API. Nothing on the host. Leave the tab open.

[ON SCREEN: the template card with the Cloud-init badge.]

That `Cloud-init` badge is the whole point. It's what lets someone paste an SSH key and get a working box instead of an installer.

[ON SCREEN: the cloud-init extras section. Tick Docker and Tailscale.]

While we're here, the extras. These become checkboxes people see when they deploy. I'm offering Docker and Tailscale. Tailscale especially, and you'll see why in a minute.

## BEAT 8: Invite someone (9:11 to 10:03, 130 words)

[ON SCREEN: admin sidebar, Invites. "Create an invite" form.]

`Invites`, `Create an invite`.

[ON SCREEN: fill the form while talking.]

`Label` is for you. `Max vCPU`, `Max RAM (GB)`, `Max storage (GB)` are the person's total across all their VMs, not per VM, and the form says it: `The new user inherits the quota you set here.` You can change it later.

`Invite link expires in` is the link's clock. `Compute access` is the person's clock: how long they can use the cluster after they sign up. A fixed term or never. When it lapses, ProxMate stops their VMs and refuses sign-in, and deletes nothing. Extend it and it all comes back.

There's a checkbox to require two-step authentication before they can do anything. For people you don't know well, tick it. `Email invite to` needs SMTP, which we haven't set up, so `Copy invite link`.

## BEAT 9: Be the tenant (10:03 to 12:10, 317 words)

[ON SCREEN: private browser window. Paste the link. "Create your account" form.]

Now I'm the friend. Private window, paste the link, `Create your account`. Same dashboard, no admin section, a quota card at zero.

[ON SCREEN: Virtual Machines, new VM. The "Create a virtual machine" wizard.]

`Virtual Machines`, new. `Source`, `Template Store`, and there's `Debian 12`.

[ON SCREEN: click a size preset. Fields fill.]

`Size` has presets, `Small` through `X-Large`. Pick one and `vCPU cores`, `Memory` and `Disk size (GB)` fill in. You can edit any of them, and it won't let you past your quota.

[ON SCREEN: Username field, SSH key field.]

`Username`, the Linux user it creates. `SSH public key`, paste it. This key is how you get in. There's an optional password too, and once you've pasted a key you can save it for next time.

[ON SCREEN: the extras checkboxes. Tick Tailscale.]

The extras we offered. Tick `Tailscale`.

[ON SCREEN: pan across the form. No node field visible.]

Notice what isn't on this page: a node picker. Tenants never choose a node. ProxMate places the VM on whichever node has the most free capacity and can see the template. Only admins get a node field, and it defaults to auto.

Create.

[ON SCREEN: the VM page. Status moving from creating to running. Timer in the corner.]

In the background it clones the template, sets the size, writes a cloud-init config with the user, the key and the extras, puts the NIC on the default bridge with the isolation firewall on, tags the VM in Proxmox as this machine's, and boots it. The README says about a minute for a cloud image. Your timer will tell you the truth for your hardware.

[ON SCREEN: open the text console. Login prompt.]

Open the console. There's a graphical one and a text one. The text one has real copy and paste and scrollback. There's the login prompt.

[ON SCREEN: cut to the friend's laptop. An SSH attempt to the VM's LAN address hanging. Then cut back.]

Can the friend SSH to this from their laptop on your LAN? No. The isolation firewall drops it, on purpose. What they do instead is log in on the console once and run `sudo tailscale up --ssh`. After that they SSH in from anywhere on their tailnet, with no port forwarding and no holes in your network. The `Help & Docs` page in the sidebar has that guide and one for publishing a website with a Cloudflare tunnel.

## PAYOFF (12:10 to 12:58, 120 words)

[ON SCREEN: split screen. Left, the Privilege Separation checkbox. Right, the tenant's console logged in.]

That's the whole promise delivered. The checkbox was `Privilege Separation`, the reason Proxmox stays quiet is that a token is its own principal with no ACL, and ProxMate's connection test is where it gets caught now. And from that checkbox you've gone to a friend inside their own VM, isolated from your network, through a dashboard they can't escalate out of.

[ON SCREEN: three-line list.]

Three things before real people use this. A real domain and HTTPS, which passkeys and SSO need. Re-run the installer with `--domain` and put Caddy or a Cloudflare tunnel in front; the repo includes a Caddyfile and a full runbook. SMTP under Settings, so invites and password resets can be emailed. And the least-privilege token script instead of root.

## CLOSE (12:58 to 13:10, 30 words)

[ON SCREEN: you, then end card.]

If you want the HTTPS and domain setup as the next video, say so in the comments, because that's what decides whether I make it. Links are in the description.
