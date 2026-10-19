ProxMate 1.1.0 is a security and reliability release. It follows a full review of the codebase and closes every issue that review found, and it fixes the setup wizard on SDN-only clusters (#126). Every 1.0.x install should upgrade. Read **Upgrading** below first: a few changes need a step from the admin, and some behaviour changes on purpose.

## Security

- **Guest ownership.** Every guest ProxMate manages now carries a Proxmox tag naming its machine. Start, stop, console, IDE, backups, restores, resize and delete act only on a guest carrying its own machine's tag, so a stale or reused VMID can never point an action at someone else's guest. Existing guests are tagged on first start; see **Upgrading**.
- **ProxMate IDE.** The IDE opens only for the machine's owner. Before connecting, ProxMate confirms it is talking to that machine's own guest using a per-machine secret, and ProxMate's cookies are never passed to the guest or accepted back from it.
- **Setup wizard.** Once the admin account exists, every remaining setup step requires that admin's session.
- **Sign-in and account security.** Failed logins and 2FA codes are counted reliably under concurrent attempts, and 2FA codes are limited per account and per challenge. Passkey challenges are kept on the server and are single-use. Download links, password-reset links and recovery codes work exactly once. A password reset revokes the account's API tokens and signs it out everywhere. Replacing an existing authenticator needs a current code. Required 2FA also applies to password logins on SSO-linked accounts.
- **API tokens** (`pm_…`) are refused on routes that change how an account signs in or is secured; those need a browser session.
- **SSO and invites.** SSO links to an existing local account only when the identity provider marks the email verified and the account's email was confirmed by an invite. An invite sent to an address can be used only with that address.
- **Backups and restores.** Restoring an uploaded backup accepts only a guest's own configuration (no host devices or paths, raw arguments, hook scripts or privileged containers; containers always restore unprivileged). Restores, rollbacks and backups check that every disk belongs to that guest. Restores and rollbacks re-apply the guest's network isolation before it starts, and count against the owner's quota.
- **Quotas** are enforced when several creates or resizes for the same owner run at once.
- **Sharing.** Sharing a machine by email answers the same whether or not the address has an account, and is rate-limited per user. The share list shows only the address and access level.
- **Admin settings and the audit log.** Settings changes are audited without recording secret values, the notification webhook URL is shown only masked, and the audit log trusts a client-IP header only behind a configured proxy.
- **Deployment.** App-database snapshots are created readable by their owner only. The host updater no longer leaves root-owned files in the checkout and keeps its control files out of the app's reach. The backend refuses to start in production without a saved `ENCRYPTION_KEY`, and images move to Node 22.

## Fixes

- **SDN and OVS networks (#126).** The setup wizard and network settings list SDN VNets and Open vSwitch bridges, not only Linux bridges. A network name can be typed in when discovery finds nothing, and the connection test warns when the token lacks `SDN.Use` or `SDN.Audit`.
- **Stop reports what Proxmox did.** Stop waits for Proxmox to confirm the guest is down (up to 45 seconds). A guest that ignores a shutdown now returns an error asking you to wait or force-stop, instead of being marked stopped while it keeps running. Bulk and scheduled stops run side by side, so several slow guests don't add up.
- **Migration** no longer reports every possible target node as blocked.
- **Resize** grows the root disk by the requested change, not to the requested total, so data disks are no longer counted twice. Machines need at least 64 MB of RAM.
- **Failed creates** no longer leave orphaned rows or untagged guests behind. A machine that didn't finish creating, rebuilding or restoring is held, and its page says why.
- **Locked machines.** Bulk actions, migrations, the Cluster Balancer and node drains skip a machine while its IDE installs or its cloud-init deploy finishes, and report it.
- **Schedules.** Invalid stored power and backup schedules are reported to admins at startup. Per-VM backups missed while the backend was down run after it restarts.
- **Alerts** are capped at 20 rules per machine, duplicates are refused, and simultaneous firings are delivered once.
- **Dashboard.** While the API is unreachable the dashboard retries with a clear retry state instead of bouncing between pages. Bulk actions apply only to the selected machines visible under the active filter. Resize and quota dialogs keep RAM sizes exact. A rejected kiosk-exit PIN keeps the kiosk signed in.
- **Settings.** Numeric settings that aren't numbers fall back to their defaults instead of breaking. The Docker backend receives every setting documented in `.env`. code-server listens on `IDE_GUEST_PORT`.
- **Updater.** Local `docker-compose.yml` changes now live in `docker-compose.override.yml`, and the updater refuses to run over local edits instead of discarding them.

## Upgrading

### Upgrading from 1.0.x and earlier

Read DEPLOYMENT.md §14.4 before updating. In short:

- **Before updating, move local `docker-compose.yml` edits into `docker-compose.override.yml`.** The update into this release is run by the updater already on the host, which force-checks-out the release and discards edits to tracked files — including uncommented `/control`, private-CA, snippets and backup-download mounts. Copy those mounts into `docker-compose.override.yml` (after `git fetch --tags`, take the template with `git show <new-tag>:docker-compose.override.example.yml`), run `git checkout -- docker-compose.yml`, then update. From this release on, optional mounts live only in the override, and the updater refuses to run over local edits instead of discarding them.
- **Re-install the updater units** after updating: copy `deploy/proxmate-updater.service` and `deploy/proxmate-updater.path` to `/etc/systemd/system/` and run `systemctl daemon-reload`.
- **Images move to Node 22** (`node:22-alpine`); Node 20 is end-of-life.
- **`TRUST_PROXY` ≥ 1 is required for the audit log's real-IP header** (`REAL_IP_HEADER`, default `cf-connecting-ip`); `x-forwarded-for` is resolved through the trusted hop count. Behind Caddy, nginx or a Cloudflare Tunnel keep `TRUST_PROXY=1`.
- **The backend refuses to start in production without `ENCRYPTION_KEY`.** Docker installs already require it; bare `node`/`npm start` runs no longer generate a key in memory.

### What changes for admins and users after upgrading from 1.0.x

**Guest ownership tags and the Unconfirmed machines card**

- Every guest ProxMate manages now carries a Proxmox tag naming its machine (`proxmate-<id>`; templates `proxmate-template-<id>`). Start, stop, console, IDE, backups, restores, resize and delete act only on a guest that carries its own machine's tag. The Proxmox API token must be allowed to set guest tags (`VM.Config.Options`); the recommended privilege-separation-off token, or one with the Administrator role, is.
- At first start the upgrade tags existing guests. A machine is tagged only when exactly one machine references its VMID, its status is not `error` or `creating`, its guest has no ProxMate tag yet, and the guest's Proxmox name matches the machine's name. Everything else stays **unmatched**: machines left in `error` or `creating` by 1.0.x, machines renamed in Proxmox (or in ProxMate) so the names differ, and VMIDs referenced by more than one machine.
- If Proxmox can't be reached at boot, or a guest can't be read, the tagging pass is retried every 15 minutes until a pass completes. When a completed pass leaves machines unmatched, admins get one `vm.error` notification with the count.
- Unmatched machines are refused (start, console, IDE, backups, delete) until an admin settles them in **Settings → Maintenance → Unconfirmed machines**: **Adopt** tags the guest at the VMID as that machine's. On an `error` or held machine it then puts the guest on the current bridge with isolation applied and re-reads its CPU, RAM and disk sizes, as a restore does, and only then clears the hold so the machine can be started; disks over the owner's quota keep it held, **Remove row** deletes only the ProxMate record and leaves the guest alone. Adopt is refused for a guest that carries another machine's tag, is a Proxmox or Template Store template, has another machine on the same VMID, or references disks that aren't its own.
- Removing or refreshing a template deletes the old Proxmox guest only while it still carries that template's tag. Otherwise it is left in place and admins are notified.

**Machines that can't run**

- A machine in `error`, or held after a create, rebuild or restore that didn't finish (or a restore that left it over quota), can't be started and its console and IDE don't open. Its page says why. It can be restored, rebuilt, adopted by an admin, or deleted.
- Backups are refused for a machine whose config references a disk that isn't one of its own storage volumes. That includes disks that are not volumes at all, such as an iSCSI LUN or a host disk passed through by path; such a guest can't be adopted either. Detach the disk in Proxmox first.
- **Restore from an uploaded backup** accepts only archives whose config describes the guest itself. Host devices and paths, raw QEMU or LXC keys, hook scripts, custom cloud-init snippets, CPU/NUMA host pinning, container features beyond nesting, a template flag and privileged containers are refused. Containers are always restored unprivileged.
- Machines need at least 64 MB of RAM: a create, deploy or resize asking for less is refused with 400.
- A resize changes the root disk by the difference between the requested total and the current total, so data disks are no longer counted twice.
- Bulk stop, restart and delete, single migrations, the Cluster Balancer and node drains skip a machine that is locked while its IDE installs or its cloud-init deploy finishes, and report it instead of acting on it.
- A machine can have at most 20 alert rules; adding a 21st, or a duplicate of an existing rule, answers 409.
- Stored power and backup schedules that aren't valid cron expressions never fire. At startup, admins are notified with a list of the affected machines; re-save those schedules on each machine's page.

**ProxMate IDE**

- The IDE opens only for the machine's owner. Admins and people the machine is shared with no longer open it.
- An IDE installed by 1.0.x must be reinstalled once before it opens. This happens automatically the first time its owner opens it, and takes about a minute.

**Accounts, sign-in and API tokens**

- `pm_` API tokens are refused (403) on routes that change how an account signs in or is secured: session refresh, 2FA, passkeys, API-token management, invites, the kiosk exit check, and the admin kiosk, SSO and reset-password settings. The full list is in `docs/api.md`. Scripts that used a token for these must use the web app.
- An invite sent to an email address can only be used to register with that address (400 otherwise); invites without an address are unchanged.
- A password reset (self-service or by an admin) revokes all of the account's API tokens and signs it out everywhere.
- Re-running 2FA setup on an account that already has 2FA requires a current authenticator or recovery code.
- Leaving kiosk mode with a wrong PIN, password or passkey now answers **403** with `code: "reauth_failed"`. A 401 there always means the session is gone.
- After the setup wizard creates the admin account, every later setup step requires that admin's session.

**Sharing, users and settings**

- The share list (`GET /api/vms/:id/shares`) returns only `id`, `email`, `role` and `createdAt` for each share. `POST /api/vms/:id/shares` answers **202** whether or not the address has an account, and is limited per signed-in user (30 per hour by default; `SHARE_RATE_LIMIT_MAX` and `SHARE_RATE_LIMIT_WINDOW_MS`, both forwarded by `docker-compose.yml`).
- `DELETE /api/users/:id` answers **409** and keeps the account when any of its machines can't be deleted together with its guest: an unmatched machine, a guest whose location can't be confirmed, or a guest that fails to delete. The response lists those machines (`vms`); adopt or remove them, then try again.
- The notification webhook URL is no longer shown in admin settings, only a masked form of it. Leave the field blank to keep the stored URL.

### Also

- SSO links to an existing local account only when the IdP sends `email_verified: true` and the account's email was bound by an emailed invite (or is the setup-wizard admin). After upgrading, local accounts registered with a self-typed address, and every account when the IdP omits `email_verified`, no longer auto-link on first SSO login; those users keep signing in with their password. Accounts already linked are unaffected.

- Rebuild cloud-image templates to pick up the guest agent. Password-only deploys from templates built before this release produce machines their owner cannot log into. Template Store flags them.
- Guests created before this release keep their existing storage. `GET /api/admin/storage-pinning` lists any that cannot migrate as a result.
