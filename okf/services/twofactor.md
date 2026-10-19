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
| `beginSetup` | `(userId, accountLabel) => { otpauthUrl, secret, qrDataUrl }` | Generates a secret, stores it encrypted with `twoFactorEnabled: false`. |
| `enable` | `(userId, code) => { recoveryCodes }` | Verifies code; transaction enables 2FA, replaces recovery codes with 10 new ones (5 random bytes hex, shown as `xxxxx-xxxxx`). |
| `verifyTotp` | `(userId, code) => boolean` | Requires 2FA enabled. |
| `verifyRecoveryCode` | `(userId, code) => boolean` | Normalises (alphanumerics, lowercase), matches unused hash, marks `usedAt`. |
| `disable` | `(userId, code)` | Needs a valid TOTP or recovery code; clears secret and all recovery codes. |
| `getStatus` | `(userId) => { enabled, recoveryCodesLeft }` | |

# Data

[User](/database/user.md) `twoFactorSecret` (encrypted via `lib/crypto`), `twoFactorEnabled`; [TwoFactorRecoveryCode](/database/two-factor-recovery-code.md) (`codeHash` SHA-256, `usedAt`).[^tf]

# Gotchas

- `authenticator.options = { window: 1 }` allows plus/minus one 30 s step for clock skew.[^tf]
- Calling `beginSetup` again overwrites the secret and sets `twoFactorEnabled: false`, so re-starting setup disables an active factor until confirmed. The `POST /api/auth/2fa/setup` route ([auth router](/api/auth.md)) calls it without asking for a current code, unlike `disable`.[^tf]
- No replay protection for a TOTP code within its window is implemented in this file.[^tf]

# Relationships

- Called by the [auth router](/api/auth.md). Challenge tokens come from [auth service](/services/auth.md); presence checks in [mfa](/services/mfa.md).

[^tf]: backend/src/services/twofactor.service.ts
