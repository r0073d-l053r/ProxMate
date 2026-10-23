---
type: Backend Service
title: Auto-snapshot service (snapshot before risky changes)
description: Takes a `pm-auto-<op>-<timestamp>` Proxmox snapshot of a VM before a resize, data-disk grow or rescue boot, refuses the change when it can't, and keeps only the newest N automatic snapshots per VM without ever deleting a user's.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/auto-snapshot.service.ts
tags: [proxmate, snapshots, vm, reliability]
generated: { by: okf-bootstrap/0.1, at: 2026-10-23T12:00:00Z }
sources:
  - id: svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/auto-snapshot.service.ts
    title: backend/src/services/auto-snapshot.service.ts
  - id: vm
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/vm.service.ts
    title: backend/src/services/vm.service.ts
  - id: disk
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/disk.service.ts
    title: backend/src/services/disk.service.ts
  - id: routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/vm.routes.ts
    title: backend/src/routes/vm.routes.ts
---

# Purpose

A safety net on the changes a tenant can't easily undo by hand: `resizeVm` (CPU/RAM and root-disk grow), `resizeDataDisk` and `enterRescue` call `autoSnapshotBefore` after `requireOurGuest` and before changing anything. The result travels back in the response (`autoSnapshot`) so the UI can say which snapshot was taken, or why none was.[^svc] [^vm] [^disk] [^routes]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `autoSnapshotBefore` | `(vm, op, client, now?) => AutoSnapshotResult` | Off → `{ taken: null, skipped: 'disabled' }`; LXC → `'container'`; storage without snapshot support (`canSnapshot` = `/qemu/<vmid>/feature?feature=snapshot`) → `'unsupported'`. Otherwise takes a disk-only snapshot, records it in [AutoSnapshot](/database/auto-snapshot.md) with its `snaptime`, then prunes. Throws `AutoSnapshotError` when the snapshot can't be taken (routes answer 409), so the change is not made. |
| `pruneAutoSnapshots` | `(vm, keep, client, snaps?) => number` | Deletes recorded automatic snapshots beyond the newest `keep`. |
| `getAutoSnapshotSettings` / `saveAutoSnapshotSettings` | | `auto_snapshot_enabled` (default on), `auto_snapshot_keep` (default 3, 1..10). See [config](/config/auto-snapshot.md). |
| `isReservedSnapshotName` | `(name) => boolean` | User snapshots may not start with `pm-auto-` (the create route rejects them). |

# Invariants

- Retention only deletes a snapshot that has an AutoSnapshot row whose name and `snaptime` match the live snapshot. A snapshot named like an automatic one but unrecorded, or a user snapshot that reuses a recorded name, is never deleted.[^svc]
- At the 12-snapshot cap (`MAX_SNAPSHOTS_PER_VM`, shared with user snapshots) room is made only by removing this VM's oldest automatic snapshots; a VM full of user snapshots refuses the change.[^svc]
- Rebuild is deliberately not covered: it deletes the guest, and Proxmox deletes a guest's snapshots with it. `rebuildVm` drops the VM's AutoSnapshot rows after the teardown, and the rebuild dialog tells the user to take a backup.[^vm]

# Gotchas

- Snapshots are disk-only (no RAM state), so a running guest's snapshot is crash-consistent.
- Snapshots use storage that isn't quota-counted, and on node-local storage a VM with snapshots may not live-migrate; the admin card says both.

# Relationships

- Called by the [vm service](/services/vm.md) and [disk service](/services/disk.md); configured from the [admin API](/api/admin.md).

[^svc]: backend/src/services/auto-snapshot.service.ts
[^vm]: backend/src/services/vm.service.ts
[^disk]: backend/src/services/disk.service.ts
[^routes]: backend/src/routes/vm.routes.ts
