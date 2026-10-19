---
type: Prisma Model
title: Passkey
description: A WebAuthn credential that serves as a passwordless login and counts as a second factor.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
tags: [proxmate, database, prisma, auth, webauthn]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: schema
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
    title: backend/prisma/schema.prisma
  - id: svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/passkey.service.ts
    title: backend/src/services/passkey.service.ts
  - id: mfa
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/mfa.service.ts
    title: backend/src/services/mfa.service.ts
---

# Purpose

Usernameless (discoverable) WebAuthn login via `@simplewebauthn/server`. Owning at least one passkey also satisfies an invite's `require2fa`.[^svc] [^mfa]

# Schema

| Field | Type | Attributes | Description |
|---|---|---|---|
| id | String | `@id` | The credential ID (base64url), supplied by the authenticator, not generated. |
| userId | String | `@@index` | [User](/database/user.md) id (scalar, no FK). |
| publicKey | Bytes | | COSE public-key blob. |
| counter | Int | `@default(0)` | Signature counter; guards against cloned-authenticator replay. |
| transports | String? | | CSV of authenticator transports. |
| name | String | | User label; defaults to `"Passkey"` when blank. |
| deviceType | String? | | `singleDevice` or `multiDevice`. |
| backedUp | Boolean | `@default(false)` | Credential is synced/backed up. |
| createdAt | DateTime | `@default(now())` | |
| lastUsedAt | DateTime? | | Updated on each successful authentication. |

[^schema] [^svc]

# Relationships

- None. `userId` is a plain id to [User](/database/user.md).[^schema]

# Invariants

- The RP ID and origin come from `WEBAUTHN_ORIGIN` (falling back to `FRONTEND_URL`, then `http://localhost:3000`) and `WEBAUTHN_RP_ID` (falling back to the origin's hostname).[^svc]
- Registration uses `attestationType: 'none'` and excludes the user's existing credentials, so the same authenticator can't enroll twice.[^svc]
- Successful authentication writes the new `counter` and `lastUsedAt`, and returns `passkey.userId`.[^svc]
- Deletion is `deleteMany where { id, userId }` (own passkeys only). Listing selects only `id`, `name`, `createdAt`, `lastUsedAt`.[^svc]

# Gotchas

- With no FK, deleting a user leaves their passkey rows behind.[^schema]

[^schema]: backend/prisma/schema.prisma
[^svc]: backend/src/services/passkey.service.ts
[^mfa]: backend/src/services/mfa.service.ts
