---
type: Backend Service
title: MateState service (VM backups)
description: Creates, prunes, restores and deletes MateState vzdump backups of guests, runs the weekly cluster-wide backup and the per-minute per-VM backup schedules.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/matestate.service.ts
tags: [proxmate, backup, vzdump, scheduler]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: ms
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/matestate.service.ts
    title: backend/src/services/matestate.service.ts
  - id: scheduler
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/scheduler.service.ts
    title: backend/src/services/scheduler.service.ts
---

# Purpose

A MateState is ProxMate's name for a Proxmox vzdump backup of a tenant guest, tracked in the DB with rolling retention.[^ms]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `MATESTATE_RETENTION` | `2` | Default number of `ready` MateStates kept per VM. |
| `getBackupStorage` | `() => Promise<string>` | SystemConfig `backup_storage`, else first Proxmox storage whose content includes `backup` (then cached into config); throws if none. |
| `listForVm` | `(vmId)` | Newest first. |
| `serializeMateState` | `(ms)` | Converts BigInt `size` to Number for JSON. |
| `pruneOldMateStates` | `(vmId, keep = 2)` | Deletes older `ready` rows and their Proxmox files (file-delete errors only logged). |
| `createMateState` | `(vm, kind = 'manual' \| 'scheduled')` | Refused unless the guest is the row's own (`requireOurGuest`). Placeholder row `creating` (volid `pending:...`), `startBackup` mode `snapshot`, waits up to 30 min, records the volid the vzdump task's own log names (a lone new volume only when the log names none; otherwise it refuses to guess), marks `ready`, prunes with `vm.backupKeep ?? 2`. On error → `status: 'error'`; when the wait timed out, the vzdump task is stopped and the archive its log names is deleted (nothing unrecorded is left on the backup storage). |
| `restoreFromMateState` | `(vm, ms)` | Refuses an archive whose config would grow the guest past the owner's quota (`assertRestoreWithinQuota`), refuses with a clear message when the archive is not on the node the guest is on now (node-local backup storage after a move), stops guest (waits up to 30 s), marks `restoring`, restore-in-place into the same VMID (LXC targets current rootfs pool or `default_storage`), re-syncs the row from the restored config (`syncRestoredGuest`), then re-applies the current placement and isolation before starting the guest: `applyDefaultBridge`, and unless `isolation_enabled` is `false` `configureVmIsolation(readIsolationOptions())`, `ensureNicFirewall` and (while `ideState` is `ready` and `ide_ingress_cidr` is set) the IDE pinhole. A failure there leaves the guest stopped. |
| `rollbackToSnapshot` | `(vm, snapname)` | Snapshot rollback for the vm router: refuses a snapshot config over the owner's quota, rolls back, re-tags, then `syncRestoredGuest` and the same placement/isolation re-apply as a MateState restore. |
| `deleteMateState` | `(ms)` | Deletes the Proxmox file (ignores "not exist/not found") and the row. |
| `runScheduledBackups` | `() => { ran, failed }` | Weekly: all VMs not `creating` with `backupCron: null`. |
| `isBackupDue` / `isBackupDueSince` / `runDueBackups` | `(vm, now)` / `(vm, now, since?)` / `(now, since?)` | Per-minute: VMs whose own `backupCron` fired at any minute after `since` up to `now` (just `now`'s minute without `since`; at most 24 h back), each once. |
| `setBackupPolicy` | `(vm, { backupCron, backupKeep })` | Sets/clears the per-VM policy. |

# Data

- [MateState](/database/mate-state.md): `vmId, proxmoxVmId, proxmoxNode, storage, volid, size (BigInt), status (creating/ready/error/restoring), kind`.[^ms]
- [VirtualMachine](/database/virtual-machine.md): `backupCron`, `backupKeep`, `status`, `type`.
- SystemConfig `backup_storage`, `default_storage` ([provisioning defaults](/config/provisioning-defaults.md)), `isolation_enabled` ([tenant isolation](/config/tenant-isolation.md)), `matestate_last_run` (written by the scheduler).

# Scheduling

| Job | Schedule | Lock |
|---|---|---|
| Weekly cluster backup (`runScheduledBackups`) | env `MATESTATE_CRON`, default `0 3 * * 0` (Sun 03:00); invalid value falls back with a warning | `running` |
| Missed-window catch-up | once, 10 s after boot, compares `matestate_last_run` with the previous cron occurrence | same |
| Per-VM backups (`runDueBackups`) | `* * * * *` | `backupRunning` (separate from power actions) |

On first boot the catch-up adopts the last window as satisfied instead of backing everything up.[^scheduler]

# Gotchas

- VMs with their own `backupCron` are excluded from the weekly run so they are never double-backed-up.[^ms]
- Restore is in place into the SAME VMID so identity, NIC and isolation stay intact; it is refused when that VMID holds a guest that is not the row's (an empty VMID is allowed), and the restored guest is re-tagged as the row's (`markClonedGuest`). A restore error resets the row to `ready` and rethrows.[^ms]
- The archive brings back the backup-time config (cores, memory, disks, PCI devices). Afterwards the row's `cpu`/`ram`/`storage`/`hasPassthrough` are re-read from the guest under the owner's quota lock; `hostpciN` lines that were not attached (and approved) right before the restore are removed before the guest starts; CPU/RAM that no longer fit the quota are set back to the row's size.[^ms]
- Backups run sequentially; one VM's failure is isolated and fires `notify({ event: 'backup.failed' })`.[^ms]
- `size` is BigInt in the DB; returning a raw row via `res.json` throws, which is why `serializeMateState` exists.[^ms]

# Relationships

- Called by the [scheduler](/services/scheduler.md), the [vm router](/api/vm.md), and [restore-upload](/services/restore-upload.md) (`getBackupStorage`).
- Uses [proxmox service](/services/proxmox.md), [power-schedule](/services/power-schedule.md) `cronMatches`, [notify](/services/notify.md), [config](/services/config.md).
- Downloads: [download service](/services/download.md). Proxmox side: [storage](/proxmox/storage.md), [guest lifecycle](/proxmox/guest-lifecycle.md).

[^ms]: backend/src/services/matestate.service.ts
[^scheduler]: backend/src/services/scheduler.service.ts
