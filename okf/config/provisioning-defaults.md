---
type: Configuration Group
title: Provisioning defaults
description: SystemConfig keys choosing the disk pool, network, ISO/snippet storage, backup storage and rescue ISO that guest creation, cloning, restores and rescue boot use.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/setup.service.ts
tags: [proxmate, config, storage, networking, provisioning]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T20:00:00Z }
sources:
  - id: setup-svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/setup.service.ts
    title: backend/src/services/setup.service.ts
  - id: setup-routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/setup.routes.ts
    title: backend/src/routes/setup.routes.ts
  - id: admin-routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/admin.routes.ts
    title: backend/src/routes/admin.routes.ts
  - id: vm-svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/vm.service.ts
    title: backend/src/services/vm.service.ts
  - id: pve
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/proxmox.service.ts
    title: backend/src/services/proxmox.service.ts
  - id: matestate
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/matestate.service.ts
    title: backend/src/services/matestate.service.ts
  - id: template-svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/template.service.ts
    title: backend/src/services/template.service.ts
  - id: vm-routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/vm.routes.ts
    title: backend/src/routes/vm.routes.ts
---

# Purpose

Cluster-wide defaults that decide where new guests are placed and stored. The setup wizard (step 3) writes them first, and admins change them later under Admin → Settings. All values are Proxmox identifiers (storage ids, a network name, a volid) stored as plain text, never encrypted.[^setup-svc] See [storage](/proxmox/storage.md) and [networking](/proxmox/networking.md).

# Schema

| Key | Value format | Default / when unset | Written by | Read by | Description |
|---|---|---|---|---|---|
| `default_storage` | Proxmox storage id (zod `min(1)`). The wizard offers only storages whose `content` includes `images` | Unset: `createVm`, `createContainer`, ISO rebuilds, cloud-template builds and restore-from-upload throw `Server defaults are not configured — finish setup first`. Template-clone planning and duplicates pass no storage (`undefined`), so the clone stays on the source's storage; an LXC MateState restore uses the container's current rootfs pool; passthrough apply picks the compatible storage with the most free space | `POST /api/setup/defaults`, `PUT /api/admin/settings/defaults` (both via `saveDefaults`) | `vm.service` (createVm, createContainer, rebuildVm, template clone planning, duplicate, storage-pinning report), `template.service.buildCloudTemplateVm`, `matestate.service` (LXC restore fallback), `restore-upload.service`, `passthrough-request.service`, `GET /api/admin/cluster-stats` (disk-pool capacity), `GET /api/admin/placement-diagnostics` | Disk pool for new guest disks. A clone only uses it when the template's node can see that pool (`storageAvailableOn`); otherwise it logs a warning and lets Proxmox choose.[^vm-svc] |
| `default_bridge` | Network name (zod: trimmed, `NETWORK_NAME_RE` = letter first, then letters, digits, `.`, `_`, `-`, max 32), e.g. `vmbr0` | Unset: `createVm`, `createContainer`, ISO rebuilds and cloud-template builds throw as above. `applyDefaultBridge` returns without changes. `suggestMgmtCidr` returns null | same as `default_storage` | `vm.service`, `template.service.buildCloudTemplateVm`, `proxmox.service.applyDefaultBridge`, `admin.routes suggestMgmtCidr` (isolation page) | The default network (Linux bridge, OVS bridge or SDN VNet) that guest NICs are attached to. `applyDefaultBridge` **overrides** whatever bridge a source guest had, on duplicates, restore-from-upload and template deploys (`configureClonedVm`), so copies stay inside the isolation segment.[^pve] See [networking](/proxmox/networking.md). |
| `iso_storage` | Proxmox storage id (zod `min(1)`). The wizard offers only storages whose `content` includes `iso` | Unset: `createVm` throws. `getIsos()` throws `No ISO storage configured`. Snippet storage falls back to `'local'`. Template import falls back to the node's first import-capable storage | same as `default_storage` | `vm.service.createVm` (ISO node constraint), cloud-init snippet lookup, `proxmox.service.getIsos`, `template.service` (`getSnippetStorage`, import storage preference), `GET /api/admin/placement-diagnostics` | Storage holding install ISOs. It also serves as the **cloud-init snippet storage** (`<iso_storage>:snippets/<file>`). Placement is limited to nodes that physically hold the requested ISO.[^vm-svc][^template-svc] |
| `backup_storage` | Proxmox storage id, or `''` | Unset or empty: `getBackupStorage()` picks the first storage whose `content` includes `backup` and **writes that choice back** to this key. If none exists it throws | `PUT /api/admin/settings/defaults` (optional field; `''` clears the override). Also `matestate.getBackupStorage` (auto-cache). **Not** the wizard: its zod schema has no `backupStorage`, so the field is stripped | `matestate.service.getBackupStorage` (MateState backups, restore-from-upload), `GET /api/admin/settings` | Storage that vzdump MateState backups are written to.[^matestate] |
| `rescue_iso` | ISO volid string (zod `max(300)`; the route trims it before saving), or `''` | Unset or empty: rescue is unavailable. `enterRescue` throws `No rescue ISO is configured`, and `GET /api/vms/:id` reports `rescueAvailable: false` | `PUT /api/admin/settings/rescue` (`{ iso }`; empty clears it) | `vm.service.enterRescue` (`POST /api/vms/:id/rescue`), `GET /api/vms/:id` (`rescueAvailable`, always false for LXC), `GET /api/admin/settings` (`rescueIso`) | ISO attached when a VM is booted into rescue mode. QEMU only.[^vm-routes] |

# Validation

- Wizard `DefaultsSchema`: `{ storage, bridge, isoStorage }`; `storage` and `isoStorage` are `z.string().min(1)`, `bridge` is trimmed and must match `NETWORK_NAME_RE`.[^setup-routes]
- Admin `DefaultsSchema`: the same plus `backupStorage: z.string().optional()`.[^admin-routes]
- Neither route checks that the named storage or network exists (the bridge regex is a format check only). The values come from the pickers that `GET /api/setup/proxmox/resources` fills (`getProxmoxResources`).[^setup-svc]

# Invariants

- `PUT /api/admin/settings/defaults` records an `admin.settings_defaults` audit entry with a `from → to` diff for each changed key. `PUT /settings/rescue` records `admin.rescue_config` with the ISO (or `rescue ISO cleared`).[^admin-routes]
- Changing `default_storage` or `default_bridge` affects only future operations. Existing guests keep their disks and NICs, apart from the bridge rewrite on later duplicate, restore and deploy runs.

# Relationships

- [setup API](/api/setup.md), [admin API](/api/admin.md), [VM API](/api/vm.md)
- [Tenant isolation](/config/tenant-isolation.md): the VLAN tag is applied on top of the default network.
- [Cloud-init](/config/cloud-init.md): uses `iso_storage` as the snippet storage.
- [MateState](/database/mate-state.md) backups use `backup_storage`.

[^setup-svc]: backend/src/services/setup.service.ts (`getProxmoxResources`, `saveDefaults`)
[^setup-routes]: backend/src/routes/setup.routes.ts (`POST /defaults`)
[^admin-routes]: backend/src/routes/admin.routes.ts (`PUT /settings/defaults`, `PUT /settings/rescue`, `suggestMgmtCidr`)
[^vm-svc]: backend/src/services/vm.service.ts (`createVm`, `planTemplateClone`, `enterRescue`)
[^pve]: backend/src/services/proxmox.service.ts (`applyDefaultBridge`, `getIsos`)
[^matestate]: backend/src/services/matestate.service.ts (`getBackupStorage`)
[^template-svc]: backend/src/services/template.service.ts (`buildCloudTemplateVm`, `getSnippetStorage`)
[^vm-routes]: backend/src/routes/vm.routes.ts (`rescueAvailable`)
