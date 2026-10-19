---
type: Backend Service
title: Passthrough-request service (PCI/GPU passthrough workflow)
description: Tenant requests for PCI/GPU passthrough and the admin two-phase approval that places the VM on a node hosting the Proxmox PCI mapping, attaches `hostpci0`, and recovers interrupted applies on startup.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/passthrough-request.service.ts
tags: [proxmate, passthrough, pci, gpu, migration]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: pt
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/passthrough-request.service.ts
    title: backend/src/services/passthrough-request.service.ts
  - id: index
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/index.ts
    title: backend/src/index.ts
---

# Purpose

A tenant asks for a PCI device on a QEMU VM; an admin approves with a Proxmox resource-mapping name. Mappings are node-scoped, so the VM may have to migrate (with disk relocation) before the device is attached. v1 attaches a single device at `hostpci0`.[^pt]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `createPassthroughRequest` | `(userId, vm, reason?)` | QEMU only (400), not already attached (409), guest must be the row's own (`requireOurGuest`), one pending per VM (409). Approval, the background apply (marks the request `failed` instead) and detach are gated the same way. |
| `listMyPassthroughRequests` | `(userId)` | Newest first with VM name. |
| `listPendingPassthroughRequests` | `() => PendingPassthroughRequest[]` | Admin queue with best-effort q35/OVMF `bootWarnings` and live migration progress while `applyState === 'migrating'`. |
| `beginPassthroughApproval` | `(id, mapping) => PassthroughPlan & { vmName, sourceNode }` | Phase 1 (sync): validate request and mapping, `syncVmNode`, plan placement, host pre-flight (`checkPassthroughHostReadiness`; blockers → 409), set `applyState: 'queued'`. Route then returns 202. |
| `applyPassthroughApproval` | `(id, adminId)` | Phase 2 (background): migrate if needed (live if running, offline otherwise, 6 h timeout) → stop → regenerate dropped cloud-init drives → attach (`pcie` only on q35) → mark approved and `hasPassthrough` → restart only if safe. |
| `reconcileInterruptedPassthroughApplies` | `() => number` | Startup recovery for applies left in flight. |
| `denyPassthroughRequest` | `(id, adminId)` | Refused while an apply is in flight. |
| `detachPassthrough` | `(vm, index)` | Stops the VM if needed, removes `hostpci<index>`, recomputes `hasPassthrough` from live config. |

`applyState` values: `queued`, `migrating`, `stopping`, `attaching`, `done`, `failed`.[^pt]

# Data

- [PassthroughRequest](/database/passthrough-request.md): `status` (pending/approved/denied), `applyState`, `applyError`, `mapping`, `targetNode`, `ciDropped` (JSON), `resolvedAt`, `resolvedById`, `reason`.[^pt]
- [VirtualMachine](/database/virtual-machine.md): `hasPassthrough`, `status`, `proxmoxNode`; [AuditLog](/database/audit-log.md) `passthrough.approve`, `passthrough.apply_failed`, `passthrough.apply_interrupted`.
- SystemConfig `default_storage` ([provisioning defaults](/config/provisioning-defaults.md)).

# Scheduling

No cron. `reconcileInterruptedPassthroughApplies()` runs once after `server.listen` in `index.ts`.[^index]

# Gotchas

- Placement: if the VM already sits on a node in the mapping, no move. Otherwise pick among online mapping nodes (`pickBestNode`, arch-aware). If target lacks the VM's storages, choose `targetstorage` (prefer `default_storage`, else most free space); for OFFLINE moves prefer same-type storage because offline migration needs a shared format (e.g. zfspool → nfs fails). Insufficient free space → 409.[^pt]
- Migration happens FIRST and live for running guests (NBD mirroring works across storage types and shortens downtime to the stop-attach-start window).[^pt]
- Generated cloud-init drives cannot be storage-migrated across types even live, so they are deleted before the move (briefly bouncing a running guest), recorded in `ciDropped`, and regenerated on the target storage.[^pt]
- Rollback rules: failed live migrate leaves the guest running on the source; failed attach leaves it on the target without the device, restarted if ProxMate stopped it; request stays pending+failed so retry is one click. `hasPassthrough` is set only after a successful attach.[^pt]
- Auto-restart after attach only when `checkPassthroughHostReadiness` says `safeToAutoStart` (fallback: q35 AND OVMF). A GPU without OVMF hung a node (pve-4) in testing, so otherwise the VM is left attached-but-stopped and a `vm.error` notification is sent.[^pt]
- Boot readiness is informational and never auto-rewritten: flipping an installed guest to OVMF/q35 can break its boot.[^pt]
- Startup reconcile: if a Proxmox migration is still running, it is left alone (re-checked next restart); otherwise node is re-synced, dropped cloud-init drives restored, and the request marked failed with "Interrupted by a ProxMate restart". Remaining steps are never auto-resumed.[^pt]
- An offline "cannot migrate from storage type" error gets a tip to start the VM and approve again.[^pt]

# Relationships

- Called by the [passthrough-request router](/api/passthrough-request.md) and [admin router](/api/admin.md); boot hook in `index.ts`.
- Uses [vm service](/services/vm.md) (`syncVmNode`, `migrateVmToNode`, `startVm`), [proxmox service](/services/proxmox.md) (PCI mappings, readiness, `attachPci`/`detachPci`, cloud-init drives, migration progress), [config](/services/config.md), [audit](/services/audit.md), [notify](/services/notify.md).
- Passthrough VMs are pinned by [cluster-balancer](/services/cluster-balancer.md) and [ide-provision](/services/ide-provision.md) relocate. Proxmox side: [storage](/proxmox/storage.md), [guest lifecycle](/proxmox/guest-lifecycle.md), [privileges](/proxmox/privileges.md).

[^pt]: backend/src/services/passthrough-request.service.ts
[^index]: backend/src/index.ts
