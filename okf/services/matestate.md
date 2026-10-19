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
| `createMateState` | `(vm, kind = 'manual' \| 'scheduled')` | Placeholder row `creating` (volid `pending:...`), `startBackup` mode `snapshot`, waits up to 30 min, diffs the backup list to find the new volid, marks `ready`, prunes with `vm.backupKeep ?? 2`. On error → `status: 'error'`. |
| `restoreFromMateState` | `(vm, ms)` | Stops guest (waits up to 30 s), marks `restoring`, restore-in-place into the same VMID (LXC targets current rootfs pool or `default_storage`), re-applies NIC firewall if isolation on, starts guest. |
| `deleteMateState` | `(ms)` | Deletes the Proxmox file (ignores "not exist/not found") and the row. |
| `runScheduledBackups` | `() => { ran, failed }` | Weekly: all VMs not `creating` with `backupCron: null`. |
| `isBackupDue` / `runDueBackups` | `(vm, now)` / `(now)` | Per-minute: VMs whose own `backupCron` matches this minute. |
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
- Restore is in place into the SAME VMID so identity, NIC and isolation stay intact; a restore error resets the row to `ready` and rethrows.[^ms]
- Backups run sequentially; one VM's failure is isolated and fires `notify({ event: 'backup.failed' })`.[^ms]
- `size` is BigInt in the DB; returning a raw row via `res.json` throws, which is why `serializeMateState` exists.[^ms]

# Relationships

- Called by the [scheduler](/services/scheduler.md), the [vm router](/api/vm.md), and [restore-upload](/services/restore-upload.md) (`getBackupStorage`).
- Uses [proxmox service](/services/proxmox.md), [power-schedule](/services/power-schedule.md) `cronMatches`, [notify](/services/notify.md), [config](/services/config.md).
- Downloads: [download service](/services/download.md). Proxmox side: [storage](/proxmox/storage.md), [guest lifecycle](/proxmox/guest-lifecycle.md).

[^ms]: backend/src/services/matestate.service.ts
[^scheduler]: backend/src/services/scheduler.service.ts
