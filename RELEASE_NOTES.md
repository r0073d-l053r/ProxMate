## Highlights

**Restore a VM from a backup you downloaded — migrate between clusters or ProxMate
instances.** The create-VM wizard gains a new source at the bottom of the list,
**"Restore from old build — upload your MateState backup."** Download a backup from the
MateState email link on one ProxMate, upload it here, and it comes back as a new machine —
the missing half of a full self-service migration path.

## Features

- **Restore from an uploaded MateState backup.** A tenant uploads the vzdump archive they
  downloaded (`.vma.zst` for VMs, `.tar.zst` for containers) and ProxMate restores it as a
  brand-new guest. The wizard streams the file with a progress bar; sizing comes from inside
  the backup (and is charged against the uploader's quota). Under the hood:
  - Quota is checked from the archive's **embedded config before anything is restored**.
  - Every volume is **remapped onto this cluster's default disk storage** (a backup from
    another cluster names storages that may not exist here), and the guest gets **fresh MAC
    addresses** so it can't collide with the original.
  - The **tenant-isolation firewall is applied before first boot**, and the uploaded archive
    is removed afterward (it was only a transport carrier).
  - Works for both QEMU VMs and LXC containers.

## Upgrade notes

- **No database migrations, no breaking changes.** One new **optional** environment variable,
  `RESTORE_UPLOAD_MAX_GB` (default `50`, `0` disables the cap).
- **The feature is off until you opt in.** It reuses the backup-downloads mount
  (`BACKUP_DOWNLOAD_DIR`), but for *uploads* that mount must be **read-write** — mount it `rw`
  (not `:ro`) and the wizard option appears automatically; leave it `:ro` to keep downloads
  only. The option stays hidden when the mount is absent or read-only.
- **Cloudflare note:** the free Cloudflare plan caps request bodies at ~100 MB, so multi-GB
  uploads through a Cloudflare Tunnel are rejected at the edge — upload from a LAN / Tailscale
  origin, or raise the plan limit.
- Standard update: **Admin → Settings → Updates → Install update**, or pull + rebuild
  (`docker compose up -d --build`).

## Verification

- Backend suite green: **389 tests** (14 new — config parsing, strict filename + path-traversal
  sanitization, quota-reject cleanup, isolation-before-boot ordering, LXC handling). Typecheck
  and lint clean on both backend and frontend; frontend production build green.
- Verified end-to-end in a browser on a mock-Proxmox rig: a tenant uploads an archive → progress
  bar → the restored VM page renders running with the backup's exact resources and a fresh
  identity, and the uploaded archive is removed from the mount.
- **CodeQL:** the upload route's filesystem paths are re-derived through a containment sanitizer
  (basename → strict pattern → resolve-under-root → containment check); no open code-scanning
  alerts.
- Restore behavior against a **live** multi-node cluster is pending hardware verification (the
  mock exercises the ProxMate plumbing, not Proxmox's own vzdump restore).
