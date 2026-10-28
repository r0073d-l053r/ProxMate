# ProxMate templates, VMs and consoles: video script

Part two of the ProxMate series. Part one installed ProxMate and handed Mike his first VM. This one is
everything after that: filling the Template Store, cloud-init extras, the ways to create a machine, every
tab of the VM page, and every console. The ProxMate IDE is left for its own video.

Recorded on the same Ubuntu desktop as part one, against a real Proxmox VE node with real VMs.

- **Working title:** ProxMate templates, cloud-init and consoles: every way to use your VMs (v1.3)
- **Length:** about 1,900 spoken words, roughly 17 minutes with the real waits sped up
- **Voices:** two versions of the same footage, Kokoro `af_heart` (female) and Kokoro `am_michael` (male)
- **Written with:** the `script-writer` skill (tutorial template, casual-friendly tone) and
  `yt-script/hookscore.py` for the hook
- **Follows:** the docs at https://proxmate.host/docs/vms (Template Store, Cloud images, VM detail page,
  In-browser Console, Text console, Snapshots, Backups, Sharing)

## Hooks (scored with `hookscore.py`)

| Score | Hook | Formula |
|---|---|---|
| **68, workable** | You can stop wasting evenings building VMs by hand. Build one template, and every VM comes ready. But what do you do once it's running? | The Mistake |
| 68, workable | Stop building VMs by hand. Build one template, tick what you want, and every VM is ready before you log in. But how do you get in? | The Warning |

The winner names the chore the viewer already has (building every VM by hand), promises the fix in one
breath, then opens the second half of the video with a question: once it's running, how do you use it?
The cold open answers it on screen with a VM that came up with Docker already installed.

## Lab used in the recording

| Thing | Value |
|---|---|
| Presenter's desktop | Ubuntu 24.04, user `alex`, host `alex-desktop`, Chromium |
| ProxMate | v1.3.4 on the `proxmate` box, http://192.168.1.50:3000, signed in as Alex (admin) |
| Proxmox VE node | a real Proxmox VE 9.2.2 node, `pve1`, with KVM. VM disks on its `local` directory storage (qcow2) |
| Already in the store | Ubuntu 24.04, built in part one |
| Already in Proxmox | `debian-12-golden` (VMID 9100), a hand-made Debian 12 template with a cloud-init drive |
| ISO on Proxmox | `debian-13.7.0-amd64-netinst.iso` |
| Container template on Proxmox | `debian-12-standard_12.12-1_amd64.tar.zst` |
| Friend | Mike (account from part one), signs in from an incognito window |
| Machines made on camera | `web-01` (Ubuntu 24.04, cloud-init), `debian-iso` (ISO install), `debian-ct` (LXC), `web-golden` (duplicate turned template) |

Markers: `[ON SCREEN: ...]` is what the viewer sees. `[FF]` is a real wait that gets sped up in the
edit, with a small fast-forward badge.

---

## V01 · Cold open

[ON SCREEN: the finished result first. web-01's text console: docker run hello-world, no sudo, and Docker's greeting scrolls up. Then web-01's VM page: Running, the IP address, the five tabs.]

You can stop wasting evenings building VMs by hand. Build one template, and every VM comes ready. But what do you do once it's running?
This is web-01. I clicked Deploy, and it came up with my SSH key, a password, and Docker already installed.
Welcome back! Last time, we installed ProxMate and gave Mike his own VM.
Today is everything after that.
Templates, cloud-init, spinning up VMs, every tab on the VM page, and every way into your VM.
The ProxMate IDE gets its own video, so we'll leave that one for next time.
Let's go!

## V02 · Three ways to fill the Template Store

[ON SCREEN: Template Store, as an admin. Point at the three admin cards top to bottom, then the Ubuntu 24.04 card from part one, its Cloud-init and x86-64 badges, and its Deploy button.]

Everything starts in the Template Store.
A template is a ready-made disk. New VMs are copies of it, so there's no installer to click through.
There are three ways to fill this page.
Add a cloud image downloads an official image for you.
Add from cluster publishes a template you already made in Proxmox.
And Save as template turns one of your own VMs into a template. We'll do that one later.
Here's Ubuntu 24.04 from last time, ready to go.

## V03 · Add a cloud image

[ON SCREEN: the Image list opens on the catalog. Pick Debian 13 (Trixie); Store name fills in. Point at the last option, Custom image URL. Add to store, the progress bar. FF through the build. The new Debian 13 card with its Cloud-init badge.]

Let's add Debian 13.
Open the list. These come straight from Debian, Ubuntu, Fedora, Rocky and friends.
Pick Debian 13, and the store name fills itself in.
Want something that isn't listed? The last option takes your own image link.
Add to store.
Proxmox downloads the image, ProxMate boots it once to install the QEMU guest agent, and turns it into a template.
That guest agent matters. It's how ProxMate finds the VM's IP address, sets passwords, and shuts it down cleanly.
This takes a few minutes, so let's skip ahead.
[FF]
And there's Debian 13, with its Cloud-init badge.

## V04 · Notes, refresh and delete

[ON SCREEN: on the Debian 13 card, the pencil: type login notes, Save. Point at the refresh icon, then Settings, the Maintenance tab, the Cloud-image freshness card. Back to the store, point at the bin.]

Each card has a few buttons.
The pencil adds login notes, and an icon if you like. Whoever deploys it sees these notes.
I'll write: log in as debian, with the SSH key you picked.
Refresh downloads the newest image and rebuilds the template, so new VMs start out patched.
ProxMate can do that for you every month. It's under Settings, Maintenance.
And the bin deletes the template, from the store and from Proxmox. We'll use it later.

## V05 · Add from cluster

[ON SCREEN: Manage templates (admin), Add from cluster. The row debian-12-golden, vmid 9100, pve1, 3 GB. Type a login note, Publish. The new card appears in the grid with its Cloud-init badge.]

Already have templates in Proxmox? Bring them in.
Add from cluster lists every Proxmox template that isn't in the store yet.
Here's debian-12-golden, one I made by hand.
Add a login note, and Publish.
It's in the store now, right next to the cloud images.
ProxMate spotted its cloud-init drive, so it deploys just like they do.

## V06 · Cloud-init extras

[ON SCREEN: Cloud-init extras (admin), Configure. Options offered to tenants: untick Install code-server. Installed automatically on every VM: the three base items. Save selection, the toast. The snippet browser: pick Docker, the #cloud-config file.]

Next up, cloud-init extras. Configure.
The top list is what people can tick when they deploy.
I'll untick code-server. The ProxMate IDE covers that.
The bottom list goes on every cloud-init VM, ticked or not.
Security updates, fail2ban and btop. Sensible defaults.
Save selection.
Curious what actually runs? The snippet browser shows the exact cloud-init file.
Here's Docker. Plain cloud-config, merged with your user and SSH key when you deploy.

## V07 · Save your SSH key once

[ON SCREEN: Terminal: cat ~/.ssh/id_ed25519.pub, select the line and copy it. Chromium: the avatar menu, Security, the SSH keys card: Key name laptop, paste, Save key.]

Quick stop before we deploy.
Save your SSH key once, and you never paste it again.
Here's my public key. The public half is safe to share.
Security, SSH keys. Name it laptop, paste, and Save key.

## V08 · Deploy web-01

[ON SCREEN: Template Store, the Ubuntu 24.04 card, Deploy. The wizard with the template already chosen: name web-01, Size Small, the laptop chip under Use a saved key, Username ubuntu, a Password, Install Docker and Install Tailscale, the line listing what every VM also gets, the Admin options block. Deploy. FF through the clone.]

Now the fun part. On the Ubuntu card, Deploy.
The template is already picked. Name it web-01.
Pick a size. Small is plenty for this.
Under Use a saved key, there's laptop. One click.
The username fills itself in for Ubuntu.
I'll set a password too. You'll want it for the console.
Nice detail: ProxMate never writes that password into cloud-init. It sets it through the guest agent once setup finishes.
Then the extras. Docker, and Tailscale.
And the always-on list is spelled out right here, so nobody's surprised.
As an admin, I also get Admin options, like deploying straight into a friend's account. Mike's wizard doesn't have those.
Deploy!
ProxMate copies the template on my Proxmox node. My lab box has a slow disk, so this takes a few minutes.
[FF]

## V09 · Finishing setup

[ON SCREEN: web-01's page with the "Finishing setup on this VM…" banner. Console, Text: cloud-init's output scrolls past. FF until setup is done. Back to the VM page: the banner is gone and the IP address is filled in.]

Here's web-01, and this banner: Finishing setup on this VM.
Cloud-init is installing Docker, Tailscale and the always-on tools right now.
Power and delete are locked until it's done, so nothing interrupts it.
The text console already works, so let's watch.
That's cloud-init doing its thing. Let's skip ahead.
[FF]
Setup's done. The banner is gone, and the IP address showed up, thanks to the guest agent.

## V10 · ISO installs and containers

[ON SCREEN: Virtual Machines, New VM. Source: Custom VM (install from ISO). Name debian-iso, Installation ISO debian-13.7.0-amd64-netinst.iso, Create VM. The VM page, Console, Graphical: the Debian installer menu. Then New VM, Source: Container (LXC), the debian-12-standard template, name debian-ct, a root password, Create. FF. The machine list with the LXC badge.]

Templates aren't the only way.
New VM, and pick Custom VM, install from ISO.
Name it, and pick an installer. ProxMate lists every ISO on your Proxmox storage.
Create VM, and it boots straight into the installer.
There it is, in the graphical console. From here it's a normal install.
For something lighter, there's Container, LXC.
Containers share the host's kernel, so they're small and quick.
Pick a container template, a name, and a root password. Create.
[FF]
And there it is in the list, with its LXC badge.
Small print: container templates come from Proxmox itself, not from the Template Store.

## V11 · The VM page

[ON SCREEN: web-01's Overview: the header with the Running badge, node, VMID and OS; Connection details with the IP address and its copy button; Live status; Configuration; Notes; Project; Tags; Optimization tips.]

Back to web-01. This is the VM page, and you'll spend a lot of time here.
Up top: the status, the node, the VM ID and the OS. It refreshes itself every couple of seconds.
Connection details has the IP address, with a copy button.
Live status and Configuration show what it's doing, and what it has.
Notes, projects and tags keep things tidy once you have a few.
And Optimization tips flags anything missing, like the guest agent.

## V12 · The graphical console

[ON SCREEN: the Console menu: Graphical (noVNC), Text — links, copy/paste, Pop out text console. Graphical: the Ubuntu login prompt. Type ubuntu. Paste: put the password in, Send to VM, the shell prompt appears. Point at Ctrl+Alt+Del and Reconnect. Open the console's Actions menu: Pause, Force stop.]

Now, getting in. Open the Console menu.
Graphical, Text, and Pop out.
Graphical first. That's the VM's real screen, in your browser.
Type the username. A long password is no fun to type into a remote screen, so there's Paste.
Put the text in, Send to VM, and it types it for you, key by key.
We're in.
Ctrl+Alt+Del and Reconnect live up here too.
And this Actions menu adds Pause, Resume and Force stop, for when a VM stops answering.

## V13 · The text console

[ON SCREEN: the Graphical | Text toggle, Text. Log in as ubuntu. docker run hello-world, no sudo. Select a line to copy it, right-click to paste it. sudo tailscale up prints a sign-in link; Ctrl-click opens the Tailscale sign-in page in a new tab; close it, Ctrl+C. Then echo a line into notes.txt for later.]

Flip the toggle to Text. This one's my favourite.
It's a real terminal. Scrollback, copy and paste, the lot.
Let's try Docker. docker run hello-world.
No sudo needed. Cloud-init added me to the docker group.
Select text to copy it. Right-click to paste.
And links are clickable. sudo tailscale up prints a sign-in link.
Ctrl-click, and there's the Tailscale sign-in page.
I won't join my tailnet on camera, but that's all it takes to reach this box from anywhere.
Before we move on, I'll leave a little notes file here. Remember it.

## V14 · Pop out

[ON SCREEN: Pop out: the text console in its own small window. Keep on top. Then debian-iso's console, Text: No text console, Switch to graphical console.]

Want a terminal next to your docs? Pop out.
The console gets its own little window.
Tick Keep on top, and it floats above everything else.
One heads-up. VMs installed from an ISO usually have no text console, because they have no serial port.
ProxMate says so, and sends you to the graphical one instead.

## V15 · Insights and Activity

[ON SCREEN: in web-01's text console, a CPU busy loop. The Insights tab: the live CPU chart climbs. Stop the loop. Day and Week. Then the Activity tab.]

Insights shows CPU and memory, live and over time.
Let me give it some work.
There it goes.
Day and Week fill in as the VM runs.
And Activity is the paper trail. Who created it, who opened a console, and when.

## V16 · The Actions menu

[ON SCREEN: Actions: Start, Stop, Restart, Rename, Resize, Rebuild, Duplicate, Migrate to node, Save as template, Delete. Resize: Medium, Resize, the toast naming the automatic snapshot. Stop. Duplicate: name web-golden. FF. web-golden's Actions, Save as template, Convert; it lands in the Template Store. The bin on its card. Back on web-01: Rebuild dialog, Cancel. Start.]

The Actions menu has everything else.
Start, Stop and Restart. Stop is a clean shutdown, through the guest agent.
Rename does what it says.
Resize changes CPU, memory and disk. Disks can only grow.
And here's the nice part. ProxMate takes a snapshot first, automatically.
Duplicate makes a full copy, from a stopped VM. So, Stop, then Duplicate, and call it web-golden.
[FF]
Migrate moves a VM to another node. I only have one, so it stays put.
Now, Save as template. That's way number three from earlier.
In real life, tidy the guest up first. Run cloud-init clean, so every copy starts fresh.
Convert, and it's in the Template Store straight away, Docker included.
I don't need this one, so let's try the bin. Gone, from the store and from Proxmox.
Back on web-01, Rebuild wipes the disk and starts over from an ISO or a template. I'll cancel that.
And Start it again.

## V17 · Snapshots and MateStates

[ON SCREEN: Backups & Snapshots. The Snapshots card: the resize snapshot with its Automatic chip. Take snapshot: before-oops. Text console: rm notes.txt. Roll back on before-oops, confirm; the VM stops. Start. FF through the boot. Log in, cat notes.txt. Then MateStates, New MateState. FF. The new MateState and its Restore button, the Backup policy card.]

Backups and Snapshots.
Snapshots are quick save points. Here's the one from the resize, marked Automatic.
Let's take our own, called before-oops.
Now, the oops. I'll delete that notes file.
Gone. Back to Snapshots, and Roll back.
A rollback puts the disk back exactly as it was, and leaves the VM stopped. So, Start.
[FF]
Log back in, and there's notes.txt. Like it never happened.
Snapshots live on the VM's own disk. For real backups, there are MateStates.
New MateState saves the whole VM to your backup storage.
[FF]
Done. Restore brings it back, and the Backup policy decides how often they're taken.

## V18 · The Settings tab

[ON SCREEN: Settings, top to bottom: General, Power schedule, Disks, GPU / PCI passthrough, Alerts, Recovery. Reset password for ubuntu: the new password, shown once. Point at Add SSH key, Push file, Boot into rescue. Then Shared access, Admin, Danger zone.]

Last tab, Settings. Top to bottom.
General has the name and size.
Power schedule starts and stops it on a timer. Handy for a dev box that doesn't need to run overnight.
Disks adds extra data disks.
GPU and PCI passthrough, if your hardware has a spare, by request to the admin.
Alerts emails you when it runs hot, fills its disk, or stops unexpectedly.
Recovery is the one to remember. It all works through the guest agent, no SSH needed.
Forgot your password? Reset guest password gives you a new one, shown once.
Lost your key? Add an SSH key.
Need a file inside? Push a file.
And if it won't boot at all, Rescue mode starts it from a rescue ISO.
Below that: sharing, the Admin card, and the Danger zone, where Rebuild and Delete live.

## V19 · Share with Mike

[ON SCREEN: Shared access: mike@example.com, Viewer, Share. An incognito window: Mike signs in, web-01 is in his machine list, the VM page shows View console, the console with the View only badge.]

Let's share web-01 with Mike.
Viewer, Operator, or Manager. A Viewer can watch the console, but can't type.
Share.
Here's Mike's side. web-01 shows up, with a View console button.
He sees the same screen, with a View only badge, and his keyboard does nothing.
Perfect for showing a friend how something works.

## V20 · Reach it from anywhere, and wrap-up

[ON SCREEN: back in Alex's window. Help & Docs: the no-port-forwarding policy card, the Tailscale guide, the Cloudflare Tunnel guide. Then the Template Store with every card.]

One last thing. How do you reach a VM from outside?
Not with port forwards. Help and Docs explains why, and has two guides.
Tailscale, for private SSH from anywhere. That's the checkbox we ticked.
And Cloudflare Tunnel, if you want to publish a website.
So, here's what we covered.
Three ways to fill the Template Store, cloud-init extras, and one-click deploys.
Then every tab on the VM page, and every console.
The ProxMate IDE is next, in its own video.
Tell me in the comments what you're deploying first.
Happy homelabbing!

## End card · 7.5 seconds, no narration

[ON SCREEN: the same animated end card as part one: the ProxMate badge, "ProxMate.", the tagline "Your cluster *shared* safely", and "Visit proxmate.host to learn more".]
