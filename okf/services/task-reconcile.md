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

Creates, clones, duplicates, upload restores, rebuilds, MateState backups and in-place restores run in this process: inside the request (or tick) that started them, or, for the ISO, LXC, template and upload-restore creates, in the background after the request has answered with the `creating` row. A restart mid-way loses that continuation: the VM row stays `creating` (or the MateState `creating`/`restoring`) and the live-status sync never touches `creating` rows. `reconcileStuckOperations` settles them; `reconcileTick` in the [scheduler](/services/scheduler.md) runs it every 5 minutes, and index.ts once at boot.[^svc] [^sch]

# What is never touched

A row is left for a later pass when any of these hold:[^svc] [^inflight]

- its operation is registered in flight in this process (`lib/in-flight.ts`: every create path registers the row id right after inserting it and keeps it registered until its background run settles; rebuild, [guest import](/services/guest-import.md), MateState restore and backup register for their whole run);
- it is younger than `RECONCILE_STUCK_MINUTES` (default 15), measured from `opStartedAt` (VM rows), `updatedAt` (restores) or `createdAt` (backups);
- its recorded Proxmox task (`opUpid` / `MateState.upid`) is still `running`, or can't be read right now (a failed status query is never taken as a failed task), or the guest config at its VMID has a `lock`. A lock that lasts over a day is reported to admins once;
- the cluster-wide lookup (`syncVmNodeChecked`) or the guest config can't be read.

The in-flight check is repeated right before every write, and every write is conditional (`updateMany`/`deleteMany` on id, `status: 'creating'` and the `opStartedAt` read), so a row deleted, retried or picked up meanwhile is left as it is.

# Claiming a guest

The rule: the reconciler never writes to a Proxmox guest without positive proof that the guest came from this row's own operation. When in doubt it holds the row, writes nothing to the guest, and notifies admins with the VMID and node. A guest is the row's when it carries the row's tag. A task that finished OK proves nothing about what is at the VMID now: it may have been deleted and the VMID given to another guest. Clones of one template look alike (they all inherit its tag), so every clone ProxMate makes (template deploy, bulk copy, duplicate, template rebuild) is created with the description `proxmate-row:<row id>` (`cloneNonce`). An untagged clone is tagged (then held) only when its description carries exactly that nonce, its task finished OK, no other row and no Template Store entry names the VMID, it carries no ProxMate tag but its source's (`opSourceId`), it isn't a template, and its name is the row's. ISO VM, LXC and ISO-rebuild creates tag the guest as they make it, so an untagged guest is never theirs. `nextVmId` skips VMIDs that rows still `creating` or held in `error` name, so a new create never lands behind such a row.

# Resolution

| Row | Proxmox shows | Result |
|---|---|---|
| `create`/`create-lxc`/`rebuild-iso` | task OK, guest carries this row's tag | Completed: isolation firewall applied, row `stopped` (never started); an ISO rebuild also clears its hold and old-disk state. |
| `import` | guest carries this row's tag | Completed: the tag is written last, after isolation, so only the final status write was missing. |
| `import` | guest not tagged | Row dropped; the guest stays importable and is never touched. |
| any | no guest at the VMID | Row dropped (quota freed, admins notified), unless it is a rebuild or an older row with backups, which is held. |
| any but import | guest carries this row's tag, part-way | Held with `PROVISION_FAILED_MESSAGE`; an upload restore (its tag is proof) also loses `onboot`/`startup`/`protection` and gets its NICs set `link_down=1`. |
| `clone`/`duplicate`/`rebuild-template` | untagged guest carrying the row nonce and passing the claim checks | Tagged as the row's and held, so a full clone is never orphaned. |
| `restore-upload` | guest at the VMID not tagged as the row's | Held; nothing is written to the guest (it may be anything after an outage); admins are told to check guest <vmid> on <node>, adopt it if it is the restore (it may still have `onboot` set) or delete it. |
| any | another machine's, build's or template's ProxMate tag | Nothing written to the guest; row dropped (held instead for a rebuild or older row with backups). |
| any | another row or a Template Store entry names the VMID, guest untagged | Held (never dropped, so a sibling's real guest is never orphaned); guest untouched; admins notified with the VMID. |
| any other | | Held, guest untouched, admins told which guest to check. |
| MateState `restoring` | not running | MateState back to `ready`; the VM's own guest stopped if running; row held with `RESTORE_FAILED_MESSAGE` unless it already has a hold. |
| MateState `creating` | task OK and its log names an archive listed for the VMID | Recorded `ready` with volid and size. |
| MateState `creating` | task failed, or none recorded and no backup lock | `error`; nothing deleted; `backup.failed` notified. |

An upload restore's archive (`opArchive`, recorded after the pool-mode rename, so it names the archive actually restored) is removed, with its upload marker, whenever its row is settled. The startup sweep of marked uploads (`sweepStaleUploads`) leaves alone any archive a `creating` row records as `opArchive` or whose VMID such a row names, so the two never race over a restore still being settled. Each settled row notifies admins once (`vm.error`; a rebuild also emails the owner) and is audited as `vm.reconcile` or `matestate.reconcile`.[^svc] [^vm]

# Late tasks whose follower was lost

When a create's task outlives its wait (`settleCreateTask`), the row is held in `error` (`PROVISION_FAILED_MESSAGE`) but keeps its op fields (`opKind`, `opUpid`, `opArchive`, `opStartedAt`) while a follower waits for the task, and counts as in flight. The follower clears them once it has settled the row (conditionally, only while they still name its task); a task Proxmox reports as failed (`TaskFailedError`) counts as settled. If the follower is lost (a restart, its 6 h limit, a poll error), the pass picks up held rows of a followed kind (`clone`, `duplicate`, `restore-upload`) that still carry a task (`reconcileFollowedRow`):

- task still running: following resumes. The row stays in flight until the resumed follower has settled it, so the periodic pass never settles it at the same time. If the resumed wait gives up (6 h) or its poll fails, the row is left to the next pass, which looks again; a task still running after a day is reported to admins once;
- task can't be read: left for the next pass; after a day an admin is told once (as for a guest whose Proxmox lock doesn't clear). The day counts from when this process first saw the row waiting for that reason (kept in memory, so a restart starts the count again);
- Proxmox no longer knows the task (`no such task`): held, nothing written to the guest, admins told, op fields cleared;
- task failed: the archive is removed; the row is dropped when no guest is at the VMID, otherwise held with the guest untouched;
- task finished OK, upload restore: a finished task proves what was at the VMID then, not now. The guest is only treated as the restore's when every node's task list shows nothing else happened at that VMID since (see [Proof from task lists](#proof-from-task-lists)), no other record or template names the VMID, and it isn't a template. Then it gets the late-task step: `onboot`/`startup`/`protection` removed, then the post-restore check, which removes it when it fails (the row is then dropped). A guest that passes stays untagged and the row held; admins are told to adopt it. When any of that can't be shown (a node's task list unreadable included), the row is held, nothing is written to the guest, and admins get the VMID and node;
- task finished OK, clone: tagged only on its row nonce; the row stays held.

The op fields are cleared once the row is settled, so a row never loops. Adopting a machine or lifting its quota hold clears them too. Adopt is refused (409) while something else holds the row in flight; otherwise the adopt itself holds the row in flight from start to finish, so no create, restore, follower or reconciler pass starts on it (or settles it) half-way through. The reconciler likewise holds each `creating` or followed row in flight while a pass settles it (a resumed follower already holds it), so an adopt started meanwhile gets the 409.

# Proof from task lists

The proof that nothing else used a VMID since an upload restore started (`untouchedSince`) holds only when all of these are shown:

- the token has `Sys.Audit` on every `/nodes/<node>`, read per node from `/access/permissions?path=/nodes/<node>` (Proxmox's answer for exactly that path, so an inherited grant counts and a NoAccess or non-propagating grant above it doesn't). Without it Proxmox silently lists only the token's own tasks, so a missing privilege, or an answer that can't be read, is no proof. **Without `Sys.Audit` on the nodes the reconciler always holds a finished late upload restore** (nothing written to the guest, admins told) and an admin adopts or removes it by hand;
- every node's task log reaches back to the restore's start: the restore's own node by listing the restore's own task, every other node by holding at least one task (any VMID) that started at or before 60 s before it (`/nodes/<node>/tasks?source=all&until=&limit=1`). A freshly rebuilt or reinstalled node, a node that joined later, or an idle node whose log holds nothing that old therefore causes a hold;
- every node's list (`/nodes/<node>/tasks?vmid=&since=&source=all`) is read in full, page by page (`start`/`limit`, 500 per page). A node whose list can't be read, a list longer than 20 pages, or one whose reported `total` changes between pages, is no proof;
- the lists are read from 60 s before the restore's start, to allow for clock differences between nodes;
- every other task at the VMID is of a type known to leave the guest in place (`qmstart`, `qmstop`, `qmshutdown`, `qmreboot`, `qmsuspend`, `qmresume`, `qmsnapshot`, `qmconfig`, the `vz*` equivalents, console proxies and `vzdump`). Any other type, a known one (create, restore, clone, destroy, migrate) or one not known here, counts against it.

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
