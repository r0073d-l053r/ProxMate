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

- its operation is registered in flight in this process (`lib/in-flight.ts`: every create path registers the row id right after inserting it; a [bulk deploy](/services/bulk-deploy.md) registers every reserved copy at reservation, so a copy still queued for its turn is never touched; rebuild, [guest import](/services/guest-import.md), MateState restore and backup register for their whole run);
- it is younger than `RECONCILE_STUCK_MINUTES` (default 15), measured from `opStartedAt` (VM rows), `updatedAt` (restores) or `createdAt` (backups);
- its recorded Proxmox task (`opUpid` / `MateState.upid`) is still `running`, or can't be read right now (a failed status query is never taken as a failed task), or the guest config at its VMID has a `lock`. A lock that lasts over a day is reported to admins once;
- the cluster-wide lookup (`syncVmNodeChecked`) or the guest config can't be read.

The in-flight check is repeated right before every write, and every write is conditional (`updateMany`/`deleteMany` on id, `status: 'creating'` and the `opStartedAt` read), so a row deleted, retried or picked up meanwhile is left as it is.

# Claiming a guest

A guest is the row's only when it carries the row's tag. A task that finished OK proves nothing about what is at the VMID now: it may have been deleted and the VMID given to someone else's guest. So the reconciler tags an untagged guest only for a clone, duplicate or template rebuild whose task finished OK, and only when no other row references the VMID, the guest carries no ProxMate tag except its source's (`opSourceId`: the template's, or a duplicate's source machine's), it isn't a template, and its name is the row's. ISO VM, LXC and ISO-rebuild creates tag the guest as they make it, so an untagged guest is never theirs.

# Resolution

| Row | Proxmox shows | Result |
|---|---|---|
| `create`/`create-lxc`/`rebuild-iso` | task OK, guest carries this row's tag | Completed: isolation firewall applied, row `stopped` (never started); an ISO rebuild also clears its hold and old-disk state. |
| `import` | guest carries this row's tag | Completed: the tag is written last, after isolation, so only the final status write was missing. |
| `import` | guest not tagged | Row dropped; the guest stays importable and is never touched. |
| any | no guest at the VMID | Row dropped (quota freed, admins notified), unless it is a rebuild or an older row with backups, which is held. A bulk-deploy copy that never got its turn ends here. |
| any but import | guest carries this row's tag, part-way | Held with `PROVISION_FAILED_MESSAGE`; an upload restore is also kept from booting (below). |
| `clone`/`duplicate`/`rebuild-template` | untagged guest passing the claim checks | Tagged as the row's and held, so a full clone is never orphaned. |
| `restore-upload` | task OK, no other row has the VMID | Held untagged (admin adoption runs the checks), `onboot`/`startup`/`protection` removed and NICs set `link_down=1`. |
| any | another machine's tag, or another row has the VMID | Nothing written to the guest; row dropped (held instead for a rebuild or older row with backups). |
| any other | | Held, guest untouched. |
| MateState `restoring` | not running | MateState back to `ready`; the VM's own guest stopped if running; row held with `RESTORE_FAILED_MESSAGE` unless it already has a hold. |
| MateState `creating` | task OK and its log names an archive listed for the VMID | Recorded `ready` with volid and size. |
| MateState `creating` | task failed, or none recorded and no backup lock | `error`; nothing deleted; `backup.failed` notified. |

An upload restore's archive (`opArchive`) is removed whenever its row is settled. Each settled row notifies admins once (`vm.error`; a rebuild also emails the owner) and is audited as `vm.reconcile` or `matestate.reconcile`.[^svc] [^vm]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `reconcileStuckOperations` | `(now?) => ReconcileSummary` | One pass over `creating` VM rows and `creating`/`restoring` MateStates; a no-op without Proxmox calls when there are none. |
| `reconcileCreatingVm` / `reconcileRestoringMateState` / `reconcileCreatingMateState` | `(row, client, now?) => ReconcileOutcome` | Per-row settlement (exported for tests). |
| `upidNode` | `(upid) => string \| null` | The node a UPID names. |

# Gotchas

- Template clones can't be completed: the cloud-init credentials are never stored, so the reconciler holds them. Upload restores likewise.
- `requireOurGuest` refuses rows in `creating`; the reconciler alone passes `settlingInterrupted`, so rebuild, restore and every other action stay refused on such rows.
- The in-flight registry is per process; the backend logs a warning at start that it assumes it is the only backend on its database.
- A completed create is left `stopped` rather than started; the owner starts it.
- Privileges: the reconciler needs nothing beyond the role's existing privileges (task status and logs, guest config/status, stop, firewall, snapshots, backup listing), all covered by the `--pool` ACL split of `deploy/proxmox-token.sh`. Under a pool-scoped token Proxmox answers 403 for any VMID outside the pool, an empty one included; the reconciler then asks `/cluster/nextid?vmid=` (open to every user) and treats the VMID as empty only when Proxmox would hand it out next. A VMID held by a guest the token can't see is left alone.

# Relationships

- Called from [scheduler](/services/scheduler.md) and `backend/src/index.ts`; uses [vm service](/services/vm.md) (`settleFailedCreate`, `settleFailedRebuild`, `markVmError`, `requireOurGuest`, `holdErroredRow`), [notify](/services/notify.md), [audit](/services/audit.md), [proxmox](/services/proxmox.md).
- Data: [VirtualMachine](/database/virtual-machine.md) `opKind`/`opStartedAt`/`opUpid`, [MateState](/database/mate-state.md) `upid`.

[^svc]: backend/src/services/task-reconcile.service.ts
[^inflight]: backend/src/lib/in-flight.ts
[^vm]: backend/src/services/vm.service.ts
[^sch]: backend/src/services/scheduler.service.ts
