# Bundle Update Log

## 2026-10-23
* **Creation**: Documented the [activity-mail](/services/activity-mail.md) and [usage-digest](/services/usage-digest.md) services and the [usage digest setting](/config/usage-digest.md).
* **Update**: Added the ntfy and Telegram channels to [notifications](/config/notifications.md) and the [notify service](/services/notify.md); new [User](/database/user.md) email preferences, `USAGE_DIGEST_CRON`, and the share and deploy-for-tenant emails in the [VM](/api/vm.md), [template](/api/template.md), [auth](/api/auth.md) and [admin](/api/admin.md) APIs.

## 2026-10-20
* **Update**: Documented [pending shares](/database/pending-vm-share.md), template deploy placement, start/restart waiting for the Proxmox task, and the least-privilege token in [privileges](/proxmox/privileges.md), with what a live Proxmox VE 9.2 cluster proved.

## 2026-10-19
* **Update**: Refreshed the bundle against the 1.1.0 release: guest ownership tags and holds, stops that wait for the Proxmox task, migration preflight, session-only routes, single-use links and codes, compose override and updater changes; added the [unconfirmed machines](/playbooks/unconfirmed-machines.md) and [upgrading from 1.0.x](/playbooks/upgrading-from-1-0.md) playbooks.
* **Initialization**: Created the bundle (OKF v0.2) with database, config, env, api, services, proxmox and playbooks sections, generated from the source at the time.
* **Creation**: Documented [guest networking](/proxmox/networking.md) and the [SDN-only cluster playbook](/playbooks/sdn-only-cluster.md) alongside the fix for issue #126.
* **Creation**: Added the conformance and sync test described in [Maintaining this bundle](/playbooks/maintaining-this-bundle.md).
