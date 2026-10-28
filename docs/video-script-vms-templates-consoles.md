# ProxMate templates, VMs and consoles: video script

Part two of the ProxMate series. Part one installed ProxMate and handed Mike his first VM. This one is
everything after that: filling the Template Store, cloud-init extras, the ways to create a machine, every
tab of the VM page, and every console.

Recorded on the same Ubuntu desktop as part one, against a real Proxmox VE node with real VMs.

- **Working title:** ProxMate templates, cloud-init and consoles: every way to use your VMs (v1.3)
- **Length:** about 1,980 spoken words; the finished video runs 13:46, end card included, with the real waits sped up
- **Voice:** Kokoro `af_heart` at normal speed, the same voice as part one's polished cut
- **Narration:** take three. The creator rewrote V01 to V03 in their own words, and V04 to V20 follow
  that voice. The rules it was written to are in [narration-style-guide.md](narration-style-guide.md)
- **Follows:** the docs at https://proxmate.host/docs/vms (Template Store, Cloud images, VM detail page,
  In-browser Console, Text console, Snapshots, Backups, Sharing)

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

Markers: `[ON SCREEN: ...]` is what the viewer sees. `[FF]` is a real wait that is sped up in the
edit, with a small fast-forward badge. The time in front of each line is where it starts in the finished video.

---

## V01 · Cold open

[ON SCREEN: the finished result first. web-01's text console: docker run hello-world, no sudo, and Docker's greeting scrolls up. Then web-01's VM page: Running, the IP address, the five tabs.]

`0:00` Welcome back to part two of the Set Up Your ProxMate series.

`0:04` This is a VM that we will deploy later in this video. We will show you how it boots with SSH keys and Docker installed.

`0:15` Today we will be discussing how to build a VM, how to work with the Template Store, and how to get inside of a VM once it's deployed.

`0:25` We'll start by setting up the Template Store, so that our friends can get a virtual machine.

## V02 · Three ways to fill the Template Store

[ON SCREEN: Template Store, as an admin. Point at the three admin cards top to bottom, then the Ubuntu 24.04 card from part one, its Cloud-init and x86-64 badges, and its Deploy button.]

`0:35` The Template Store holds ready-made disks called templates. New VMs start as a copy, so there's no installer to run.

`0:42` And the first card you'll see here is where you can add a cloud image. This downloads an official image for you.

`0:48` There is also an Add from cluster button for templates you made in Proxmox already.

`0:52` Later, I'll turn one of my virtual machines into a template with the Save as template option.

`0:58` Back in part one, we already added this Ubuntu 24.04.

## V03 · Add a cloud image

[ON SCREEN: the Image list opens on the catalog. Scroll to the last option, Custom image URL, then back up and pick Debian 13 (Trixie); Store name fills in. Add to store, the progress bar. FF through the build. The new Debian 13 card with its Cloud-init badge.]

`1:02` Let's add a new cloud image from the Image list. It has official images straight from Debian, Ubuntu, Fedora, and others.

`1:09` The last option takes a link to your own image, in case you have one that isn't on the list.

`1:15` I'll be picking Debian 13.

`1:19` Proxmox downloads the image first, then ProxMate boots it up once, installs the guest agent, and turns it into a template.

`1:27` The guest agent lets Proxmox read the virtual machine's IP address, set passwords, and shut it down cleanly.

`1:33` This will take a few minutes to build, so I'm going to speed through this process.

[FF]

`1:43` Debian 13 is now ready to deploy.

## V04 · Notes, refresh and delete

[ON SCREEN: on the Debian 13 card, the pencil: type login notes, Save. Point at the refresh icon, then Settings, the Maintenance tab, the Cloud-image freshness card. Back to the store, point at the trash icon.]

`1:48` On this card, the pencil icon lets you add login notes for anyone who deploys it.

`1:54` In my note, I'll tell people to log in as the user debian, with the SSH key they picked.

`2:02` The refresh icon next to it rebuilds the template from the newest image, so your new VMs start out patched.

`2:09` ProxMate can also refresh every cloud image for you once a month. You'll find that setting in Settings, on the Maintenance tab.

`2:18` And last, the trash icon deletes the template from both the store and Proxmox.

## V05 · Add from cluster

[ON SCREEN: Manage templates (admin), Add from cluster. The row debian-12-golden, vmid 9100, pve1, 3 GB. Type a login note, Publish. The new card appears in the grid with its Cloud-init badge.]

`2:24` Next is the Add from cluster button. It lists the templates you already have in Proxmox that aren't in the store yet.

`2:32` This is debian-12-golden, a template I made by hand. I'll give it the same login note as Debian 13 and publish it.

`2:40` This one uses cloud-init, like the cloud images do. Cloud-init sets up your user and SSH key when a VM first boots.

## V06 · Cloud-init extras

[ON SCREEN: Cloud-init extras (admin), Configure. Options offered to tenants: uncheck Install code-server. Installed automatically on every VM: the three base items. Save selection, the toast. The snippet browser: pick Docker, the #cloud-config file.]

`2:48` The Cloud-init extras card is where you pick what software cloud-init can install.

`2:53` Our friends can choose from the top list when they deploy. I'm going to uncheck code-server, so it won't be offered.

`3:01` Everything checked in the bottom list goes on every VM. That's security updates, brute-force protection, and a resource monitor.

`3:09` The section below shows you the exact cloud-init snippet for each option.

`3:13` When you deploy, ProxMate merges this Docker snippet with the user and key you picked.

## V07 · Save your SSH key once

[ON SCREEN: Terminal: cat ~/.ssh/id_ed25519.pub, select the line and copy it. Chromium: the avatar menu, Security, the SSH keys card: Key name laptop, paste, Save key.]

`3:19` Before we deploy anything, I'm going to save my SSH key in ProxMate, so I never have to paste it in again.

`3:27` This is my public key, and it's safe to share. I'll copy it, then open Security from my account menu.

`3:36` In the SSH keys card, I'm naming it laptop and pasting my key in.

`3:42` Now the deploy wizard will offer it every time.

## V08 · Deploy web-01

[ON SCREEN: Template Store, the Ubuntu 24.04 card, Deploy. The wizard with the template already chosen: name web-01, Size Small, the laptop chip under Use a saved key, Username ubuntu, a Password, Install Docker and Install Tailscale, the line listing what every VM also gets, the Admin options block. Deploy. FF through the clone.]

`3:48` Let's use that key to deploy a VM from the Ubuntu card.

`3:52` The Ubuntu template is already set as the source. I'll be naming it web-01 and picking the Small size.

`3:58` Under Use a saved key, I'm choosing laptop, and ubuntu is already filled in as the username.

`4:04` You'll want to set a password for the console. ProxMate doesn't put it in cloud-init. It sets it through the guest agent once setup is done.

`4:14` Then I'm checking Install Docker and Install Tailscale. The note at the bottom lists what goes on every VM anyway.

`4:22` Since I'm an admin, I also get Admin options, like deploying straight into a friend's account. Mike won't see these in his wizard.

`4:31` Once I click Deploy, ProxMate copies the template on my Proxmox node. My lab box has a slow disk, so I'm going to speed up this part.

[FF]

## V09 · Finishing setup

[ON SCREEN: web-01's page with the "Finishing setup on this VM…" banner. Console, Text: cloud-init's output scrolls past. FF until setup is done. Back to the VM page: the banner is gone and the IP address is filled in.]

`4:46` The banner on web-01 says it's still finishing setup. Cloud-init is installing Docker, Tailscale, and the tools that every VM gets.

`4:55` Power, delete, and migrate are locked until it's done.

`4:59` You can open the text console during setup and watch it work.

`5:04` This takes a few more minutes, so we'll skip ahead to the end.

[FF]

`5:19` Setup is done now, and ProxMate shows the IP address it got from the guest agent.

## V10 · ISO installs and containers

[ON SCREEN: Virtual Machines, New VM. Source: Custom VM (install from ISO). Name debian-iso, Installation ISO debian-13.7.0-amd64-netinst.iso, Create VM. The VM page, Console, Graphical: the Debian installer menu. The Text toggle: No text console, Switch to graphical console. Then New VM, Source: Container (LXC), the debian-12-standard template, name debian-ct, a root password, Create. FF. The machine list with the LXC badge.]

`5:26` You don't always need a template. To install from an ISO, I'll click New VM and choose Custom VM as the source.

`5:34` It needs a name and an installer, which can be any ISO on your Proxmox storage.

`5:40` When I click Create VM, it boots straight into the installer.

`5:51` From here, it's a normal Debian install, right in your browser.

`5:55` The Text console won't work on this one, because VMs installed from an ISO usually don't have a serial port.

`6:01` ProxMate tells you that, and gives you a button to switch back to the graphical console.

`6:08` If you want something lighter, the same Source list also has a Container option. LXC containers are small and quick, because they share the host's kernel.

`6:16` My container gets the debian-12-standard template, a name, and a root password. Then I'll click Create container and speed through the wait.

[FF]

`6:29` It shows up in the machine list with an LXC badge. Container templates come from Proxmox itself, so you won't see them in the Template Store.

## V11 · The VM page

[ON SCREEN: web-01's Overview: the header with the Running badge, node, VMID and OS; Connection details with the IP address and its copy button; Live status; Configuration; Notes; Project; Tags; Optimization tips.]

`6:38` This is the VM page for web-01, where you'll spend a lot of your time.

`6:42` The header shows its status, node, VM ID, and OS. This page refreshes every couple of seconds.

`6:49` You'll find the IP address under Connection details.

`6:52` Live status shows what it's doing, and Configuration shows what it has.

`6:57` Notes, projects, and tags help keep things tidy as you add more VMs. The Optimization tips card also has advice, like how to reach this VM from outside. I'll come back to that at the end.

## V12 · The graphical console

[ON SCREEN: the Console menu: Graphical (noVNC), Text — links, copy/paste, Pop out text console. Graphical: the Ubuntu login prompt. Type ubuntu. Paste: put the password in, Send to VM, the shell prompt appears. Point at Ctrl+Alt+Del and Reconnect. Open the console's Actions menu: Pause, Force stop.]

`7:11` The Console menu has Graphical, Text, and Pop out. I'm going to start with Graphical.

`7:17` This is the VM's real screen, right in your browser.

`7:20` I'll type in the username, then use the Paste button for the password.

`7:25` My password goes in this box. When I click Send to VM, ProxMate types it in for me, key by key.

`7:33` Ctrl+Alt+Del and Reconnect are right next to Paste. The Actions menu here has Pause and Force stop, for when a VM stops answering.

## V13 · The text console

[ON SCREEN: the Graphical | Text toggle, Text. Log in as ubuntu. docker run hello-world, no sudo. Select a line, right-click, Copy; right-click at the prompt, Paste. sudo tailscale up prints a sign-in link; Ctrl-click opens the Tailscale sign-in page in a new tab; close it, Ctrl+C. Then echo a line into notes.txt for later.]

`7:43` When I flip the toggle to Text, I get a terminal on the VM's serial port instead.

`7:51` Let's test Docker by typing docker run hello-world.

`7:57` I didn't need sudo for that, because cloud-init already added me to the docker group.

`8:02` The right-click menu lets me copy a line and paste it back in at the prompt.

`8:09` Links in the output are clickable too, like the sign-in link from sudo tailscale up.

`8:16` If I Ctrl-click it, it opens in a new browser tab.

`8:20` I won't sign in on camera, but that step makes this VM reachable from anywhere.

`8:25` I'm also going to leave a notes file here, because we'll use it later.

## V14 · Pop out

[ON SCREEN: web-01's text console, Pop out: the console opens in its own window. Drag it to the side. Type timeout 90 yes > /dev/null to keep the CPU busy.]

`8:32` The Pop out option in the Console menu opens the text console in its own window, and I can drag it wherever I want.

`8:42` I'm going to run a command that keeps one CPU busy for a minute and a half.

`8:47` If ProxMate runs over HTTPS, Chrome and Edge also get a Keep on top button, so the window floats above everything.

## V15 · Insights and Activity

[ON SCREEN: back to the main window, web-01's page, the Insights tab: the Live chart, then Day, where the busy CPU shows as a spike to 100%. Week. Then the Activity tab.]

`8:56` Back in the main window, the Insights tab shows the CPU and memory, both live and over time.

`9:04` That spike in the Day view is the busy CPU from a moment ago.

`9:08` The Activity tab shows who did what to this VM, and when.

## V16 · The Actions menu

[ON SCREEN: Actions: Start, Stop, Restart, Rename, Resize, Rebuild, Duplicate, Migrate to node, Save as template, Delete. Resize: Medium, Resize, the toast naming the automatic snapshot. Stop. Duplicate: name web-golden. FF. web-golden's Actions, Save as template, Convert; it lands in the Template Store. The trash icon on its card. Back on web-01: Rebuild dialog, Cancel. Start.]

`9:12` Everything else is in the Actions menu. Stop shuts the VM down cleanly through the guest agent.

`9:19` Rename does what it says, and Resize lets you change the CPU, memory, and disk.

`9:25` Disks can only grow, not shrink. Before it resizes, ProxMate takes a snapshot you can roll back to.

`9:31` Duplicate only works on a stopped VM, so I'm going to stop it first.

`9:39` Then Duplicate makes a full copy, and I'm calling it web-golden. The copy takes a while, so I'll skip ahead until it's done.

[FF]

`9:52` Migrate moves a VM to another node, but I only have one.

`9:56` Here's the Save as template option I mentioned earlier. If you're keeping the template, run cloud-init clean in the VM first, so every copy starts fresh.

`10:06` Once I click Convert, it shows up in the Template Store, with Docker already installed.

`10:12` I don't need this template, so I'm going to delete it with the trash icon.

`10:19` Back on web-01, Rebuild wipes the disk and starts over from an ISO or a template.

`10:24` I'll cancel that, and start web-01 back up from the Actions menu.

## V17 · Snapshots and MateStates

[ON SCREEN: Backups & Snapshots. The Snapshots card: the resize snapshot with its Automatic chip. Take snapshot: before-oops. Text console: rm notes.txt. Roll back on before-oops, confirm; the VM stops. Start. FF through the boot. Log in, cat notes.txt. Then MateStates, New MateState. FF. The new MateState and its Restore button, the Backup policy card.]

`10:31` On the Backups and Snapshots tab, you'll see the snapshot from the resize, marked Automatic.

`10:38` Snapshots are quick save points for your VM. I'm going to take another one by hand, and call it before-oops.

`10:49` Next, I'll delete the notes file I left in the text console.

`10:54` Now that it's gone, I'll go back to Snapshots and click Roll back on before-oops.

`11:05` A rollback puts the disk back the way it was in the snapshot, and leaves the VM stopped. I'll start it back up and skip past the boot.

[FF]

`11:18` When I log back in, the notes file is there again.

`11:21` Snapshots stay on the VM's disk. Real backups are MateStates, which copy the whole VM to your backup storage.

`11:29` I'm going to start a new MateState and speed through the save.

[FF]

`11:35` Restore brings the VM back to this point, and the Backup policy sets the schedule.

## V18 · The Settings tab

[ON SCREEN: Settings, top to bottom: General, Power schedule, Disks, GPU / PCI passthrough, Alerts, Recovery. Reset password for ubuntu: the new password, shown once. Point at Add SSH key, Push file, Boot into rescue. Then Shared access, Admin, Danger zone.]

`11:41` Settings is the last tab, with the name and size under General. The Power schedule starts and stops it on a timer, so a dev box can stay off overnight.

`11:51` You can add extra data disks in the Disks section. For GPU and PCI passthrough, you'll need to ask the admin.

`11:58` Alerts email you if the VM runs hot, fills its disk, or stops unexpectedly.

`12:03` Most of the Recovery section works through the guest agent, so you don't need SSH for it.

`12:09` If you forget your password, the Reset guest password option gives you a new one and only shows it once.

`12:17` You can also add another SSH key or push a file into the VM. If it won't boot, Rescue mode starts it from a rescue ISO.

`12:25` Further down, you'll find Shared access and the Admin card. The Danger zone at the bottom is where Rebuild and Delete are.

## V19 · Share with Mike

[ON SCREEN: Shared access: mike@example.com, Viewer, Share. An incognito window: Mike signs in, web-01 is in his machine list, the VM page shows View console, the console with the View only badge.]

`12:33` In Shared access, I'll be sharing web-01 with Mike as a Viewer. A Viewer can watch the console, but can't type in it.

`12:41` I'll click Share, then sign in as Mike in an incognito window.

`12:45` On Mike's side, web-01 shows up in his machine list, and its page has a View console button.

`12:53` He sees the same screen with a View only badge, but his typing does nothing.

`12:58` This is handy for showing a friend how something works.

## V20 · Reach it from anywhere, and wrap-up

[ON SCREEN: back in Alex's window. Help & Docs: the no-port-forwarding policy card, the Tailscale guide, the Cloudflare Tunnel guide. Then the Template Store with every card.]

`13:01` Earlier, I said I'd come back to reaching a VM from outside. The Help and Docs page explains why this cluster doesn't allow port forwarding.

`13:10` The Tailscale guide covers private SSH from anywhere, and web-01 already has Tailscale installed.

`13:17` There is also a Cloudflare Tunnel guide, for when you want a public website.

`13:25` That's it for part two of the series.

`13:31` Let me know in the comments what you're going to deploy first, and thanks for watching.

## End card · 7.5 seconds, no narration

[ON SCREEN: the same animated end card as part one: the ProxMate badge, "ProxMate.", the tagline "Your cluster *shared* safely", and "Visit proxmate.host to learn more".]
