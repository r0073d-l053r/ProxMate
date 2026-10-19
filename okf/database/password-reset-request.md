---
type: Prisma Model
title: PasswordResetRequest
description: A "contact admin" password-reset request filed when no SMTP is configured, resolved by an admin setting a new password.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
tags: [proxmate, database, prisma, auth, password-reset, admin]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: schema
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
    title: backend/prisma/schema.prisma
  - id: svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/password-reset.service.ts
    title: backend/src/services/password-reset.service.ts
---

# Purpose

The no-email fallback for [PasswordResetToken](/database/password-reset-token.md). Pending requests are listed to admins, newest first.[^svc]

# Schema

| Field | Type | Attributes | Description |
|---|---|---|---|
| id | String | `@id @default(cuid())` | Primary key. |
| userId | String | | [User](/database/user.md) id (scalar, no FK). |
| email | String | | Denormalized for the admin list. |
| status | String | `@default("pending")`, `@@index` | `pending` or `handled`. |
| createdAt | DateTime | `@default(now())` | |
| handledAt | DateTime? | | Set when handled. |

[^schema]

# Relationships

- None. `userId` is a plain id to [User](/database/user.md).[^schema]

# Invariants

- Filed only when SMTP is off and the email matches a user. At most one `pending` row per user (dedupe in the service).[^svc]
- `adminResetPassword` runs one `$transaction`: set the new password hash, delete all the user's [Session](/database/session.md)s, and mark the user's pending requests `handled` with `handledAt`.[^svc]

[^schema]: backend/prisma/schema.prisma
[^svc]: backend/src/services/password-reset.service.ts
