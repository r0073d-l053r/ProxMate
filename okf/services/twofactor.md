---
type: Backend Service
title: Two-factor service (TOTP and recovery codes)
description: TOTP enrollment with an encrypted secret and QR code, login verification with one step of clock skew, and ten single-use SHA-256-hashed recovery codes.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/twofactor.service.ts
tags: [proxmate, auth, 2fa, totp]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: tf
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/twofactor.service.ts
    title: backend/src/services/twofactor.service.ts
---

# Purpose

Authenticator-app second factor (issuer `ProxMate`) built on `otplib` and `qrcode`.[^tf]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `beginSetup` | `(userId, accountLabel, currentCode?, ip?) => { otpauthUrl, secret, qrDataUrl }` | Generates a secret and stages it encrypted in `twoFactorPendingSecret`; the active secret and `twoFactorEnabled` are left as they are. When 2FA is already on, requires a valid current TOTP or recovery code. |
| `enable` | `(userId, code) => { recoveryCodes }` | Verifies the code against the staged secret; transaction moves it into `twoFactorSecret`, enables 2FA, clears the staged secret and replaces recovery codes with 10 new ones (5 random bytes hex, shown as `xxxxx-xxxxx`). |
| `verifyTotp` | `(userId, code) => boolean` | Requires 2FA enabled. |
| `verifyRecoveryCode` | `(userId, code) => boolean` | Normalises (alphanumerics, lowercase), matches unused hash, marks `usedAt` with a write conditional on it still being unused (a code presented twice at once is accepted once). |
| `disable` | `(userId, code, ip?)` | Needs a valid TOTP or recovery code; clears the active and staged secrets and all recovery codes. |
| `getStatus` | `(userId) => { enabled, recoveryCodesLeft }` | |

# Data

[User](/database/user.md) `twoFactorSecret` and `twoFactorPendingSecret` (encrypted via `lib/crypto`), `twoFactorEnabled`; [TwoFactorRecoveryCode](/database/two-factor-recovery-code.md) (`codeHash` SHA-256, `usedAt`).[^tf]

# Gotchas

- `authenticator.options = { window: 1 }` allows plus/minus one 30 s step for clock skew.[^tf]
- The code that confirms `disable` or a new setup while 2FA is on goes through the account lockout like a login code: an attempt is reserved first (a locked account checks nothing and gets "Too many incorrect codes"), a wrong code counts toward `twoFactorFailedAttempts`, a right one clears it.[^tf]
- Re-starting setup only replaces the staged secret; an active factor keeps working until `enable` confirms the new one. A setup begun before staging existed (secret in `twoFactorSecret` with 2FA off) can still be confirmed.[^tf]

# Relationships

- Called by the [auth router](/api/auth.md). Challenge tokens come from [auth service](/services/auth.md); presence checks in [mfa](/services/mfa.md).

[^tf]: backend/src/services/twofactor.service.ts
