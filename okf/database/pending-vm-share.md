---
type: Prisma Model
title: PendingVmShare
description: A share to an email address that has no account yet; it starts when an account is created with that address and the address is confirmed.
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
  - id: auth
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/auth.routes.ts
    title: backend/src/routes/auth.routes.ts
  - id: sso
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/sso.service.ts
    title: backend/src/services/sso.service.ts
  - id: mig
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/migrations/20261020120000_pending_vm_share/migration.sql
    title: backend/prisma/migrations/20261020120000_pending_vm_share/migration.sql
---

# Purpose

Lets an owner share a VM with someone who hasn't signed up yet. `addShare` stores a pending row when no account has the address, and the share becomes a live [VmShare](/database/vm-share.md) once that person has an account with a confirmed address.[^svc]

# Schema

| Field | Type | Attributes | Description |
|---|---|---|---|
| id | String | `@id @default(cuid())` | Primary key; also the id the owner uses to revoke it. |
| vmId | String | FK | Shared [VirtualMachine](/database/virtual-machine.md). |
| email | String | `@@index` | The address shared with, lowercased. |
| role | String | `@default("viewer")` | `viewer`, `operator`, `manager`. |
| createdAt | DateTime | `@default(now())` | |
| | | `@@unique([vmId, email])` | One pending share per (VM, address). |

Added by migration `20261020120000_pending_vm_share`.[^schema] [^mig]

# Relationships

- Belongs to [VirtualMachine](/database/virtual-machine.md), `onDelete: Cascade`. No relation to [User](/database/user.md): no account exists yet.[^schema]

# Invariants

- `claimPendingShares` turns the rows for an address into live shares when an account is created with it, but only if the account's address is confirmed (`User.emailBound`): registration through an invite sent to that address, or SSO sign-up with an IdP-verified email. A self-typed address leaves the rows pending.[^svc] [^auth] [^sso]
- Claiming never shares a VM with its own owner, keeps an existing live share's level, and deletes the pending rows it processed.[^svc]
- The owner's share list (`GET /api/vms/:id/shares`) shows pending and live shares in the same shape (`id`, `email`, `role`, `createdAt`), and `POST` answers the same either way, so sharing can't reveal which addresses have accounts.[^svc]
- Sharing again with an address that has since got an account replaces its pending row with a live share. Revoking (`DELETE /api/vms/:id/shares/:shareId`) works on either kind.[^svc]

# Gotchas

- A pending share does not invite anyone. The person still needs an invite to register; send one to the same address so the account's email is confirmed and the share starts.

[^schema]: backend/prisma/schema.prisma
[^svc]: backend/src/services/vm-share.service.ts
[^auth]: backend/src/routes/auth.routes.ts
[^sso]: backend/src/services/sso.service.ts
[^mig]: backend/prisma/migrations/20261020120000_pending_vm_share/migration.sql
