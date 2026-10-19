---
type: Prisma Model
title: ApiToken
description: A personal API token (pm_ prefix) for CLI, Terraform or script access that acts as its owning user.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
tags: [proxmate, database, prisma, auth, api-token]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: schema
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
    title: backend/prisma/schema.prisma
  - id: svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/api-token.service.ts
    title: backend/src/services/api-token.service.ts
  - id: routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/api-token.routes.ts
    title: backend/src/routes/api-token.routes.ts
---

# Purpose

Bearer tokens for programmatic access. The raw token is shown exactly once at creation; only a hash is stored, and a request bearing it is authenticated as the owning user.[^schema] [^svc] See [api-token router](/api/api-token.md).[^routes]

# Schema

| Field | Type | Attributes | Description |
|---|---|---|---|
| id | String | `@id @default(cuid())` | Primary key. |
| userId | String | FK, `@@index` | Owning [User](/database/user.md). |
| name | String | | User label, e.g. `"ci"`. |
| tokenHash | String | `@unique` | Hex HMAC-SHA256 of the raw token keyed by `ENCRYPTION_KEY` (see Gotchas). |
| prefix | String | | First 11 chars of the raw token (`pm_` + 8), for display. |
| lastUsedAt | DateTime? | | Best-effort stamp on each successful verify. |
| expiresAt | DateTime? | | null = never expires. |
| createdAt | DateTime | `@default(now())` | |

[^schema] [^svc]

# Relationships

- Belongs to [User](/database/user.md), `onDelete: Cascade`.[^schema]

# Invariants

- Raw format is `pm_` + 24 random bytes base64url; any bearer starting with `pm_` is routed to API-token verification rather than JWT verification.[^svc]
- Verification rejects unknown hashes, `expiresAt` in the past, and owners whose compute access window has lapsed (`isAccessExpired`).[^svc]
- Revocation is `deleteMany where { id, userId }`, so a user can only revoke their own tokens.[^svc]
- Listing never selects `tokenHash`.[^svc]
- The token-management router (list/create/delete) returns 403 when the caller authenticated with an API token. Managing tokens requires a browser session.[^routes]

# Gotchas

- The schema comment says "SHA-256", but the service actually uses HMAC-SHA256 with `ENCRYPTION_KEY` as pepper and throws if that env var is unset. Rotating `ENCRYPTION_KEY` invalidates every API token.[^svc]
- `createApiToken` never sets `expiresAt`, so tokens created through the service do not expire.[^svc]

[^schema]: backend/prisma/schema.prisma
[^svc]: backend/src/services/api-token.service.ts
[^routes]: backend/src/routes/api-token.routes.ts
