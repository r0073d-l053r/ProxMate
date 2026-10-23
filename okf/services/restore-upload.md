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
3. Extract embedded config; `assertRestorableConfig` refuses (and drops) an archive with any key outside the allowlist (see below), a disk that is not a storage volume (host path, `import-from`), a serial port other than `socket`, `numa` other than 0/1, `template: 1`, container `features` beyond `nesting`, or a container without `unprivileged: 1`; then `assertWithinQuota` for cores/memory/disk.
4. Require `default_storage`; `pickBestNode` among nodes that see the file, arch `amd64`; `getNextVmId`.
5. Create the `VirtualMachine` row (`status: 'creating'`), `restoreNewGuest` onto `default_storage` (unique=1, fresh MACs, containers always `unprivileged=1`), wait up to 30 min, tag the guest, remove `onboot`/`startup`/`protection`, check that it references only its own volumes (`assertOwnVolumes`, which also refuses any volume `listGuestVolumes` found for the new VMID on the node's active storages before the restore — leftovers of an earlier guest with that VMID), then `syncRestoredGuest` with no approved PCI devices (re-reads the row's sizes from the restored guest).
6. Rename to chosen name, rebuild every `netN` from scratch (QEMU: the archive's NIC model if it is virtio/e1000/e1000e/rtl8139/vmxnet3, else virtio; LXC: its interface name, `ip=dhcp`; then no MAC so Proxmox generates a fresh one, `bridge=<default_bridge>`, `firewall=1`, `tag=<isolation_vlan_tag>` when isolation is on and a tag is set) and remove `onboot`/`startup`/`protection` (and a `cicustom` naming snippets ProxMate didn't write), capping a container's `swap` at 512 MB (ProxMate's own default — swap is not quota-counted), configure isolation if `isolation_enabled !== 'false'` — all before `syncRestoredGuest` and the first boot. Any failure once the restore landed leaves the row `error`; a restore task still running when the wait gave up keeps the archive, which its follower removes when the task ends.
7. Start, mark `running`, delete the archive.

# Archive config allowlist

- Both kinds: `name`, `hostname`, `description`, `tags`, `ostype`, `arch`, `cores`, `memory`, `cpulimit`, `cpuunits`, `onboot`, `startup`, `protection` (the last three are stripped after the restore), `template` (only `0`), `digest`, `parent`, `nameserver`, `searchdomain`.
- QEMU: `agent`, `acpi`, `balloon`, `shares`, `bios`, `boot`, `bootdisk`, `cpu`, `hotplug`, `kvm`, `localtime`, `machine`, `numa` (0/1), `scsihw`, `smbios1`, `sockets`, `vcpus`, `tablet`, `vga`, `vmgenid`, `keyboard`, `meta`, `citype`, `ciuser`, `cipassword`, `ciupgrade`, `sshkeys`, `cicustom` (kept only when every part is `vendor=`/`user=` `<SNIPPET_STORAGE>:snippets/proxmate-<features>.yaml`, the snippets ProxMate writes — `ownCicustom`; otherwise stripped after the restore), `ideN`/`sataN`/`scsiN`/`virtioN`, `efidisk0`, `tpmstate0`, `netN`, `ipconfigN`, `serialN` (`socket` only), `unusedN`.
- LXC: `swap`, `unprivileged` (must be 1), `features` (`nesting` only), `timezone`, `console`, `tty`, `cmode`, `rootfs`, `mpN`, `netN`, `unusedN`.
- Everything else is refused — e.g. `hostpciN`, `usbN`, `parallelN`, `virtiofsN`, `args`, `hookscript`, `numaN`, `affinity`, `rngN`, `devN`, `lxc.*`.[^ru]

# Data

Creates [VirtualMachine](/database/virtual-machine.md); reads [User](/database/user.md) quota. SystemConfig `backup_storage`, `default_storage` ([provisioning defaults](/config/provisioning-defaults.md)), `isolation_enabled` ([tenant isolation](/config/tenant-isolation.md)). Env `BACKUP_DOWNLOAD_DIR`.[^ru]

# Gotchas

- With a Proxmox pool configured (`proxmox_pool`), the new VMID is reserved first (`reserveVmIds`, released on every exit) and the archive is hard-linked on the share to `vzdump-<kind>-<new vmid>-…` (`renameArchiveForVmid`; `link` fails rather than replace a file) before Proxmox sees it: Proxmox treats a backup as owned by the VMID in its name, and a pool-scoped token has no `VM.Backup` on the old one. Proxmox is not asked whether the archive is there or what config it carries (that would need `Datastore.Allocate` on the backup storage): the file is checked on the share, the nodes come from where the shared backup storage is available (`pve.storagePlacement`; a non-shared storage on several nodes is refused), and the config is read from the archive itself (`lib/vzdump-archive.ts`). Every `unusedN` on the restored guest is then treated as foreign (`assertOwnVolumes` `unusedAreForeign`), because the pre-restore volume listing cannot see volumes of a VMID outside the pool. See [Proxmox privileges](/proxmox/privileges.md).
- Uploads are promoted from their temp name with `promoteUpload` (hard link, then unlink: an existing file is never replaced) and carry a `.proxmate-uploaded.<name>` marker; once the restore picks its VMID, the marker records it. `sweepStaleUploads` (run at startup) removes marked archives and stalled `.proxmate-upload-*.part` files older than six hours unless a `creating` row records the archive as its `opArchive` or has the VMID the marker records (the [restart reconciler](/services/task-reconcile.md) removes such an archive when it settles the row).
- The archive pre-check (`assertRestorableConfig`: every section, `[PENDING]` refused, a disk's volume read from `file=`/`volume=` or the bare first item, unreadable lines refused) is an early estimate only. After the restore task, `assertRestoredGuestConfig` checks the guest as Proxmox holds it — config, pending changes, snapshots (refused for a fresh restore; each one's config checked with `allowSnapshots`) — with the same allowlist, and lists every problem. On any failure, including a read failure, `neutraliseRestoredGuest` drops `protection`/`onboot`/`startup` and deletes the guest (the finished task at our VMID is the only thing that can have created it); if the delete is refused it removes each refused key and pending change it can and sets `link_down=1` on every NIC, and the row is held. The late-task follower does the same before tagging. In-place MateState restores of containers run the check with snapshots allowed and are neutralised without the delete, then held. `pve.resetRestoredFirewall` clears the archive's guest firewall (rules, IP sets, aliases) before isolation. The vm service's adopt runs the same check before tagging a guest or lifting a hold.
- The archive is ALWAYS removed afterwards (Proxmox API delete first, then direct unlink); leaving it would clutter backup listings under the old foreign VMID. Any pre-restore failure (quota, placement, extract) also drops it.[^ru]
- The restored guest is tagged with the new row's marker (`markClonedGuest`). A failure after the row is created goes through `settleFailedCreate`: the row stays as `error` when the guest was restored, the restore task finishes later (it is then tagged), or the VMID holds a guest with no other machine's tag; otherwise it is deleted.[^ru]
- ARM guest builds are not shipped, so uploaded backups are placed as x86 (`amd64`).[^ru]

# Relationships

- Called by the [vm router](/api/vm.md).
- Uses [download](/services/download.md) `backupDir`, [matestate](/services/matestate.md) `getBackupStorage`, [vm](/services/vm.md) `assertWithinQuota`, [proxmox service](/services/proxmox.md), [config](/services/config.md).
- Proxmox side: [storage](/proxmox/storage.md), [networking](/proxmox/networking.md).

[^ru]: backend/src/services/restore-upload.service.ts
