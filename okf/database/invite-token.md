---
type: Prisma Model
title: InviteToken
description: An admin-minted registration link that carries the new tenant's quotas, 2FA requirement and compute access duration.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
tags: [proxmate, database, prisma, invite, quota]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: schema
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
    title: backend/prisma/schema.prisma
  - id: routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/invite.routes.ts
    title: backend/src/routes/invite.routes.ts
  - id: svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/invite.service.ts
    title: backend/src/services/invite.service.ts
  - id: auth-routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/auth.routes.ts
    title: backend/src/routes/auth.routes.ts
  - id: init-mig
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/migrations/20260623035652_init/migration.sql
    title: backend/prisma/migrations/20260623035652_init/migration.sql
  - id: creator-mig
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/migrations/20261019132000_invite_creator_set_null/migration.sql
    title: backend/prisma/migrations/20261019132000_invite_creator_set_null/migration.sql
  - id: user-routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/user.routes.ts
    title: backend/src/routes/user.routes.ts
---

# Purpose

ProxMate registration is invite-only. An admin creates an invite (admin-only router, `requireAuth` + `requireAdmin`), optionally emails it, and the redeemer's [User](/database/user.md) row is seeded from it.[^routes] See [invite router](/api/invite.md).

# Schema

| Field | Type | Attributes | Description |
|---|---|---|---|
| id | String | `@id @default(cuid())` | Primary key. |
| token | String | `@unique`, `@@index` | 32 random bytes base64url, stored in clear (it is what the link carries).[^svc] |
| createdById | String? | FK | Admin who minted it; NULL once that admin has been deleted. |
| label | String? | | Admin label. |
| email | String? | | Address the link was emailed to, if any. When set, registration must use this address. |
| maxCpu | Int | | vCPU quota granted. |
| maxRam | Int | | RAM quota granted (MB). |
| maxStorage | Int | | Disk quota granted (GB). |
| require2fa | Boolean | `@default(false)` | Force the invitee to enroll a second factor. |
| accessDuration | String? | | Compute window granted, e.g. `'30d'`; null = never expires. |
| usedById | String? | `@unique`, FK | The user who redeemed it. |
| expiresAt | DateTime | | When the *link* stops being redeemable. |
| createdAt | DateTime | `@default(now())` | |

[^schema]

# Relationships

- `createdBy` -> [User](/database/user.md) (relation `CreatedInvites`, `ON DELETE SET NULL`).
- `usedBy` -> [User](/database/user.md) (relation `UsedInvite`, one-to-one via unique `usedById`, `ON DELETE SET NULL`).[^schema] [^init-mig]

# Invariants

- `expiresIn` is parsed as `<n>d|h|m`.[^svc]
- Redemption requires `usedById` null and `expiresAt` in the future. The user's `accessExpiresAt` is computed from `accessDuration` at redemption time, not at mint time.[^auth-routes]
- The claim is atomic: `updateMany where { id, usedById: null }`; on a lost race the freshly created user is deleted.[^auth-routes]
- A used invite cannot be revoked (409); listing hides `token`/`inviteUrl` for used or expired invites.[^routes]

# Gotchas

- `expiresAt` (link lifetime) and `accessDuration` (tenant compute window) are different things and are easy to confuse.[^schema]
- Because `usedById` is `SET NULL` on user delete, deleting the redeeming user makes an unexpired invite redeemable again.[^init-mig]
- `createdById` is `SET NULL`: deleting an admin keeps the invites they issued that were redeemed (creator NULL). `DELETE /api/users/:id` revokes that admin's unredeemed invites in the same transaction.[^creator-mig] [^user-routes]

[^schema]: backend/prisma/schema.prisma
[^routes]: backend/src/routes/invite.routes.ts
[^svc]: backend/src/services/invite.service.ts
[^auth-routes]: backend/src/routes/auth.routes.ts
[^init-mig]: backend/prisma/migrations/20260623035652_init/migration.sql
[^creator-mig]: backend/prisma/migrations/20261019132000_invite_creator_set_null/migration.sql
[^user-routes]: backend/src/routes/user.routes.ts
