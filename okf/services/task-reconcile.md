---
type: Backend Service
title: Task-reconcile service (interrupted operations)
description: Startup and 5-minute pass that settles rows a backend restart left `creating` or `restoring` from what Proxmox shows, never touching an operation that is still running and never deleting a guest or a backup.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/task-reconcile.service.ts
tags: [proxmate, reliability, scheduler, provisioning, backups]
generated: { by: okf-bootstrap/0.1, at: 2026-10-23T12:00:00Z }
sources:
  - id: svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/task-reconcile.service.ts
    title: backend/src/services/task-reconcile.service.ts
  - id: inflight
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/lib/in-flight.ts
    title: backend/src/lib/in-flight.ts
  - id: vm
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/vm.service.ts
    title: backend/src/services/vm.service.ts
  - id: sch
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/scheduler.service.ts
    title: backend/src/services/scheduler.service.ts
---

# Purpose

Creates, clones, duplicates, upload restores, rebuilds, MateState backups and in-place restores run inside the request (or tick) that started them. A restart mid-way loses that continuation: the VM row stays `creating` (or the MateState `creating`/`restoring`) and the live-status sync never touches `creating` rows. `reconcileStuckOperations` settles them; `reconcileTick` in the [scheduler](/services/scheduler.md) runs it every 5 minutes, and index.ts once at boot.[^svc] [^sch]

# What is never touched

A row is left for a later pass when any of these hold:[^svc] [^inflight]

- its operation is registered in flight in this process (`lib/in-flight.ts`: every create path registers the row id right after inserting it; rebuild, MateState restore and backup register for their whole run);
- it is younger than `RECONCILE_STUCK_MINUTES` (default 15), measured from `opStartedAt` (VM rows), `updatedAt` (restores) or `createdAt` (backups);
- its recorded Proxmox task (`opUpid` / `MateState.upid`) is still `running`, or the guest config at its VMID has a `lock`;
- the cluster-wide lookup (`syncVmNodeChecked`) or the guest config can't be read.

# Resolution

| Row | Proxmox shows | Result |
|---|---|---|
| `creating`, `opKind` `create`/`create-lxc`/`rebuild-iso` | task OK, guest carries this row's tag | Completed: isolation firewall applied (via `requireOurGuest`), row `stopped`; an ISO rebuild also clears its hold and old-disk state. Never started. |
| `creating`, rebuild | anything else | `settleFailedRebuild` (held when a guest of ours or backups exist; else the row is dropped; owner emailed). |
| `creating`, `restore-upload` | task OK | Held with `PROVISION_FAILED_MESSAGE`, guest left untagged: the volume/NIC/isolation checks never ran, so only admin adoption (which runs them) can clear it. |
| `creating`, no `opKind` (older row) with backups | anything | Held. |
| `creating`, any other | anything | `settleFailedCreate` with the recorded task: a finished clone is tagged and held; no guest → row dropped and admins notified, as a failed create is. |
| MateState `restoring` | not running | MateState back to `ready`; the VM's own guest stopped if running; row held with `RESTORE_FAILED_MESSAGE` unless it already has a hold. |
| MateState `creating` | task OK and its log names an archive listed for the VMID | Recorded `ready` with volid and size. |
| MateState `creating` | otherwise | `error`; nothing deleted; `backup.failed` notified. |

Holds notify admins with `vm.error` (through `markVmError` / the settle paths) and each resolution is audited as `vm.reconcile` or `matestate.reconcile`.[^svc] [^vm]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `reconcileStuckOperations` | `(now?) => ReconcileSummary` | One pass over `creating` VM rows and `creating`/`restoring` MateStates; a no-op without Proxmox calls when there are none. |
| `reconcileCreatingVm` / `reconcileRestoringMateState` / `reconcileCreatingMateState` | `(row, client, now?) => ReconcileOutcome` | Per-row settlement (exported for tests). |
| `upidNode` | `(upid) => string \| null` | The node a UPID names. |

# Gotchas

- Template clones can't be completed: the cloud-init credentials are never stored, so the reconciler holds them. Upload restores likewise, and their uploaded archive stays on the backup storage (nothing is deleted here).
- A held, untagged restore keeps whatever `onboot`/`protection` its archive had until an admin adopts or removes it: changing an untagged guest would break the rule that only `requireOurGuest`-checked guests are changed.
- A completed create is left `stopped` rather than started; the owner starts it.

# Relationships

- Called from [scheduler](/services/scheduler.md) and `backend/src/index.ts`; uses [vm service](/services/vm.md) (`settleFailedCreate`, `settleFailedRebuild`, `markVmError`, `requireOurGuest`, `holdErroredRow`), [notify](/services/notify.md), [audit](/services/audit.md), [proxmox](/services/proxmox.md).
- Data: [VirtualMachine](/database/virtual-machine.md) `opKind`/`opStartedAt`/`opUpid`, [MateState](/database/mate-state.md) `upid`.

[^svc]: backend/src/services/task-reconcile.service.ts
[^inflight]: backend/src/lib/in-flight.ts
[^vm]: backend/src/services/vm.service.ts
[^sch]: backend/src/services/scheduler.service.ts
