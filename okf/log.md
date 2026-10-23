# Bundle Update Log

## 2026-10-23
* **Update**: Numeric form fields use a shared `NumberInput` (frontend/src/components/ui/number-input.tsx) that keeps the typed text and applies min/max on blur, so a field can be emptied and retyped.
* **Update**: Roadmap corrected against the source: the reconciler gap is a backend restart mid-operation, the admin-managed explainer and the `ENCRYPTION_KEY` reminder are partly built, and two restore/delete ownership checks still need a live-cluster run.
* **Creation**: Documented Projects: the [project router](/api/project.md) and [project service](/services/project.md), and the `project:` tag on [VirtualMachine](/database/virtual-machine.md).
* **Update**: Documented the view-only console: the `console_view` capability held by [Viewer shares](/database/vm-share.md), console ticket grants and the input filters in the [console relay](/api/console.md), and the `vm.console_open` audit entry.
* **Creation**: Documented the [guest-file service](/services/guest-file.md): pushing a file into a QEMU guest (`POST /api/vms/:id/files`) and reading the IDE install log (`GET /api/ide/:id/install-log`), their rate limits and the `VM.GuestAgent.FileWrite` privilege now always in the least-privilege role on PVE 9.
* **Creation**: Documented the [activity-mail](/services/activity-mail.md) and [usage-digest](/services/usage-digest.md) services and the [usage digest setting](/config/usage-digest.md).
* **Update**: Added the ntfy and Telegram channels to [notifications](/config/notifications.md) and the [notify service](/services/notify.md); new [User](/database/user.md) email preferences, `USAGE_DIGEST_CRON`, and the share and deploy-for-tenant emails in the [VM](/api/vm.md), [template](/api/template.md), [auth](/api/auth.md) and [admin](/api/admin.md) APIs.
* **Creation**: Documented the [guest import](/services/guest-import.md) and [bulk deploy](/services/bulk-deploy.md) services and their routes in the [admin](/api/admin.md) and [template](/api/template.md) routers, and VMID reservations in the [vm service](/services/vm.md).
* **Update**: Documented the view-only console: the `console_view` capability held by [Viewer shares](/database/vm-share.md), console ticket grants and the input filters in the [console relay](/api/console.md), and the `vm.console_open` / `vm.console_view_open` audit entries.
* **Update**: Import checks every snapshot of the guest and isolates before tagging; snapshot rollback in [matestate](/services/matestate.md) refuses host-level settings and other guests' volumes; rows still `creating` are refused by `requireOurGuest` and the vm router.

## 2026-10-20
* **Update**: Documented [pending shares](/database/pending-vm-share.md), template deploy placement, start/restart waiting for the Proxmox task, and the least-privilege token in [privileges](/proxmox/privileges.md), with what a live Proxmox VE 9.2 cluster proved.

## 2026-10-19
* **Update**: Refreshed the bundle against the 1.1.0 release: guest ownership tags and holds, stops that wait for the Proxmox task, migration preflight, session-only routes, single-use links and codes, compose override and updater changes; added the [unconfirmed machines](/playbooks/unconfirmed-machines.md) and [upgrading from 1.0.x](/playbooks/upgrading-from-1-0.md) playbooks.
* **Initialization**: Created the bundle (OKF v0.2) with database, config, env, api, services, proxmox and playbooks sections, generated from the source at the time.
* **Creation**: Documented [guest networking](/proxmox/networking.md) and the [SDN-only cluster playbook](/playbooks/sdn-only-cluster.md) alongside the fix for issue #126.
* **Creation**: Added the conformance and sync test described in [Maintaining this bundle](/playbooks/maintaining-this-bundle.md).
