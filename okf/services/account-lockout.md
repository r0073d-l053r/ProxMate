---
type: Backend Service
title: Account-lockout service
description: Per-account brute-force protection that temporarily locks a user after a configurable number of consecutive failed passwords and alerts admins.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/account-lockout.service.ts
tags: [proxmate, auth, security, brute-force]
generated: { by: claude-code/okf-bootstrap, at: 2026-10-19T12:00:00Z }
sources:
  - id: lockout
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/account-lockout.service.ts
    title: backend/src/services/account-lockout.service.ts
---

# Purpose

Protects a targeted account from distributed password guessing (MITRE T1110), complementing the per-IP rate limiter in `rate-limit.ts`. After `MAX` consecutive failed passwords the account is locked for `LOCK_MINUTES`, then auto-unlocks; it is never a permanent lock, so it cannot be weaponised into a denial of service.[^lockout]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `isAccountLocked` | `(user: {lockedUntil}) => boolean` | True while `lockedUntil` is in the future. |
| `clearFailedLogins` | `(user) => Promise<void>` | Resets `failedLoginAttempts` to 0 and `lockedUntil` to null after a correct password (no-op if already clear). |
| `registerFailedLogin` | `(user, ip: string \| null) => Promise<boolean>` | Increments the counter; at the threshold sets `lockedUntil`, resets the counter, audits `auth.account_locked`, emails admins and fires the `auth.lockout` webhook. Returns true if this attempt locked the account. |

# Data

- [User](/database/user.md): reads/writes `failedLoginAttempts`, `lockedUntil`; reads admin emails.[^lockout]
- [AuditLog](/database/audit-log.md): `auth.account_locked` entry.
- [smtp config](/config/smtp.md) (via `getMailConfig`) and [notifications config](/config/notifications.md) (webhook).

Env tunables: `AUTH_LOCKOUT_MAX` (default 10, min 1) and `AUTH_LOCKOUT_MINUTES` (default 15, min 1); see [backend environment](/env/backend-environment.md).[^lockout]

# Gotchas

- The counter is reset AS the lock is applied, so the first failed attempt after auto-unlock starts a fresh window rather than instantly re-locking.[^lockout]
- Admin email is sent at most once per lock window (further attempts hit the locked-out short-circuit first), so it cannot become a mail bomb; it is a no-op when SMTP is off.[^lockout]
- Uses `notifyWebhook` (webhook only) because admins are already emailed directly; both are best-effort (`.catch(() => {})`).[^lockout]

# Relationships

- Called by the [auth router](/api/auth.md) login path.
- Uses [audit](/services/audit.md), [mail](/services/mail.md), [notify](/services/notify.md).

[^lockout]: backend/src/services/account-lockout.service.ts
