---
type: Backend Service
title: Disk service (extra data disks)
description: Lists, attaches, grows and removes a VM's extra data disks on the root disk's bus and storage, keeping `VirtualMachine.storage` and the owner's storage quota in step.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/disk.service.ts
tags: [proxmate, storage, disks, quota]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T20:00:00Z }
sources:
  - id: disk
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/disk.service.ts
    title: backend/src/services/disk.service.ts
---

# Purpose

`VirtualMachine.storage` tracks TOTAL provisioned GB (root + data disks), so quota accounting (sum of `vm.storage`) covers data disks automatically as long as this service keeps the column in step.[^disk]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `parseDisks` | `(config) => VmDisk[]` | Slots matching `^(scsi\|virtio\|sata\|ide)\d+$`, excluding `media=cdrom` and `cloudinit`; marks the primary disk `isRoot`. |
| `diskSizeGb` | `(val) => number` | Parses `size=` with K/M/G/T units, rounded GB (default unit G). |
| `nextFreeSlot` | `(config, bus) => string \| null` | First free index up to the bus max (`scsi 30, virtio 15, sata 5, ide 3`). |
| `listDisks` | `(vm)` | Live from Proxmox VM config. |
| `addDataDisk` | `(vm, sizeGb) => VmDisk` | Quota check, next slot on root's bus, root's storage pool, `pve.attachDisk`, `storage += sizeGb`. |
| `resizeDataDisk` | `(vm, slot, sizeGb)` | Grow-only; refuses root disk; quota-checks the delta; `pve.resizeDisk`. |
| `removeDataDisk` | `(vm, slot)` | Refuses root disk; `pve.removeDisk`; frees its GB (floor 0). Allowed on a held row, and lifts an over-quota hold once the machine fits the owner's quota again (`liftQuotaHoldIfFits`). |

# Data

[VirtualMachine](/database/virtual-machine.md) `storage`, `userId`; [User](/database/user.md) `role`, `maxStorage`.[^disk]

# Gotchas

- Admins skip the quota check; shrinking deltas skip it too. Usage counts only the owner's non-quota-exempt machines, as for create and resize. Over-quota throws `QuotaError` from [vm service](/services/vm.md).[^disk]
- The root disk is resized via the VM resize controls, not this service.[^disk]
- The DB column is incremented by the delta after the Proxmox call. Add, resize and remove run under the owner's quota lock (`withQuotaLock` from [vm](/services/vm.md)), so concurrent changes are checked and counted one at a time; removal re-reads the row under the lock and writes `max(0, storage - freed)`. All three go through `requireOurGuest`, and `listDisks` returns none for a guest that isn't the row's.

# Relationships

- Called by the [vm router](/api/vm.md).
- Uses [proxmox service](/services/proxmox.md) (`getVmConfig`, `findPrimaryDisk`, `attachDisk`, `resizeDisk`, `removeDisk`); see [Proxmox storage](/proxmox/storage.md).

[^disk]: backend/src/services/disk.service.ts
