---
type: Backend Service
title: MFA service (second-factor presence checks)
description: Answers whether a user already has a second factor (TOTP or passkey) and whether an invite-mandated 2FA setup is still outstanding.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/mfa.service.ts
tags: [proxmate, auth, mfa, 2fa]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: mfa
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/mfa.service.ts
    title: backend/src/services/mfa.service.ts
---

# Purpose

Small read-only helpers behind the MFA and enrollment middleware.[^mfa]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `hasMfaMethod` | `(userId) => Promise<boolean>` | `twoFactorEnabled` OR at least one passkey. |
| `isMfaSetupRequired` | `(userId, { ssoExempt = true }) => Promise<boolean>` | True when `require2fa` is set, TOTP is not enabled, and there are zero passkeys. With `ssoExempt` (the default) an SSO-linked user (`ssoSubject` set) is exempt; the password login and the enrollment-token middleware pass `ssoExempt: false`. |

# Data

Reads [User](/database/user.md) (`twoFactorEnabled`, `require2fa`, `ssoSubject`) and counts [Passkey](/database/passkey.md) rows.[^mfa]

# Gotchas

- SSO-linked users are exempt from mandated setup for sessions that came through the IdP, which handles the second factor. The local password login is not exempt: an SSO-linked account keeps its password, so required 2FA still applies there.[^mfa]

# Relationships

- `isMfaSetupRequired` is called by the [auth router](/api/auth.md) and the `mfa`/`enrollment` middleware; `hasMfaMethod` currently has no caller in `backend/src` (only tests).
- Related: [twofactor](/services/twofactor.md), [passkey](/services/passkey.md), enrollment tokens in [auth service](/services/auth.md).

[^mfa]: backend/src/services/mfa.service.ts
