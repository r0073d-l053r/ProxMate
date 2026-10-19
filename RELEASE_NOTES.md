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

- **Before updating, move local `docker-compose.yml` edits into `docker-compose.override.yml`.** The update into this release is run by the updater already on the host, which force-checks-out the release and discards edits to tracked files — including uncommented `/control`, private-CA, snippets and backup-download mounts. Copy those mounts into `docker-compose.override.yml` (template: `docker-compose.override.example.yml`), run `git checkout -- docker-compose.yml`, then update. From this release on, optional mounts live only in the override, and the updater refuses to run over local edits instead of discarding them.
- **Re-install the updater units** after updating: copy `deploy/proxmate-updater.service` and `deploy/proxmate-updater.path` to `/etc/systemd/system/` and run `systemctl daemon-reload`.
- **Images move to Node 22** (`node:22-alpine`); Node 20 is end-of-life.
- **`TRUST_PROXY` ≥ 1 is required for the audit log's real-IP header** (`REAL_IP_HEADER`, default `cf-connecting-ip`); `x-forwarded-for` is resolved through the trusted hop count. Behind Caddy, nginx or a Cloudflare Tunnel keep `TRUST_PROXY=1`.
- **The backend refuses to start in production without `ENCRYPTION_KEY`.** Docker installs already require it; bare `node`/`npm start` runs no longer generate a key in memory.

### Also

- Rebuild cloud-image templates to pick up the guest agent. Password-only deploys from templates built before this release produce machines their owner cannot log into. Template Store flags them.
- Guests created before this release keep their existing storage. `GET /api/admin/storage-pinning` lists any that cannot migrate as a result.
