## Security

- Cloud-init login passwords are no longer given to cloud-init. The crypt hash was written to the seed drive (`/dev/sr0`) and to the guest's `/var/lib/cloud` cache, both readable by the VM's own user for its lifetime. The password is now held encrypted until first boot, applied in-guest via the QEMU guest agent, then discarded. `cipassword` was removed from `setCloudInitConfig`'s signature.
- Axios client error objects are sanitized before logging. An axios error carries the request that produced it, including the `Authorization` header, so `config` and `request` are now replaced with sanitized copies at the client, on both the error and its response, keeping only method, url, baseURL, timeout and a redacted header.
- Guests can be placed on a per-tenant VLAN. The per-VM firewall operates at L3 and above and could not prevent ARP poisoning, rogue DHCP, or IPv6 router advertisement between tenants sharing a bridge. Verified on a live cluster: cross-VLAN blocked at ARP resolution, same-VLAN control passes.
- Outbound DHCP server replies (`udp dport 68`) and IPv6 router advertisements are dropped per guest. Clients still obtain leases.
- The compute-access window is enforced on passkey and SSO login, not only password. All three paths share one refusal; a source-scan test fails if a new login path skips it.
- `testProxmoxConnection` rejects a token that authenticates but holds no permissions. A `--privsep 1` token answers `/version` and returns every node, so the previous check reported success. It now reads `/access/permissions` and names the missing privilege and the command that grants it.

## Fixes

- The default network bridge and default storage are applied to guests deployed from a template. A template deploy is a clone, so both were inherited from the template and the configured defaults never applied. Storage additionally reverted the migratability fix from 0.9.0 — new guests kept landing on node-local storage. Applied on deploy, duplicate and restore, preserving MAC, firewall flag and VLAN tag.
- A linked-clone template that is not on the configured storage is now full-cloned. Proxmox cannot place a linked clone on a different storage; the link is dropped rather than the setting, and the reason is logged.
- Cloud-image templates built by ProxMate now include `qemu-guest-agent`. The importer converted the downloaded image to a template without booting it, so no package could be installed — and since login passwords are applied through the agent, those templates could not serve a password-only deploy. The build boots the image once, installs and verifies the agent, clears the cloud-init cache and build logs, then converts. A build without network access still produces a usable template, recorded as agentless and flagged in Template Store.
- `deploy.agent_missing` notification when a deploy's guest agent never responds. Previously the only signals were a log line and a tenant unable to log in.
- `GET /api/admin/storage-pinning` lists guests that cannot migrate, using Proxmox's own migration preflight.

## Modules

Self-hosted installs can add API routes and database tables without patching `app.ts`. A module is a directory exporting an Express router, enabled by name in `PROXMATE_MODULES` and served under `/api/ext/<name>`.

Modules supply a router rather than the application, so they cannot reorder middleware or replace the error handler. All modules mount under one reserved path segment and cannot shadow a built-in route. `requireAuth` is applied by default; opting out is logged by name at boot. Modules may own a Prisma schema and migrations, applied after core migrations.

With no module configured no import is attempted and no route is added. See `backend/src/modules/README.md`.

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

### Development databases

- The migration `20261019140000_vm_status_message` was renamed to `20261019140000_vm_hold_reason` (it adds `VirtualMachine.holdReason`) before any release shipped it. A development database that already applied the old name keeps a stale `statusMessage` column and migration record, and `prisma migrate dev` reports drift; reset it (`npx prisma migrate reset`). Release installs are unaffected.
