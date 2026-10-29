# Tutorial 2: templates, cloud-init, VMs, the VM page, consoles (no IDE)

> Example: part two's approved lab plan (approval scope, what gets created and cleaned up, honesty rules). Write one like it, and get it approved, before touching a real node.

Approved: real VMs on the user's lab Proxmox `pve1` (PVE 9.2.2, KVM, 4 CPU, 11 GB RAM; local dir
iso/vztmpl/backup/import, local-lvm images/rootdir; the creator's home LAN). Delete everything afterwards.
Never touch pve1's firewall (isolation enforcement could lock out the tailnet path). No secrets on screen
beyond what Proxmox/ProxMate show normally; the API token secret lives only in a 0600 file.

## What gets created on pve1 (cleanup list)
- API token root@pam!proxmate (privsep 0)
- storage.cfg: `snippets` added to `local` content (restore: iso,vztmpl,backup,import)
- /var/lib/vz/snippets/proxmate-*.yaml (written by ProxMate)
- ISO in local:iso (debian netinst), LXC template in local:vztmpl (debian-12-standard)
- hand-made template for "Add from cluster"
- VMs / templates ProxMate builds (VMIDs >= 100), their backups in local:backup (dump/)
- ProxMate tags/pool if any

## Network honesty
Isolation (part 1) drops inbound LAN traffic to tenant VMs, so the video does not SSH from the desktop.
Ways in: graphical (noVNC), text (xterm.js), pop-out, view-only share, recovery tools; SSH via keys + Tailscale
guide (shown up to the login link only).
