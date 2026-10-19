---
type: Backend Service
title: Passkey service (WebAuthn)
description: WebAuthn passkey registration, usernameless authentication and management using @simplewebauthn/server with an RP derived from FRONTEND_URL.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/passkey.service.ts
tags: [proxmate, auth, webauthn, passkey]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T20:00:00Z }
sources:
  - id: passkey
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/passkey.service.ts
    title: backend/src/services/passkey.service.ts
  - id: challenges
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/lib/webauthn-challenges.ts
    title: backend/src/lib/webauthn-challenges.ts
---

# Purpose

Passwordless login and second factor via discoverable WebAuthn credentials. Relying-party name is `ProxMate`.[^passkey]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `registrationOptions` | `(userId, userName)` | Options with `attestationType: 'none'`, residentKey/userVerification `preferred`, excluding already-enrolled credentials. |
| `verifyRegistration` | `(userId, response, expectedChallenge, name)` | Verifies against origin/RP ID, stores the credential (name defaults to `Passkey`). |
| `authenticationOptions` | `()` | No `allowCredentials`, so the authenticator offers discoverable passkeys. |
| `verifyAuthentication` | `(response, expectedChallenge) => userId` | Looks up by credential id, verifies, updates `counter` and `lastUsedAt`. |
| `listPasskeys` | `(userId)` | `id, name, createdAt, lastUsedAt`. |
| `deletePasskey` | `(userId, id)` | `deleteMany` scoped to the owner. |

# Data

[Passkey](/database/passkey.md): `id` (credential id), `userId`, `publicKey` (bytes), `counter`, `transports` (CSV), `name`, `deviceType`, `backedUp`, `lastUsedAt`.[^passkey]

Env: `WEBAUTHN_ORIGIN` (else `FRONTEND_URL`, else `http://localhost:3000`) and `WEBAUTHN_RP_ID` (else the origin's hostname) — see [backend environment](/env/backend-environment.md).[^passkey]

# Gotchas

- `rpID` must equal the site's registrable domain and `origin` the exact page origin; a wrong `FRONTEND_URL` breaks every passkey ceremony.[^passkey]
- Challenge storage is the caller's responsibility (the auth router passes `expectedChallenge`).[^passkey] The router keeps each issued challenge server-side in process memory (`issueWebauthnChallenge` / `takeWebauthnChallenge`) for 5 minutes, bound to its ceremony (`login`, `register`, `kiosk-exit`) and, for per-user ceremonies, the user; it can be taken once, and the `proxmate_webauthn` cookie holds only an opaque handle. A backend restart drops pending challenges, so the user simply retries.[^challenges]

# Relationships

- Called only by the [auth router](/api/auth.md). Counted by [mfa](/services/mfa.md); also used to exit [kiosk](/services/kiosk.md) mode.

[^passkey]: backend/src/services/passkey.service.ts
[^challenges]: backend/src/lib/webauthn-challenges.ts
