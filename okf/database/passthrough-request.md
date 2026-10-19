---
type: Prisma Model
title: PassthroughRequest
description: A tenant's request to attach a GPU or PCI device to their VM, with the admin's chosen Proxmox mapping and background-apply progress.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
tags: [proxmate, database, prisma, passthrough, gpu]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: schema
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
    title: backend/prisma/schema.prisma
  - id: svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/passthrough-request.service.ts
    title: backend/src/services/passthrough-request.service.ts
  - id: index
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/index.ts
    title: backend/src/index.ts
---

# Purpose

Mirrors [QuotaRequest](/database/quota-request.md) for PCI passthrough. An admin picks a Proxmox PCI resource mapping and approves. The apply may stop the VM and offline-migrate it to the device's node, so it runs in the background and records progress on this row.[^schema] See [passthrough-request router](/api/passthrough-request.md).

# Schema

| Field | Type | Attributes | Description |
|---|---|---|---|
| id | String | `@id @default(cuid())` | Primary key. |
| userId | String | FK, `@@index` | Requesting [User](/database/user.md). |
| vmId | String | FK, `@@index` | Target [VirtualMachine](/database/virtual-machine.md). |
| reason | String? | | |
| status | String | `@default("pending")`, `@@index` | `pending`, `approved`, `denied`. |
| mapping | String? | | Proxmox PCI mapping name chosen at approval. |
| applyState | String? | | `queued`, `stopping`, `migrating`, `attaching`, `done`, `failed`. |
| applyError | String? | | Failure reason; on failure `status` stays `pending` (retryable). |
| targetNode | String? | | Node the VM was migrated to, or kept on. |
| ciDropped | String? | | JSON `[{slot,storage}]` of cloud-init drives dropped before migration; cleared once regenerated. |
| createdAt | DateTime | `@default(now())` | |
| resolvedAt | DateTime? | | |
| resolvedById | String? | | Admin user id (scalar). |

[^schema]

# Relationships

- Belongs to [User](/database/user.md) and [VirtualMachine](/database/virtual-machine.md), both `onDelete: Cascade`.[^schema]

# Invariants

- Creation is refused for LXC guests (400), VMs that already have `hasPassthrough` (409), and VMs with an existing pending request (409).[^svc]
- In-flight states are `queued`, `stopping`, `migrating`, `attaching`; approval and denial are refused while a row is in flight.[^svc]
- On success, one `$transaction` sets the VM's `hasPassthrough = true` and marks the request `approved`, `applyState='done'`.[^svc]
- At boot, `reconcileInterruptedPassthroughApplies` loads pending rows stuck in an in-flight state. If the Proxmox migration is still running it leaves the row alone. Otherwise it re-syncs the VM's node, restores any `ciDropped` cloud-init drives, and sets `applyState='failed'` with `ciDropped` cleared. When drives are recorded but Proxmox is unreachable, the row is left untouched (still in flight, `ciDropped` kept) for the next start to retry. It never auto-resumes the remaining steps.[^svc] [^index]

[^schema]: backend/prisma/schema.prisma
[^svc]: backend/src/services/passthrough-request.service.ts
[^index]: backend/src/index.ts
