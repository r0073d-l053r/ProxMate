---
type: Prisma Model
title: TwoFactorRecoveryCode
description: One of ten single-use TOTP backup codes issued when a user enables 2FA, stored only as a SHA-256 hash.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
tags: [proxmate, database, prisma, auth, 2fa]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T20:00:00Z }
sources:
  - id: schema
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
    title: backend/prisma/schema.prisma
  - id: svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/twofactor.service.ts
    title: backend/src/services/twofactor.service.ts
---

# Purpose

Lost-device backup for TOTP. It can be used as a second factor at login, or to disable 2FA.[^svc]

# Schema

| Field | Type | Attributes | Description |
|---|---|---|---|
| id | String | `@id @default(cuid())` | Primary key. |
| userId | String | `@@index` | [User](/database/user.md) id (scalar, no FK). |
| codeHash | String | | Hex SHA-256 of the normalized code (lowercase, alphanumerics only). Not unique. |
| usedAt | DateTime? | | Set when consumed. |
| createdAt | DateTime | `@default(now())` | |

[^schema] [^svc]

# Relationships

- None. `userId` is a plain id to [User](/database/user.md).[^schema]

# Invariants

- `enable` creates 10 codes (5 random bytes hex each, shown once as `xxxxx-xxxxx`). It runs in a `$transaction` with `twoFactorEnabled = true` (moving the confirmed `twoFactorPendingSecret` into `twoFactorSecret`) and deletes any previous codes.[^svc]
- `verifyRecoveryCode` matches `{ userId, codeHash, usedAt: null }` and then sets `usedAt` with a write conditional on it still being unused. Each code works once, even when presented by two requests at once.[^svc]
- `disable` (which needs a valid TOTP or recovery code) clears `twoFactorSecret`, sets `twoFactorEnabled = false`, and deletes all codes in one transaction.[^svc]
- `getStatus` reports `recoveryCodesLeft` = count of unused codes.[^svc]

# Gotchas


[^schema]: backend/prisma/schema.prisma
[^svc]: backend/src/services/twofactor.service.ts
