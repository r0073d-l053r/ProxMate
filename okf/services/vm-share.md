---
type: Backend Service
title: VM-share service (share presets and capabilities)
description: Shares a VM with another existing user at a preset level (viewer, operator, manager) and defines the capability set each preset grants.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/vm-share.service.ts
tags: [proxmate, sharing, authorization, vm]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: share
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/vm-share.service.ts
    title: backend/src/services/vm-share.service.ts
---

# Purpose

Capability model (owner decision 2026-07-11): a share stores a preset name in `VmShare.role`; code derives capabilities from `CAPS_BY_ROLE`, so presets can evolve without a data migration.[^share]

# Schema

| Preset | Capabilities |
|---|---|
| `viewer` | `view` |
| `operator` | `view`, `power`, `console` |
| `manager` | `view`, `power`, `console`, `configure`, `backups`, `ide` |

Owners and admins hold `ALL_CAPS` (= manager set).[^share] The `ide` capability alone does not open, provision, relocate or mint tokens for the ProxMate IDE; those are limited to the VM's owner (see [ide-proxy](/services/ide-proxy.md)).

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `normalizeShareRole` | `(role) => ShareRole` | Known presets pass; legacy `co-owner` → `manager`; anything else (incl. legacy `read-only`) → `viewer`. |
| `capsForShareRole` | `(role) => Set<VmCap>` | Capability set for a stored role. |
| `listShares` | `(vmId) => ShareView[]` | Oldest first; each `{ id, email, role, createdAt }` — the sharee's account id and display name are not exposed. |
| `addShare` | `(vm, email, role) => ShareView \| null` | `null` when no account has that address (the route answers that exactly like a success); the owner's own address is a 400; upsert on `(vmId, userId)` so re-sharing updates the preset. |
| `removeShare` | `(vmId, shareId) => boolean` | False if the share is not on this VM. |
| `ShareError` | `(message, status = 400)` | Route-surfaced error. |

# Data

[VmShare](/database/vm-share.md) (`vmId`, `userId`, `role`, `createdAt`) and [User](/database/user.md) lookup by email.[^share]

# Invariants

- No share can delete/destroy, migrate, manage shares, request passthrough, or rebuild the VM; that surface is owner/admin-only via `getOwnedVm` in [vm service](/services/vm.md).[^share]
- Unknown role strings fall to the least-privileged preset, so restoring an old backup cannot grant surprise access.[^share]

# Relationships

- Called by the [vm router](/api/vm.md); capability checks (`getVmWithCap`) live in [vm service](/services/vm.md) and are used by [ide-proxy](/services/ide-proxy.md) and [ide-gateway](/services/ide-gateway.md).

[^share]: backend/src/services/vm-share.service.ts
