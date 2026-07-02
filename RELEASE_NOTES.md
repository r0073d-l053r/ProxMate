## ✨ Highlights

**A big one.** v0.5.0 is a feature-packed release focused on the tenant experience — a
DigitalOcean-style console workflow, self-service recovery and cloning, proactive
monitoring alerts, always-fresh cloud images, and downloadable backups. Six new
capabilities, all reachable from a machine's page.

### 🖥️ A better console

- **Power actions on the console page** — an **Actions** menu (Start / Pause / Resume /
  Restart / Shut down / Force stop) so you can manage a machine without leaving its
  terminal. Pause/Resume use QEMU suspend, so resuming is instant.
- **Pop-out text console** — open the terminal in its own window, and with **"Keep on top"**
  (on Chrome/Edge) float it above everything else while you work — VMware/DigitalOcean style,
  with real copy/paste.
- **Live Insights** — a machine's metrics view now has a **Live** mode that updates **every
  second** with the chart zoomed to the actual activity, so a quiet VM no longer looks flat.
  Day and Week keep the historical view.

### 🛟 Self-service recovery & cloning

- **Reset guest password** — locked out of a key-only cloud image? Set a new password for a
  user inside the machine (via the guest agent) and it's shown to you once. On the Settings tab.
- **Rescue mode** — one click boots a broken VM from an admin-designated rescue ISO with your
  disk still attached; **Exit rescue** restores the original boot order. (Admins pick the rescue
  ISO under Admin → Settings.)
- **Duplicate a VM** — clone your own stopped VM into a brand-new one from the Actions menu:
  same size, disk, and tags, quota-checked, and firewalled before first boot.

### 🔔 Monitoring alerts

- **Per-VM resource alerts** — set thresholds on a machine (**CPU %, memory %, disk full, or an
  unexpected stop**) with a "for N minutes" window, and get a branded email (and your admin's
  webhook) when one trips. Managed from an **Alerts** card on the Settings tab; checked on the
  existing sampling cycle so it adds no load.

### ♻️ Fresher images & downloadable backups

- **Cloud-image freshness** — admins can **Refresh** a cloud-image template (or enable a **monthly
  auto-refresh**) to rebuild it from the latest upstream image, so new deploys always start from a
  patched base. Existing VMs are untouched.
- **Backup downloads** — when the admin mounts the backup share, tenants get a **Download** button
  on each backup that emails them a **single-use, one-hour link**. (See upgrade notes.)

### ✨ Polish

- **OS logos** next to the operating system on the VM list, the machine header, and its
  configuration.
- **Safer deletes** — deleting a machine now requires typing its exact name and reminds you to grab
  a backup first.
- Removed the redundant "Live" badge from the machine header.

## 🔄 Upgrade notes

- **Four database migrations** (`add_rescue_state`, `add_alert_rules`, `add_template_source`,
  `add_download_token`) apply **automatically** when the API container starts — no manual step.
- **No breaking changes.** New **optional** settings:
  - `BACKUP_DOWNLOAD_DIR` — mount your backup share into the API container and point this at it to
    turn on **tenant backup downloads** (requires SMTP). Left unset, the feature stays hidden. See
    [DEPLOYMENT.md](./DEPLOYMENT.md).
  - `TEMPLATE_REFRESH_CRON` (default: 1st of the month) and the **Admin → Settings** toggle control
    the monthly cloud-image auto-refresh; `ALERT_COOLDOWN_MIN` tunes alert re-fire spacing.
- Standard update: **Admin → Settings → Updates → Install update**, or pull + rebuild
  (`docker compose up -d --build`).

## 🧪 Verification

- Backend: typecheck + full Vitest suite green (**372 tests**, +58 across the six features —
  including the alert sustain/cooldown state machine, rescue boot-config snapshot/restore, and the
  path-traversal-hardened backup-download resolver). Frontend: typecheck, lint, and production build
  green; every feature was verified in-browser against a mock cluster, and the public backup-download
  route was exercised end-to-end (stream once, then single-use 404) on a live server.
- A modulo-bias weakness in the new password generator was caught by CodeQL and fixed (unbiased
  `crypto.randomInt`) with a regression test.
- Live-cluster paths (rescue, password reset, duplicate, real image refresh, mounted-share download)
  are best verified on real hardware after upgrading.
