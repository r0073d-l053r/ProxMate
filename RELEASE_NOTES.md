ProxMate 1.3.1 is ProxMate 1.3.0 with its version numbers corrected. The v1.3.0 tag was cut just before the version bump, so an install from it reports itself as 1.2.0 and keeps offering an update. 1.3.1 has the same features and fixes as 1.3.0, described below. Upgrading from 1.3.0 needs no steps beyond the update itself; upgrading from 1.2.x follows the 1.3.0 notes.

## 1.3.0

ProxMate 1.3.0 adds projects, a native Android app, view-only consoles for Viewer shares, tenant notifications, importing existing Proxmox guests and bulk deploys. It also settles operations a backend restart interrupted, takes a snapshot before risky changes, and checks every restored backup before it is used. An optional pool-scoped Proxmox token limits what ProxMate's token can reach.

## New in 1.3.0

- **Projects.** A **Projects** page groups your VMs by a `project:<name>` tag. Each project shows its VM and running counts, allocated vCPU, RAM and disk, and average CPU and RAM use over 1, 7 or 14 days. It has Start all, Stop all and Restart all. Set a project on the VM page or with **Move to project…** on the VM list (owner or admin). VMs shared with you are listed separately, without their owner's tags. Admins see every owner's projects.
- **Android app.** A native app for Android 8 and later. Enter your ProxMate address and sign in with email and password, including 2FA. Passkey and SSO accounts sign in through the web login inside the app. You then get the full ProxMate interface, consoles included.
  - A self-signed certificate is trusted only after you check and accept its SHA-256 fingerprint. You are asked again if it changes.
  - The APK is built by the **Android** workflow for every change, and a signed release APK is built for version tags once the signing secrets are set (see `android/README.md`).
- **View-only console for Viewer shares.** A Viewer share can now watch a VM's graphical and text consoles, but not type into them.
  - ProxMate's console relay drops keyboard, mouse, clipboard, resize and power messages before they reach Proxmox, and keeps the VNC session shared so a viewer never disconnects anyone else.
  - Every console open is recorded in the audit log: `vm.console_open`, or `vm.console_view_open` for a view-only session.
  - A viewer's text console can't be resized.
- **View the IDE install log.** While the ProxMate IDE installs, or after it failed, the VM's owner or an admin can open **View install log** on the VM page. It shows the end of the install log, read through the guest agent, with Refresh and Download.
- **Push a file into a VM.** The owner, an admin or a Manager share can upload a small file into a QEMU VM through the guest agent, choosing its path, mode and owner. No SSH is needed.
  - The default limit is 1 MiB per file (`GUEST_FILE_PUSH_MAX_BYTES`, up to 8 MiB), and 30 pushes per 10 minutes per user.
  - Each push is recorded with its path, size and SHA-256.
  - Into a folder other users can write to, the file is written as the chosen owner. Without an owner, such a push is refused.
- **Tenant notifications.**
  - A tenant is emailed when an admin sets up a VM in their account.
  - A user is emailed when a VM is shared with them or their access level changes, at most once a day per VM.
  - Each user can turn these emails off under Security → Email preferences.
- **Admin-managed badge.** A VM an admin set up for a tenant shows "Set up by your admin — only an admin can resize or rebuild it." instead of silently missing controls.
- **ntfy and Telegram** for admin notifications, alongside the webhook and email. Tokens are stored encrypted and only shown masked, and each channel has its own **Send test**.
- **Weekly usage digest.** Users can opt in (it is off by default, behind an admin switch) to a weekly email with their machines, running hours, average CPU and memory, and quota in use. It is sent on Mondays at 08:00 (`USAGE_DIGEST_CRON`). Admins can send themselves a preview.
- **Import existing Proxmox guests (admin).** Settings → Maintenance → **Import existing guests** lists the QEMU and LXC guests ProxMate doesn't manage.
  - Importing one for an owner applies the default bridge and the isolation firewall, tags it as that owner's, and counts it against their quota or as a grant.
  - A guest is refused if it uses another guest's disks, host devices or host-level settings, or is a privileged container, including inside any of its snapshots.
- **Bulk deploy from a template.** Deploy up to 20 copies (admins: 50) from a name pattern such as `web-{n}`, or, as an admin, one copy into each of several users' accounts.
  - The whole batch is checked against quota first, and nothing is cloned if it doesn't fit.
  - Copies deploy three at a time, each placed and isolated like a single deploy, with progress for each copy.
- **Automatic snapshots before risky changes.** Before a resize, a data-disk resize or a rescue boot, ProxMate takes a disk-only `pm-auto-…` snapshot of the VM, and refuses the change if the snapshot fails.
  - It keeps the newest 3 per VM (1–10, Admin → Settings → Maintenance) and only ever deletes snapshots it took itself.
  - Containers and storage without snapshot support are skipped.
  - A rebuild isn't covered, because deleting the guest deletes its snapshots: take a backup first.
- **Interrupted operations are settled.** A backend restart used to leave machines stuck in "creating". At startup and every 5 minutes, ProxMate now settles them from what Proxmox shows.
  - A finished create is completed and left stopped.
  - A create that produced no guest is removed and its quota freed.
  - Anything part-way is held and admins are told which guest to check.
  - ProxMate writes to a guest only when it can prove the guest came from that machine's own operation. It never deletes a backup.
  - An operation still running, or younger than `RECONCILE_STUCK_MINUTES` (15 minutes), is left alone.
- **`ENCRYPTION_KEY` backup reminder.** Admins see a banner on every page until one of them confirms the key is backed up off the host. A changed key brings the banner back. The key itself is never shown or stored.
- **Pool-scoped Proxmox token (optional).** Set a **Proxmox pool** in the setup wizard or Admin → Settings, and every guest ProxMate creates, clones, restores or imports is placed in it.
  - `deploy/proxmox-token.sh --pool <name>` grants ProxMate's guest privileges on that pool only, instead of the whole cluster. Use `--dry-run` to see the plan first.
  - The connection test checks the pool and what the token can still reach, and **Move managed guests into the pool** moves existing machines.
  - This mode has not yet been run end to end on a live cluster. Try it on a test cluster first, and see DEPLOYMENT.md → *Pool-scoped token*.

## Fixes and changes in 1.3.0

- **Restoring an uploaded backup checks what Proxmox restored.** As soon as the restore ends, autostart, startup order and protection are removed. ProxMate then reads the restored guest's configuration, including pending changes and snapshots, and checks it before the machine can be used. It also clears the firewall rules, IP sets and aliases that came with the backup before applying isolation.
  - A restored guest that doesn't pass is deleted.
  - If Proxmox refuses the delete, the guest is held for an admin with its network links down.
- **Adopt checks the guest's configuration** before tagging it or lifting a hold. Adopting a restored or untagged guest also clears its autostart flags and restored firewall, and brings its network links back up.
- **Number fields can be cleared and retyped.** Emptying a numeric field no longer leaves a stuck `0` that turns the next digit into "02". Min and max apply when you leave the field.
- **Rollback** refuses a snapshot that holds host-level settings or another guest's disks.
- **Machines still being created** refuse every action except delete.
- **Reserved VMIDs** are honoured by every create path, including cloud-image builds and upload restores.

## Upgrading from 1.2.x

No configuration changes are needed. Two database migrations run on first start:
- one adds the email preferences (`User.activityEmailOptOut`, `User.usageDigestOptIn`);
- one adds the operation-tracking fields and the automatic-snapshot table.

- **Back up `ENCRYPTION_KEY`** and confirm it when the banner asks.
- **Automatic snapshots are on by default.** They use storage that isn't counted against quotas, and on node-local storage a VM with snapshots may not live-migrate. Turn them off or lower the count under Admin → Settings → Maintenance if that matters to you.
- **File push on PVE 9** needs `VM.GuestAgent.FileWrite`. `deploy/proxmox-token.sh` now always includes it; re-run the script if you use its token.
- **The usage digest is off** until an admin enables it and users opt in. Set `USAGE_DIGEST_CRON` to change when it is sent (UTC in the Docker image).

---

## 1.2.0

ProxMate 1.2.0 adds sharing with people who haven't signed up yet, spreads template deploys across the cluster, and ships a least-privilege Proxmox token. **Coming from 1.0.x?** Read the 1.1.0 notes below first: they include the upgrade steps.

## New in 1.2.0

- **Share a VM before someone signs up.** Sharing with an address that has no account keeps a pending share. It starts when an account is created with that address and the address is confirmed: registration through an invite sent to that address, or SSO sign-up with an email the identity provider verified. A self-typed address on an open invite never picks it up. Pending and live shares look the same in the owner's list, so sharing still doesn't reveal who has an account, and either kind can be revoked. A pending share doesn't invite anyone: send an invite to the same address. A VM can hold up to 100 shares.
- **Template deploys spread across the cluster.** A deploy that is a full clone, with the template's disks and the destination storage on shared storage (Ceph, NFS), goes to the node with the most free capacity instead of the template's node. It only picks nodes that can serve the deploy's cloud-init snippet. Linked clones and anything on node-local storage stay on the template's node as before.
- **Least-privilege Proxmox token.** `deploy/proxmox-token.sh` creates a `proxmate@pve` user, a `ProxMate` role holding only the privileges ProxMate uses, and a privilege-separated token. It picks the guest-agent privileges for your Proxmox release and can be re-run safely. It was run end to end on a 7-node Proxmox VE 9.2 cluster with every feature working through it. See DEPLOYMENT.md §2.2.
- **Connection test checks every privilege.** It now warns about each privilege ProxMate uses, including backups, migration, the cluster firewall and the guest-agent privileges that changed in Proxmox VE 9.

## Fixes in 1.2.0

- **Start and restart report what Proxmox did.** Like stop in 1.1.0, they wait up to 45 seconds for Proxmox to confirm the task. A failed start now returns its error instead of marking the VM running, and a restart the guest ignores returns advice to wait or stop it forcibly. Bulk start, stop and restart run side by side.

## Upgrading from 1.1.x

No configuration changes are needed. A database migration adds the pending-shares table on first start.

- Admins using a narrower Proxmox token than root or Administrator may see new connection-test warnings: each names a privilege a feature needs. Re-run `deploy/proxmox-token.sh`, or grant the named privileges.
- On clusters with shared VM storage, new template deploys may land on a different node from the template.

---

## 1.1.1

- **API tokens and ended access.** A personal API token whose owner's compute access window has ended now answers **403** with `code: "access_expired"`, the same as a browser session. It used to answer 401, which looked like a bad token. Unknown, revoked or expired tokens still answer 401.
- **Docker Compose settings.** `ALERT_COOLDOWN_MIN`, `PUBLIC_TOKEN_RATE_LIMIT_MAX` and `PUBLIC_TOKEN_RATE_LIMIT_WINDOW_MS` are now passed through to the backend, so setting them in `.env` takes effect.
- **Settings that aren't numbers.** `PORT` and `RESTORE_UPLOAD_MAX_GB` fall back to their defaults when set to something that isn't a number. A bad `RESTORE_UPLOAD_MAX_GB` used to turn the upload size limit off.
- **Docs.** The README, deployment guide, admin guide, API and IDE docs, and the security guide are updated for 1.1.0. `SECURITY.md` now says which versions get security fixes and how to report a problem privately.

No configuration changes are needed to upgrade from 1.1.0.

---

## 1.1.0

ProxMate 1.1.0 is a security and reliability release. It follows a full review of the codebase and closes every issue that review found, and it fixes the setup wizard on SDN-only clusters (#126). Every 1.0.x install should upgrade. Read **Upgrading** below first: a few changes need a step from the admin, and some behaviour changes on purpose.

### Security

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

### Fixes

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

### Upgrading

#### Upgrading from 1.0.x and earlier

Read DEPLOYMENT.md §14.4 before updating. In short:

- **Before updating, move local `docker-compose.yml` edits into `docker-compose.override.yml`.** The update into this release is run by the updater already on the host, which force-checks-out the release and discards edits to tracked files — including uncommented `/control`, private-CA, snippets and backup-download mounts. Copy those mounts into `docker-compose.override.yml` (after `git fetch --tags`, take the template with `git show <new-tag>:docker-compose.override.example.yml`), run `git checkout -- docker-compose.yml`, then update. From this release on, optional mounts live only in the override, and the updater refuses to run over local edits instead of discarding them.
- **Re-install the updater units** after updating: copy `deploy/proxmate-updater.service` and `deploy/proxmate-updater.path` to `/etc/systemd/system/` and run `systemctl daemon-reload`.
- **Images move to Node 22** (`node:22-alpine`); Node 20 is end-of-life.
- **`TRUST_PROXY` ≥ 1 is required for the audit log's real-IP header** (`REAL_IP_HEADER`, default `cf-connecting-ip`); `x-forwarded-for` is resolved through the trusted hop count. Behind Caddy, nginx or a Cloudflare Tunnel keep `TRUST_PROXY=1`.
- **The backend refuses to start in production without `ENCRYPTION_KEY`.** Docker installs already require it; bare `node`/`npm start` runs no longer generate a key in memory.

#### What changes for admins and users after upgrading from 1.0.x

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

#### Also

- SSO links to an existing local account only when the IdP sends `email_verified: true` and the account's email was bound by an emailed invite (or is the setup-wizard admin). After upgrading, local accounts registered with a self-typed address, and every account when the IdP omits `email_verified`, no longer auto-link on first SSO login; those users keep signing in with their password. Accounts already linked are unaffected.

- Rebuild cloud-image templates to pick up the guest agent. Password-only deploys from templates built before this release produce machines their owner cannot log into. Template Store flags them.
- Guests created before this release keep their existing storage. `GET /api/admin/storage-pinning` lists any that cannot migrate as a result.
