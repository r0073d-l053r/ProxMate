---
type: Prisma Model
title: QuotaRequest
description: A tenant's request for higher resource caps, approved or denied by an admin.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
tags: [proxmate, database, prisma, quota, admin]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: schema
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
    title: backend/prisma/schema.prisma
  - id: svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/quota-request.service.ts
    title: backend/src/services/quota-request.service.ts
---

# Purpose

Self-service quota increase workflow. Values are **absolute** targets, so approval just copies them onto the user's `maxCpu` / `maxRam` / `maxStorage`.[^schema] See [quota-request router](/api/quota-request.md).

# Schema

| Field | Type | Attributes | Description |
|---|---|---|---|
| id | String | `@id @default(cuid())` | Primary key. |
| userId | String | FK, `@@index` | Requesting [User](/database/user.md). |
| cpu | Int | | Requested new max vCPU. |
| ram | Int | | Requested new max RAM (MB). |
| storage | Int | | Requested new max storage (GB). |
| reason | String? | | Trimmed; empty becomes null. |
| status | String | `@default("pending")`, `@@index` | `pending`, `approved`, `denied`. |
| createdAt | DateTime | `@default(now())` | |
| resolvedAt | DateTime? | | Set on approve/deny. |
| resolvedById | String? | | Admin user id (scalar, no FK). |

[^schema] [^svc]

# Relationships

- Belongs to [User](/database/user.md), `onDelete: Cascade`.[^schema]

# Invariants

- One pending request per user, enforced in the service (409 otherwise), not by a DB constraint.[^svc]
- Approve runs in a `$transaction`: update the user's caps, then mark the request `approved` with `resolvedAt` / `resolvedById`. Deny only marks the request. Both refuse already-resolved rows with 409.[^svc]
- The admin queue lists pending requests oldest first, joined with the requester's current quota.[^svc]

[^schema]: backend/prisma/schema.prisma
[^svc]: backend/src/services/quota-request.service.ts
