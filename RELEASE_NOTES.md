## Highlights

ProxMate 1.0.0 closes both findings from the tenant-isolation penetration test, fixes
three admin settings that were accepted and then quietly ignored, and adds a supported
way to extend a self-hosted install.

The version number is not a feature announcement. It marks the point where the
isolation story is honest: a tenant can no longer read another tenant's credentials off
their own disk, and can no longer reach their neighbours at layer 2.

**Every fix below was verified on a real seven-node Proxmox cluster, not only in tests.**

## Security

**A tenant could read their own cloud-init login password.** Handing a password to
cloud-init writes its crypt hash to the seed drive (`/dev/sr0`) *and* to the guest's own
`/var/lib/cloud` cache — both readable, for the life of the VM, by the person who is
supposed to be typing it. Ejecting the seed does not help, because the on-disk cache
survives. ProxMate now never gives the password to cloud-init at all: it is held
encrypted only until the guest boots, applied in-guest through the QEMU guest agent
(which writes only to `/etc/shadow`), then destroyed. The insecure parameter was removed
from the function signature, so the old path is unrepresentable rather than merely
unused.

**Tenants shared a broadcast domain.** The per-VM firewall works at layer 3 and above,
so it could not stop a guest poisoning ARP, answering DHCP, or advertising itself as an
IPv6 router to its neighbours. Guests can now be placed on a per-tenant VLAN, applied at
the one point every guest passes through. Verified live: cross-VLAN traffic blocked at
ARP resolution, with a same-VLAN control that still passes.

**Tenants could serve DHCP and advertise IPv6 routes.** Outbound DHCP-server replies and
router advertisements are dropped. Confirmed that a guest still receives its own lease.

**The compute-access window was only enforced on password login.** Passkey and SSO
sign-in bypassed it, so an expired tenant could still get in. All three paths now share
one refusal, and a test fails if a future login path skips it.

**The Proxmox connection test passed against a token that could do nothing.** Measured
on a real cluster: a token with zero permissions answers `/version` and returns all seven
nodes, so the old check reported *"Connected to Proxmox VE 9.2.3 (7 nodes)"* — the most
reassuring result it can produce. The test now asks what the token may actually do and
names the missing privilege, plus the command that grants it.

## Fixes

**Two admin settings were ignored for every guest deployed from a template.** A template
deploy is a *clone*, so the network bridge and the disk storage were inherited from the
template and the configured defaults never applied. The storage half was the worse one:
it silently undid an earlier fix, so new guests kept landing on node-local storage and
could not be migrated. Both now apply on every clone path — deploy, duplicate and
restore — preserving MAC address, firewall flag and VLAN tag.

Because a Proxmox linked clone cannot be placed on a different storage, a template that
does not already live on the configured pool is now full-cloned. The link gives way, not
the setting, and the reason is logged.

**New admin report: guests that cannot migrate.** The storage fix is forward-looking, so
`GET /api/admin/storage-pinning` lists guests deployed before it that are still pinned,
using Proxmox's own migration preflight rather than a second opinion that could disagree
with it.

**Templates built by ProxMate had no guest agent.** The importer converted a downloaded
cloud image straight to a template without ever booting it, so no package could be
installed — and since login passwords are applied through the agent, those templates
could not serve a password-only deploy at all. The builder now boots the image once,
installs the agent, waits for it to answer, clears the cloud-init cache and the build
boot's logs, and then converts. A build with no internet access still produces a usable
template, marked as agentless, and Template Store shows admins which ones those are.

**A deploy whose guest agent never answers now tells an admin.** Previously the only
signals were a log line nobody watches and a tenant who could not log in.

## Extending ProxMate

A self-hosted install can now add its own API routes and database tables without
patching `app.ts` and re-resolving the same conflict on every upgrade. A module is a
directory exporting an Express router; it is enabled by naming it in `PROXMATE_MODULES`
and served under `/api/ext/<name>`.

The seam is deliberately narrow. A module supplies a router, never the application, so
it cannot reorder middleware or replace the error handler. All modules live under one
reserved path segment, so a module can never shadow a built-in route. Authentication is
on by default and an opt-out is logged by name at every boot. Modules may own their own
Prisma schema and migrations.

**With no module configured, nothing changes.** No import is attempted, no route is
added, and the request pipeline is exactly what it was. See
`backend/src/modules/README.md`.

## Upgrading

No configuration change is required, and no action is needed for existing guests.

Two things are worth knowing:

- **Rebuild your cloud-image templates** to pick up the guest agent, or password-only
  deploys from them will produce machines their owner cannot log into. Template Store
  flags the ones that need it.
- **Guests created before this release keep the storage they were given.** The new admin
  report lists any that cannot migrate as a result; moving a disk stays a deliberate
  human decision.
