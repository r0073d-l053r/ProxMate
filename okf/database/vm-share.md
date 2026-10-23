---
type: Prisma Model
title: VmShare
description: Grants another user access to a VM they do not own at a preset level of viewer, operator or manager.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
tags: [proxmate, database, prisma, vm, sharing, authorization]
generated: { by: okf-bootstrap/0.1, at: 2026-10-20T12:00:00Z }
sources:
  - id: schema
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
    title: backend/prisma/schema.prisma
  - id: svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/vm-share.service.ts
    title: backend/src/services/vm-share.service.ts
  - id: vm-svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/vm.service.ts
    title: backend/src/services/vm.service.ts
  - id: mig
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/migrations/20260711161000_share_role_presets/migration.sql
    title: backend/prisma/migrations/20260711161000_share_role_presets/migration.sql
---

# Purpose

Per-VM sharing. The row stores only the preset *name*. Capabilities come from `CAPS_BY_ROLE` in code, so presets can change without a data migration.[^svc]

# Schema

| Field | Type | Attributes | Description |
|---|---|---|---|
| id | String | `@id @default(cuid())` | Primary key. |
| vmId | String | FK | Shared [VirtualMachine](/database/virtual-machine.md). |
| userId | String | FK, `@@index` | The user the VM is shared **with** (not the owner). |
| role | String | `@default("viewer")` | `viewer`, `operator`, `manager`. |
| createdAt | DateTime | `@default(now())` | |
| | | `@@unique([vmId, userId])` | One share per (VM, user). |

[^schema]

# Relationships

- Belongs to [VirtualMachine](/database/virtual-machine.md) and [User](/database/user.md), both `onDelete: Cascade`.[^schema]

# Invariants

- Capability presets:[^svc]

  | Role | Caps |
  |---|---|
  | viewer | view, console_view |
  | operator | view, console_view, power, console |
  | manager | view, console_view, power, console, configure, backups, ide |

- `console_view` is a view-only console (the relay drops every input message); `console` is interactive and implies `console_view`.[^svc]

- No share can delete, migrate, rebuild, manage shares or request passthrough. Those actions stay owner/admin-only via `getOwnedVm`.[^svc]
- `addShare` looks the target up by email (lowercased), refuses the VM's owner, and upserts on `(vmId, userId)`, so re-sharing just changes the role. An address with no account gets a [PendingVmShare](/database/pending-vm-share.md) instead, and the owner's list shows both kinds the same way.[^svc]
- A VM holds at most `MAX_SHARES_PER_VM` (100) shares, live and pending together; a new address past that answers 409.[^svc]
- Shared VMs appear in the recipient's VM list alongside their own.[^vm-svc]

# Gotchas

- Legacy role strings are normalized on read: `co-owner` becomes `manager`, and anything unknown (including `read-only`) becomes `viewer`. Migration `20260711161000_share_role_presets` also rewrote existing rows.[^svc] [^mig]

[^schema]: backend/prisma/schema.prisma
[^svc]: backend/src/services/vm-share.service.ts
[^vm-svc]: backend/src/services/vm.service.ts
[^mig]: backend/prisma/migrations/20260711161000_share_role_presets/migration.sql
