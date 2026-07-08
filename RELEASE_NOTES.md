## Highlights

**Add an SSH key to a VM after it's created — no rebuild needed** — plus a mobile
fix for the Virtual Machines list.

Until now you could only inject an SSH public key at deploy time (it rides
cloud-init, which only applies on first boot). This release adds a post-create
path so you can drop one of your keys onto a running machine and SSH in right away.

## Add an SSH key to an existing VM

On any running **QEMU** VM: **VM → Settings → Recovery → Add an SSH key**.

- Pick one of your **saved SSH keys** (the same quick-pick chips as the deploy
  wizard) or paste a public key, choose the guest username (e.g. `ubuntu`,
  `debian`, `root`), and add it.
- ProxMate appends the key to that user's `~/.ssh/authorized_keys` **inside the
  guest via the QEMU guest agent** — the same mechanism as the existing password
  reset, so it works on a live machine with no reboot.
- **Idempotent:** re-adding the same key is a no-op (no duplicate lines). It
  creates `~/.ssh` if missing and sets the ownership/permissions sshd requires
  (`700` on `.ssh`, `600` on `authorized_keys`), and gives a clear error if the
  username doesn't exist in the guest.
- The key is also merged into the VM's cloud-init `sshkeys` config best-effort, so
  it survives a later rebuild — **without disturbing a static IP configuration**.

Security: the username and key are validated (single-line OpenSSH format — the
authorized_keys-injection guard) and passed to the guest as positional arguments
of a fixed script, never interpolated into a shell command, so there's no
injection surface. Containers (LXC) are not supported — like password reset, this
needs the QEMU guest agent. Requires operate/owner access on a shared VM.

## Fixes

- **Mobile: the Virtual Machines list no longer clips.** On narrow screens the
  fixed-width table columns crushed together and cells (OS icon, resources, IP)
  painted over each other. The table now keeps a sensible minimum width and
  scrolls horizontally on small screens, and each column truncates within its own
  cell — so values never bleed into the neighbouring column. Desktop layout is
  unchanged.

## Upgrade notes

- **No database migrations, no breaking changes, no new environment variables.**
- The Add-SSH-key action needs the **QEMU guest agent** running in the VM (same as
  the existing "Reset guest password"). Cloud images deployed through ProxMate
  already include it; for others, install and start `qemu-guest-agent`.
- Standard update: **Admin → Settings → Updates → Install update**, or pull + rebuild
  (`docker compose up -d --build`).

## Verification

- Backend suite green: **493 tests** (+10) — a new `vm-ssh-key` suite covers the
  argv-safe agent exec (username/key never interpolated into the script), the
  exec-status polling and exit-code mapping (missing user → clear error; guest
  stderr surfaced), the idempotent/permission-fixing append, the best-effort
  cloud-init config sync **including preserving a static `ipconfig0`**, and the
  LXC / multi-line-paste guards. Typecheck and lint clean on backend and frontend;
  frontend production build green.
- Live-verified on the production cluster (musebot): adding a saved key to a
  running cloud-init VM and connecting over SSH with it, and the mobile VM-list
  layout on a phone.
