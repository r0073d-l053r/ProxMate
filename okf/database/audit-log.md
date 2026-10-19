---
type: Prisma Model
title: AuditLog
description: An append-only record of who did what, deliberately not foreign-keyed to User so the trail outlives deleted accounts.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
tags: [proxmate, database, prisma, audit, security]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T20:00:00Z }
sources:
  - id: schema
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
    title: backend/prisma/schema.prisma
  - id: svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/audit.service.ts
    title: backend/src/services/audit.service.ts
---

# Purpose

Accountability trail for a multi-tenant box. It feeds both the admin audit log and each VM's activity feed. Rows are written through `recordAudit` only.[^svc] See [audit service](/services/audit.md).

# Schema

| Field | Type | Attributes | Description |
|---|---|---|---|
| id | String | `@id @default(cuid())` | Primary key. |
| userId | String? | `@@index` | Acting user id; null for anonymous, system or failed-login events. |
| actorEmail | String? | | Denormalized actor email. |
| action | String | | Dotted verb, e.g. `vm.create`, `auth.login`, `auth.account_locked`. |
| targetType | String? | | e.g. `vm`, `matestate`, `session`, `user`. |
| targetId | String? | | Affected entity id or name. |
| detail | String? | | Short human summary. |
| ip | String? | | Client IP (see Gotchas). |
| createdAt | DateTime | `@default(now())`, `@@index` | |

[^schema]

# Relationships

- None by design. `userId` / `targetId` are plain strings, so rows survive cascading deletes of [User](/database/user.md) and [VirtualMachine](/database/virtual-machine.md).[^schema]

# Invariants

- `recordAudit` never throws. Failures are logged and swallowed so auditing cannot break the action it records.[^svc]
- `listAudit` returns newest first, `limit` clamped 1..500 (default 100). `listAuditForTarget` clamps 1..100 (default 20).[^svc]
- With `hideActionsByAdminsExcept`, the per-VM feed hides rows by admins other than the VM owner. It's filtered at read time, so the effect is retroactive.[^svc]

# Gotchas

- `ip` uses the header named by `REAL_IP_HEADER` (default `cf-connecting-ip`, first comma value) only when `TRUST_PROXY` is 1 or more; otherwise, and when the header is empty, unset or `x-forwarded-for`, it is `req.ip` (Express applies the trusted hop count). Behind a proxy without `TRUST_PROXY` every row shows the proxy's address.[^svc]
- No pruning exists for this table. It grows without bound.[^svc]

[^schema]: backend/prisma/schema.prisma
[^svc]: backend/src/services/audit.service.ts
