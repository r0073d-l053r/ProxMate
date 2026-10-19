---
type: Backend Service
title: Password-reset service
description: Forgot-password flow that emails a single-use one-hour reset link when SMTP is on, or queues a request for an admin otherwise, without revealing whether the email exists.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/password-reset.service.ts
tags: [proxmate, auth, password-reset, security]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: reset
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/password-reset.service.ts
    title: backend/src/services/password-reset.service.ts
---

# Purpose

Self-service and admin-assisted password resets.[^reset]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `requestReset` | `(email, appUrl) => { method: 'email' \| 'admin' }` | Normalises email. With SMTP → creates a token (SHA-256 hash, TTL 1 h) and emails `<appUrl>/reset-password?token=<raw>`; without SMTP → creates a pending `PasswordResetRequest` (deduped). |
| `resetWithToken` | `(token, newPassword) => { id, email, remainingPasskeys }` | Validates unused/unexpired token and claims it with a write conditional on it still being unused (so a link sets at most one password); then in one transaction sets the bcrypt hash, deletes all the user's sessions and API tokens, and voids their other outstanding reset links. Returns the names of the passkeys left on the account. |
| `adminResetPassword` | `(userId, newPassword, { removePasskeys = false })` | Transaction: set hash, delete sessions and API tokens, void outstanding reset links, optionally delete passkeys, mark pending requests `handled`. |
| `listResetRequests` | `()` | Pending requests, newest first. |

# Data

[PasswordResetToken](/database/password-reset-token.md) (`tokenHash`, `expiresAt`, `usedAt`), [PasswordResetRequest](/database/password-reset-request.md) (`status` pending/handled, `handledAt`), [User](/database/user.md) `passwordHash`, [Session](/database/session.md) and [ApiToken](/database/api-token.md) (deleted). [smtp config](/config/smtp.md).[^reset]

# Gotchas

- Anti-enumeration: the returned `method` depends only on SMTP configuration, never on whether the account exists. Mail failures are logged, not surfaced.[^reset]
- A reset logs the user out everywhere: all Session and ApiToken rows are deleted and other reset links stop working.[^reset]
- Passkeys are kept by default: they are a separate factor the user manages on the Security page, and removing them would strip the second factor from a `require2fa` account during recovery. A self-service reset tells the user which passkeys remain; an admin reset can opt to remove them.[^reset]

# Relationships

- Called by the [auth router](/api/auth.md) and [admin router](/api/admin.md).
- Uses [auth service](/services/auth.md) `hashPassword` and [mail](/services/mail.md).

[^reset]: backend/src/services/password-reset.service.ts
