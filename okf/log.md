# Bundle Update Log

## 2026-10-19
* **Update**: Refreshed the bundle against the 1.1.0 release: guest ownership tags and holds, stops that wait for the Proxmox task, migration preflight, session-only routes, single-use links and codes, compose override and updater changes; added the [unconfirmed machines](/playbooks/unconfirmed-machines.md) and [upgrading from 1.0.x](/playbooks/upgrading-from-1-0.md) playbooks.
* **Initialization**: Created the bundle (OKF v0.2) with database, config, env, api, services, proxmox and playbooks sections, generated from the source at the time.
* **Creation**: Documented [guest networking](/proxmox/networking.md) and the [SDN-only cluster playbook](/playbooks/sdn-only-cluster.md) alongside the fix for issue #126.
* **Creation**: Added the conformance and sync test described in [Maintaining this bundle](/playbooks/maintaining-this-bundle.md).
