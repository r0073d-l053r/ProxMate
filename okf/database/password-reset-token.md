---
type: Prisma Model
title: PasswordResetToken
description: A single-use one-hour email password-reset token, stored only as a SHA-256 hash.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
tags: [proxmate, database, prisma, auth, password-reset]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T20:00:00Z }
sources:
  - id: schema
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
    title: backend/prisma/schema.prisma
  - id: svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/password-reset.service.ts
    title: backend/src/services/password-reset.service.ts
---

# Purpose

The "forgot password" path when SMTP is configured. The raw token goes only into the emailed link `<appUrl>/reset-password?token=<raw>`. Without SMTP, a [PasswordResetRequest](/database/password-reset-request.md) is filed instead.[^svc] See [SMTP config](/config/smtp.md).

# Schema

| Field | Type | Attributes | Description |
|---|---|---|---|
| id | String | `@id @default(cuid())` | Primary key. |
| userId | String | `@@index` | [User](/database/user.md) id (scalar, no FK). |
| tokenHash | String | `@unique` | Hex SHA-256 of the raw token (32 random bytes hex). |
| expiresAt | DateTime | | Now + 1 hour (`TOKEN_TTL_MS`). |
| usedAt | DateTime? | | Set when consumed. |
| createdAt | DateTime | `@default(now())` | |

[^schema] [^svc]

# Relationships

- None. `userId` is a plain id to [User](/database/user.md).[^schema]

# Invariants

- Anti-enumeration: `requestReset` returns `{ method: 'email' | 'admin' }` based only on SMTP configuration, never on whether the email exists. Mail failures are logged, not surfaced.[^svc]
- `resetWithToken` rejects unknown, used or expired tokens. It first marks `usedAt` with a write conditional on the token still being unused, so a link presented by two requests at once sets a password only once. Then, in one `$transaction`, it sets the new bcrypt hash, deletes **all** of the user's [Session](/database/session.md)s and [API tokens](/database/api-token.md), and marks every other outstanding reset token for the user used. An admin-set password revokes the same.[^svc]

# Gotchas

- Rows are never pruned, and they are not deleted when the user is deleted (no FK).[^schema] [^svc]
- Issuing a new token does not invalidate earlier unexpired tokens for the same user; completing any one of them does.[^svc]

[^schema]: backend/prisma/schema.prisma
[^svc]: backend/src/services/password-reset.service.ts
