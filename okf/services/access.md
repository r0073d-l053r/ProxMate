---
type: Backend Service
title: Access service (tenant compute-access windows)
description: Pure helpers that decide whether a tenant's compute-access window has lapsed and build the refusal returned by every session-minting login path.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/access.service.ts
tags: [proxmate, auth, access-expiry, tenancy, security]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: access
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/access.service.ts
    title: backend/src/services/access.service.ts
  - id: schema
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
    title: backend/prisma/schema.prisma
---

# Purpose

Defines tenant compute-access windows: an admin gives a user either a fixed window or "never expires". The window is seeded from the invite at registration and editable per-user from the admin Users panel. This module holds no I/O; it is the single place allowed to decide "expired".[^access]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `ACCESS_DURATIONS` | `['never','7d','14d','30d','60d','90d','180d','365d']` | Durations offered in the UI. |
| `isAccessDuration` | `(v: unknown) => v is AccessDuration` | Type guard for the list above. |
| `accessExpiryFrom` | `(duration, from = new Date()) => Date \| null` | Converts a duration to an absolute expiry; `never`/null/undefined → `null`. Throws on any unknown string. |
| `isAccessExpired` | `(user: {role, accessExpiresAt?}, now?) => boolean` | False for admins and for null expiry; otherwise `accessExpiresAt <= now` (boundary inclusive). |
| `daysUntilExpiry` | `(user, now?) => number \| null` | Whole days left (ceil); null when never expires or admin; negative once lapsed. |
| `accessExpiredMessage` | `(at: Date \| null) => string` | User-facing message, with date when known. |
| `loginRefusal` | `(user, now?) => AccessRefusal \| null` | Returns `{ code: 'access_expired', error }` when the login must be refused, else null. |
| `ACCESS_EXPIRED_CODE` | `'access_expired'` | Machine-readable marker so the UI can distinguish this from a dead session. |

# Data

Reads (from caller-supplied rows) `User.role` and `User.accessExpiresAt` on [User](/database/user.md). It writes nothing; the related latch/warning columns (`accessSuspendedAt`, `accessWarned7For`, `accessWarned1For`) are handled by [access-sweep](/services/access-sweep.md).[^schema]

# Invariants

- `accessExpiresAt === null` means NEVER EXPIRES; it is the default for every pre-existing account. Callers must never treat null as "expired now".[^access]
- Admins are always exempt regardless of their row, because an expiry that locked out the last admin would need DB surgery to recover.[^access]
- An unrecognised duration string throws rather than silently becoming "never" (which would hand out unlimited access).[^access]

# Gotchas

- `loginRefusal` exists as one function so every login path (password, passkey, SSO; SAML/LDAP planned) uses the same check; `login-access-gate.test.ts` asserts every `createSession` call site in the auth router is guarded by it.[^access]
- Authentication is not entitlement: an IdP or passkey proves identity, this decides whether that identity may use the cluster.[^access]

# Relationships

- Called by [auth router](/api/auth.md), [user router](/api/user.md), [invite router](/api/invite.md), and the auth/enrollment middleware.
- Used by [auth service](/services/auth.md) (`verifySession` reports `accessExpired`), [api-token service](/services/api-token.md), [vm service](/services/vm.md), and [ide-gateway service](/services/ide-gateway.md).
- Periodic side effects (warnings, power-off) live in [access-sweep](/services/access-sweep.md).

[^access]: backend/src/services/access.service.ts
[^schema]: backend/prisma/schema.prisma
