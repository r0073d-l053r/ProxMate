## Highlights

A hardening release. The kiosk wall panel becomes monitoring-only and stops
leaking who owns what, and app-database backups can finally be pointed at a
directory on the host without hitting a wall.

- **Kiosk is monitoring only** — the VMs tab no longer carries power controls,
  and three separate ways out of the panel that skipped the passkey/PIN exit
  gate are closed.
- **App-database backups: choose the host location in `.env`** — the setting
  now works out of the box, and failures explain themselves instead of emitting
  a bare `EACCES`.

No breaking changes. Upgrading from v0.8.5 is a normal update.

## Kiosk mode: monitoring only

The wall panel's VMs tab was rendering the admin VM card verbatim, so anyone
walking past could **start, gracefully shut down, hard power off, or reboot any
tenant's machine**, and open its console. A rack panel should show state, not
change it. Those controls are now removed from the panel entirely — not
disabled, removed, because a greyed-out button still advertises an action that
doesn't belong there. Live status, sparklines, and per-node health are unchanged.

An adversarial review of the panel then found three more ways past the exit
lock, all now closed:

- **The browser Back button left kiosk entirely.** One gesture — Back, an
  edge-swipe, or `Alt+Left` — landed on the admin dashboard with a live admin
  session and every power control, without ever showing the passkey/PIN prompt.
  Kiosk is now entered so that nothing sits behind it in history, and a
  back-navigation opens the same unlock dialog as the corner exit button.
- **A long-press opened the browser context menu**, offering Back again and
  Inspect — a developer console on an authenticated admin session. Suppressed.
- **The VM name and console icon were links** into the full dashboard, which
  walked around the exit gate the same way.

## Kiosk mode: what's on the glass

Two disclosure fixes, holding the panel to the standard the Activity tab already
set (show what happened, never who did it):

- **The activity feed could print a tenant's email address.** Sharing a VM
  records an audit line beginning with the recipient's address, and the panel's
  label logic took that leading word and displayed it styled as a machine name.
  VM names are now resolved from the actual inventory, so a label is either a
  real machine name or absent. This also stops node names and stray words being
  dressed up as VMs.
- **The VMs tab no longer names each tenant.** It listed every owner's display
  name beside their machines and quota — a who-owns-what map readable from the
  hallway. Groups now read "Tenant · 3 guests", with the crown icon still
  distinguishing admin-owned guests from tenant-owned ones.

## App-database backups: pick the host directory

Pointing the backup setting at a folder created on the host failed with:

```
EACCES: permission denied, mkdir '/srv/backups'
```

That reads like a file-permission problem and sends you off fixing ownership on
the host. It isn't one: ProxMate runs in a container and can only write to
directories **mounted into** it, so a host folder that was never mounted is
unreachable no matter what its permissions are.

The host location is now chosen where it has to be — when the container is
created:

```bash
# .env
PROXMATE_BACKUP_DIR=/mnt/backups/proxmate
```

The container-side path is fixed and is the default for the in-app setting, so
backups work out of the box rather than requiring you to discover which paths
are writable. An explicitly empty directory still means "disabled".

Failures now explain themselves. A permission error names the container-mount
cause and says creating the folder on the host isn't enough on its own; missing
directories, read-only (`:ro`) mounts, and full disks each get their own
message. The directory is also checked **when you press Save**, so a bad path is
rejected while you're looking at it instead of failing silently at 02:30.

`DEPLOYMENT.md` gains an App-database backups section covering the container
boundary, setup, restore steps, and the reminder that a snapshot is useless
without the matching `ENCRYPTION_KEY`.

## Upgrade notes

Standard update — pull the release and rebuild. No database migration.

`docker-compose.yml` gains a backup mount that defaults to `./backups` beside
the compose file, so existing installs get a working backup target without any
configuration. Set `PROXMATE_BACKUP_DIR` in `.env` to put it somewhere better —
ideally a different disk from the database, or an off-host share.

If you run a kiosk panel, its VM controls are gone by design. Power actions live
in **Admin → Monitor** and on each VM's page, behind a normal login.

## Verification

718 backend tests, 12 frontend tests, typecheck and lint clean on both, frontend
production build green, Playwright smoke passing, CodeQL / Trivy / npm audit /
SBOM green.

The kiosk changes came out of an adversarial multi-agent review of the panel
that produced 11 candidate findings; the 4 that survived independent
verification are the ones fixed above. The backup change was verified end to end
on a live host: a mounted directory produces real snapshots from both the manual
button and the scheduled (non-root) path.
