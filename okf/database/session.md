---
type: Prisma Model
title: Session
description: A server-side login session backing the 24h session JWT cookie, carrying the double-submit CSRF token.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
tags: [proxmate, database, prisma, auth, session]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: schema
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
    title: backend/prisma/schema.prisma
  - id: auth-svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/auth.service.ts
    title: backend/src/services/auth.service.ts
  - id: auth-routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/auth.routes.ts
    title: backend/src/routes/auth.routes.ts
  - id: reset
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/password-reset.service.ts
    title: backend/src/services/password-reset.service.ts
---

# Purpose

Each browser login mints an HS256 JWT (signed with the `jwt_secret` [SystemConfig](/database/system-config.md) key, `sub` = user id, random `jti`) and persists a `Session` row for it. A JWT is only accepted if its row exists and has not expired, which is what makes logout and "log out everywhere" possible.[^auth-svc]

# Schema

| Field | Type | Attributes | Description |
|---|---|---|---|
| id | String | `@id @default(cuid())` | Primary key. |
| userId | String | FK, `@@index` | Owning [User](/database/user.md). |
| token | String | `@unique`, `@@index` | The full session JWT, stored as-is (not hashed). |
| csrfToken | String? | | 32-byte hex double-submit CSRF token bound to this session. |
| expiresAt | DateTime | | Now + 24h at mint time. |
| createdAt | DateTime | `@default(now())` | |

[^schema] [^auth-svc]

# Relationships

- Belongs to [User](/database/user.md), `onDelete: Cascade`.[^schema]

# Invariants

- `verifySession` pins `algorithms: ['HS256']`, then requires a matching row with `expiresAt >= now`.[^auth-svc]
- `jti` exists so two JWTs minted in the same second for the same user do not collide on the unique `token` column.[^auth-svc]
- Session rotation (`POST /api/auth/session/refresh`) mints a new row and calls `retireSessionWithGrace`, which only *shrinks* the old row's `expiresAt` to now + 90s; it never extends a session.[^auth-svc] [^auth-routes]
- Logout hard-deletes the row; a password reset (emailed or admin-set) deletes every session for that user.[^auth-routes] [^reset]

# Gotchas

- No scheduled job prunes expired sessions. The only cleanup is opportunistic: the refresh route deletes the caller's own expired rows.[^auth-routes]
- Because `token` holds the raw bearer JWT, read access to the DB means live sessions can be replayed until expiry.[^schema]
- 2FA challenge (5 min) and enrollment (15 min) JWTs are signed with the same secret but never get a `Session` row, so they cannot authenticate resource routes.[^auth-svc]

[^schema]: backend/prisma/schema.prisma
[^auth-svc]: backend/src/services/auth.service.ts
[^auth-routes]: backend/src/routes/auth.routes.ts
[^reset]: backend/src/services/password-reset.service.ts
