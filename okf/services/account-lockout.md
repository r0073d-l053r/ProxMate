---
type: Backend Service
title: Account-lockout service
description: Per-account brute-force protection that temporarily locks a user after a configurable number of consecutive failed passwords and alerts admins.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/account-lockout.service.ts
tags: [proxmate, auth, security, brute-force]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
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
| `reserveLoginAttempt` | `(user, ip) => Promise<boolean>` | Called BEFORE a password is checked. One conditional write increments `failedLoginAttempts` only while it is below `MAX` and no lock is in force. False means locked or exhausted: answer as for a wrong password without verifying. A counter found at `MAX` with no lock is turned into a normal lock. |
| `registerFailedLogin` | `(user, ip) => Promise<boolean>` | Settles a reserved attempt that failed: when the counter has reached `MAX`, claims the lock with a conditional write (so concurrent failures lock exactly once), sets `lockedUntil`, marks the counter spent (`MAX + 1`) for the lock window, audits `auth.account_locked`, emails admins and fires the `auth.lockout` webhook. Returns true if this call locked the account. |
| `clearFailedLogins` | `(user) => Promise<void>` | Resets the stored `failedLoginAttempts` after a correct password (conditional in the database, so the slot just reserved is cleared too). Clears `lockedUntil` only when that lock has already expired; a lock in force is never lifted by a correct password. |
| `reserveSecondFactorAttempt` / `registerFailedSecondFactor` / `clearFailedSecondFactor` | as above | The same on `twoFactorFailedAttempts`: wrong 2FA codes at login and wrong codes that confirm a 2FA change. A correct password does not reset it. Exhausting it applies the same lock and alerts. |

# Data

- [User](/database/user.md): reads/writes `failedLoginAttempts`, `twoFactorFailedAttempts`, `lockedUntil`; reads admin emails.[^lockout]
- [AuditLog](/database/audit-log.md): `auth.account_locked` entry.
- [smtp config](/config/smtp.md) (via `getMailConfig`) and [notifications config](/config/notifications.md) (webhook).

Env tunables: `AUTH_LOCKOUT_MAX` (default 10, min 1) and `AUTH_LOCKOUT_MINUTES` (default 15, min 1); see [backend environment](/env/backend-environment.md).[^lockout]

# Gotchas

- Locking marks the counter spent rather than resetting it; only the lock running out gives a fresh allowance (reset on the next reservation). A counter merely at `MAX` with attempts in flight is never reset, so an old expired lock cannot reopen the cap mid-burst. Neither a correct password nor a lock resets `twoFactorFailedAttempts`; only a correct code or the lock expiring does, so the password holder gets at most `MAX` code guesses per lock window.[^lockout]
- Because every attempt is reserved before it is verified, a parallel burst gets at most `MAX` guesses evaluated per lock window.[^lockout]
- Admin email is sent at most once per lock window (the lock is claimed conditionally and no attempt can be reserved while it holds), so it cannot become a mail bomb; it is a no-op when SMTP is off.[^lockout]
- Uses `notifyWebhook` (webhook only) because admins are already emailed directly; both are best-effort (`.catch(() => {})`).[^lockout]

# Relationships

- Called by the [auth router](/api/auth.md) login path.
- Uses [audit](/services/audit.md), [mail](/services/mail.md), [notify](/services/notify.md).

[^lockout]: backend/src/services/account-lockout.service.ts
