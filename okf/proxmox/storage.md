---
type: Proxmox Integration
title: Proxmox storage usage
description: How ProxMate discovers Proxmox storages by content type and uses them for VM disks, ISOs, LXC templates, cloud images, cloud-init snippets, vzdump backups and data disks.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/proxmox.service.ts
tags: [proxmate, proxmox, storage, iso, backup]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: pve
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/proxmox.service.ts
    title: backend/src/services/proxmox.service.ts
  - id: setup
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/setup.service.ts
    title: backend/src/services/setup.service.ts
  - id: vm
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/vm.service.ts
    title: backend/src/services/vm.service.ts
  - id: template
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/template.service.ts
    title: backend/src/services/template.service.ts
  - id: disk
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/disk.service.ts
    title: backend/src/services/disk.service.ts
  - id: matestate
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/matestate.service.ts
    title: backend/src/services/matestate.service.ts
  - id: restore
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/restore-upload.service.ts
    title: backend/src/services/restore-upload.service.ts
  - id: download
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/download.service.ts
    title: backend/src/services/download.service.ts
  - id: adminroutes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/admin.routes.ts
    title: backend/src/routes/admin.routes.ts
---

# Purpose

ProxMate never creates or deletes Proxmox storages; it discovers them, lets the admin pick
defaults, and reads/writes volumes on them. Endpoint list: [API surface](/proxmox/pve-api-surface.md).
Defaults live in SystemConfig ([provisioning-defaults](/config/provisioning-defaults.md),
[SystemConfig](/database/system-config.md)).

# Discovery

`GET /storage` (`getStorages`) returns `{storage, type, content}`. `getProxmoxResources()` splits it
by substring match on `content`:[^setup]

| Picker | Filter | Saved as SystemConfig key |
|---|---|---|
| Disk pool | `content` includes `images` | `default_storage` |
| ISO storage | `content` includes `iso` | `iso_storage` |
| Backup storage | `content` includes `backup` | `backup_storage` (optional; empty = auto-pick) |

`saveDefaults` also writes `default_bridge` (see [networking](/proxmox/networking.md)).[^setup]
`getBackupStorage()` returns `backup_storage` or, if unset, the first storage whose content includes
`backup`, and **caches that choice into `backup_storage`** on first use; it throws if none exists.[^matestate]

Per-node views used for placement and validation:[^pve]

- `getNodeImagesStorages(node)`: `GET /nodes/{node}/storage?enabled=1&content=images`, keeping
  `active !== 0`, returning `{storage, type, shared, availBytes}`.
- `storageAvailableOn(node, storage)`: true if that list contains the storage, **and also true** when
  the list is empty or the probe fails (fail-open so Proxmox is the judge).
- `getImportStorages(node)`: storages on the node whose `content` includes `import` and `active !== 0`.
- `getCloudInitExtras`/`cloudInitStatus` (template.service) scan `/storage` and per-node
  `content=snippets`.[^template]

# Schema

How each content type is used.

| Content type | Storage used | Read via | Written via | Notes |
|---|---|---|---|---|
| `images` | `default_storage` | `getVmConfig`, `getVolumeStorages`, `diskStorageOf` | `createVm` (`scsi0: <storage>:<GB>`), `createLxc` (`rootfs`), `cloneVm` (`storage=` on full clones), `attachDisk`, `resizeDisk`, `restoreNewGuest` (`storage=`) | Node-local pools pin guests to one node[^pve] |
| `iso` | `iso_storage` | `getIsos` (`content=iso` on every node, deduped by volid), `getIsoNodes` | none (no upload endpoint in ProxMate) | `ide2: <iso_storage>:iso/<name>,media=cdrom`; rescue ISO on `ide3`[^pve] |
| `vztmpl` | every storage advertising `vztmpl` | `listLxcTemplates`, `getTemplateNodes` | none (admins add via `pveam` / UI) | `ostemplate` is the full volid[^pve] |
| `import` | `iso_storage` if import-capable on the build node, else the first import storage | `getImportStorages` | `downloadUrlToStorage` (`POST .../download-url`, `content=import`, filename `<safe-name>-<ts>.qcow2`) | Deleted with `deleteStorageVolume` after the template is built, or on failure[^template] |
| `snippets` | `getSnippetStorage()` = `iso_storage` or `local`; or env `SNIPPET_STORAGE` | `nodesWithSnippet`, `getStoragePath` | On-demand file write to env `SNIPPET_DIR` (not via API); `ensureSnippetsEnabled` adds `snippets` to the storage's content | The API cannot create snippet files[^pve][^template] |
| `backup` | `backup_storage` | `listBackups`, `getBackupNodes`, `extractBackupConfig` | `startBackup` (`POST /nodes/{node}/vzdump`), `deleteBackup` | See below[^matestate] |
| cloud-init drive | `diskStorage` / clone target | `getCloudInitDrives` | `createCloudInitVm` (`ide2: <storage>:cloudinit`), `addCloudInitDrive` | Regenerable from config keys[^pve] |

# ISOs

There is no ISO upload or download in ProxMate. `GET /api/proxmox/isos` lists ISOs from
`iso_storage` across all nodes. Before creating an ISO VM, `getIsoNodes(iso_storage, iso)` finds the
online nodes whose content list holds `<iso_storage>:iso/<name>`; zero nodes aborts with "Upload it
there (or use a shared ISO storage)", and an admin-pinned node without the ISO is refused.[^vm]
`getPlacementDiagnostics` reports when the ISO or disk storage exists on only some online nodes
(e.g. node-local `local`), which silently pins every install to those nodes; it is served by
`GET /api/admin/placement-diagnostics`.[^pve][^adminroutes]

# Cloud images (download-url)

`buildCloudTemplateVm` (template.service): pick a node (`pickBestNode` with arch from the image URL),
require an import-capable storage on it, `downloadUrlToStorage` (wait up to 900 s), create the VM with
`scsi0: <default_storage>:0,import-from=<storage>:import/<file>` and a cloud-init drive, bake the guest
agent, convert to template, delete the import volume.[^template] See
[template service](/services/template.md) and [guest lifecycle](/proxmox/guest-lifecycle.md).

# Data disks

`disk.service.ts` manages extra disks on QEMU VMs (LXC is refused by the routes):[^disk]

- `parseDisks`: config keys matching `^(scsi|virtio|sata|ide)\d+$`, excluding `media=cdrom` and
  `cloudinit`; root is `findPrimaryDisk` (first such key that is not a cdrom).
- `addDataDisk`: next free slot on the **root disk's bus** (limits scsi 30, virtio 15, sata 5, ide 3),
  allocated on the **root disk's storage** (not `default_storage`), via `attachDisk`
  (`PUT config { scsiN: <storage>:<GB> }`).
- `resizeDataDisk`: grow-only; the root disk is resized through VM resize instead.
- `removeDataDisk`: `removeDisk` sets `delete=<slot>`, then deletes only the newly created `unusedN`
  entry (diffed before/after) so pre-existing unused volumes are untouched.
- `VirtualMachine.storage` tracks **total** GB (root + data); every increase (add or grow) is
  quota-checked against the owner's `maxStorage` (admins exempt); removal just frees the space. See [VirtualMachine](/database/virtual-machine.md).

# Backups (vzdump)

- `startBackup`: `mode` default `snapshot`, `compress=zstd`, `remove=0` (Proxmox retention never
  prunes; ProxMate prunes via `pruneOldMateStates`, keeping `vm.backupKeep`, or
  `MATESTATE_RETENTION` = 2 when unset).[^pve][^matestate]
- `createMateState` diffs `listBackups` before/after the task (30 min timeout) to find the new volid;
  rows live in [MateState](/database/mate-state.md).[^matestate]
- `listBackups`/`getBackupNodes` dedupe by volid because shared storage reports the same volid on
  every node.[^pve]
- Uploaded archives: a file placed in `BACKUP_DOWNLOAD_DIR` must be visible on `backup_storage` as
  `<storage>:backup/<filename>`; `getBackupNodes` returning nothing aborts with "Check that
  BACKUP_DOWNLOAD_DIR is mounted from that storage's directory". `extractBackupConfig` is read first
  to quota-check cores/memory/disk.[^restore][^download]

# Gotchas

- A linked clone cannot be placed on a different storage; ProxMate full-clones when the template's
  disk is not on `default_storage` (see [guest lifecycle](/proxmox/guest-lifecycle.md)).[^vm]
- `migratePreflight` adds a ProxMate guardrail: Proxmox ignores `cicustom` snippet storages, so a guest
  can migrate to a node lacking the snippet storage and then never start; such targets are blocked.[^pve]
- `getVolumeStorages` counts EFI/TPM and cloud-init volumes but skips `:iso/` cdroms and `none`.[^pve]
- `getClusterStats(diskPool)` sums node-local instances of the pool but counts a shared pool once.[^pve]
- LXC in-place restore passes the container's current rootfs storage (or `default_storage`) because
  the backup storage usually cannot hold a rootfs; QEMU restore passes none.[^matestate]

[^pve]: backend/src/services/proxmox.service.ts
[^setup]: backend/src/services/setup.service.ts
[^vm]: backend/src/services/vm.service.ts
[^template]: backend/src/services/template.service.ts
[^disk]: backend/src/services/disk.service.ts
[^matestate]: backend/src/services/matestate.service.ts
[^restore]: backend/src/services/restore-upload.service.ts
[^download]: backend/src/services/download.service.ts
[^adminroutes]: backend/src/routes/admin.routes.ts
