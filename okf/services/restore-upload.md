---
type: Backend Service
title: Restore-upload service (restore a guest from an uploaded vzdump)
description: Restores a tenant-uploaded vzdump archive, written into the mounted backup share, as a brand-new quota-checked and isolated guest, then deletes the archive.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/restore-upload.service.ts
tags: [proxmate, backup, restore, migration]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: ru
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/restore-upload.service.ts
    title: backend/src/services/restore-upload.service.ts
---

# Purpose

The migration path between clusters / ProxMate instances: a tenant uploads an archive they previously downloaded and it becomes a new guest. The Proxmox API rejects `upload` with `content=backup`, so the file is streamed into the admin-mounted share (`BACKUP_DOWNLOAD_DIR`), where Proxmox's storage scan sees it, and the restore runs through the normal API. The mount must therefore be WRITABLE.[^ru]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `VZDUMP_UPLOAD_RE` | same regex as the download side | Valid archive basenames. |
| `TEMP_UPLOAD_RE` | `^\.proxmate-upload-[a-f0-9]{16}\.part$` | Temp name multer writes before validation/rename. |
| `uploadDir` | `() => string \| null` | `<BACKUP_DOWNLOAD_DIR>/dump` if it exists, else the dir. |
| `restoreUploadsEnabled` | `() => Promise<boolean>` | Dir configured and `W_OK`. |
| `resolveUnderUploadDir` | `(candidate, expect: RegExp) => string \| null` | Basename + regex + containment check; the only way a client-influenced string reaches the filesystem. |
| `parseBackupConfig` | `(text, kind?) => { cores, memoryMb, diskGb, guestName, unsizedDisk }` | Parses `vzdump/extractconfig` output up to the first `[snapshot]` section; QEMU vCPUs are sockets × cores (or `vcpus`), memory may be `current=N`; sums disk `size=` (excludes cdrom) and flags a disk with no size (the restore refuses it). A container with no `cores` is charged one core and pinned to it after the restore. |
| `restoreFromUpload` | `(user, { filename, name }) => VirtualMachine` | See steps below. |
| `RestoreUploadError` | class | User-facing failures. |

# Steps

1. Validate filename; infer `lxc`/`qemu` from the `vzdump-lxc-` prefix.[^ru]
2. Volid `<backup_storage>:backup/<filename>`; `getBackupNodes` must see it, else delete and fail ("check BACKUP_DOWNLOAD_DIR is mounted from that storage's directory").
3. Extract embedded config; `assertRestorableConfig` refuses (and drops) an archive that sets `hostpciN`, `usbN`, a `/dev/` serial/parallel port, `args`, `hookscript`, any `lxc.*` key, a container `devN` or host-path `rootfs`/`mpN`, or a container without `unprivileged: 1`; then `assertWithinQuota` for cores/memory/disk.
4. Require `default_storage`; `pickBestNode` among nodes that see the file, arch `amd64`; `getNextVmId`.
5. Create the `VirtualMachine` row (`status: 'creating'`), `restoreNewGuest` onto `default_storage` (unique=1, fresh MACs, containers always `unprivileged=1`), wait up to 30 min, tag the guest, then `syncRestoredGuest` with no approved PCI devices (re-reads the row's sizes from the restored guest).
6. Rename to chosen name, `applyDefaultBridge`, configure isolation before first boot if `isolation_enabled !== 'false'`.
7. Start, mark `running`, delete the archive.

# Data

Creates [VirtualMachine](/database/virtual-machine.md); reads [User](/database/user.md) quota. SystemConfig `backup_storage`, `default_storage` ([provisioning defaults](/config/provisioning-defaults.md)), `isolation_enabled` ([tenant isolation](/config/tenant-isolation.md)). Env `BACKUP_DOWNLOAD_DIR`.[^ru]

# Gotchas

- The archive is ALWAYS removed afterwards (Proxmox API delete first, then direct unlink); leaving it would clutter backup listings under the old foreign VMID. Any pre-restore failure (quota, placement, extract) also drops it.[^ru]
- The restored guest is tagged with the new row's marker (`markClonedGuest`). A failure after the row is created goes through `settleFailedCreate`: the row stays as `error` only when the guest was restored (or demonstrably ours); otherwise it is deleted.[^ru]
- ARM guest builds are not shipped, so uploaded backups are placed as x86 (`amd64`).[^ru]

# Relationships

- Called by the [vm router](/api/vm.md).
- Uses [download](/services/download.md) `backupDir`, [matestate](/services/matestate.md) `getBackupStorage`, [vm](/services/vm.md) `assertWithinQuota`, [proxmox service](/services/proxmox.md), [config](/services/config.md).
- Proxmox side: [storage](/proxmox/storage.md), [networking](/proxmox/networking.md).

[^ru]: backend/src/services/restore-upload.service.ts
