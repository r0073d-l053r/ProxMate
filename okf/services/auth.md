---
type: Backend Service
title: Auth service (passwords, JWT sessions, challenge tokens)
description: Bcrypt password hashing, HS256 JWT session minting backed by a Session row with a CSRF token, session verification, and short-lived 2FA challenge and enrollment tokens.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/auth.service.ts
tags: [proxmate, auth, jwt, session, security]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: auth
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/auth.service.ts
    title: backend/src/services/auth.service.ts
---

# Purpose

Core authentication primitives shared by the HTTP middleware, the console WebSocket relay, and the IDE proxy.[^auth]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `hashPassword` / `verifyPassword` | `(password[, hash])` | bcrypt with cost 12. |
| `verifyPasswordSafe` | `(password, hash \| null)` | Always runs a bcrypt compare (dummy hash when the account does not exist) to prevent timing-based enumeration. |
| `getJwtSecret` | `() => Promise<string>` | Reads SystemConfig `jwt_secret`; throws "run setup first" if missing. |
| `signToken` | `(userId) => { token, expiresAt }` | JWT `{ sub, jti }`, `expiresIn: '24h'`. |
| `createSession` | `(userId) => { token, csrfToken, expiresAt }` | Signs JWT, generates 32-byte hex CSRF token, inserts a `Session` row. |
| `retireSessionWithGrace` | `(token, graceMs = 90_000)` | Shrinks an old session's `expiresAt` to now+grace during rotation (`POST /auth/session/refresh`). |
| `verifySession` | `(token) => { user, csrfToken, accessExpired, accessExpiresAt } \| null` | Verifies JWT (HS256 pinned), checks Session row exists and is unexpired, loads the user. |
| `verifyToken` | `(token) => AuthUser \| null` | Like `verifySession` but returns null when access has expired; for socket/proxy transports. |
| `signChallenge` / `verifyChallenge` | `(userId)` / `(token) => { userId, challengeId } \| null` | 5-minute `{ twofa: true, jti }` JWT bridging password and TOTP step. Each challenge is also recorded in an in-process store, so it can be retired. |
| `beginChallengeAttempt` / `endChallengeAttempt` | `(challengeId)` / `(challengeId, ok)` | Synchronously count an attempt and mark the challenge busy before a code is checked (false if unknown, busy or past 5 attempts); then spend it on success (single-use) or free it on failure. |
| `signEnrollment` / `verifyEnrollment` | `(userId)` / `(token)` | 15-minute `{ enroll: true }` JWT authorising only first-factor enrollment endpoints. |

# Data

- [Session](/database/session.md): `token` (unique), `csrfToken`, `expiresAt`, `userId`.[^auth]
- [User](/database/user.md): identity fields and `accessExpiresAt`.
- SystemConfig `jwt_secret` — see [platform secrets](/config/platform-secrets.md).

# Gotchas

- `jti` makes every token unique; without it two tokens minted in the same second for the same user collide on `Session.token @unique`.[^auth]
- JWT verification pins `algorithms: ['HS256']`; a token can never choose its own algorithm.[^auth]
- A valid JWT is not enough: the backing `Session` row must exist and be unexpired, so deleting sessions (logout, password reset) revokes immediately.[^auth]
- Session-rotation grace exists because the kiosk panel polls every second; deleting the old row immediately caused in-flight requests to 401 and the frontend to bounce to /login. The update only shrinks lifetime (WHERE `expiresAt > grace`); explicit logout still hard-deletes.[^auth]
- `verifySession` reports `accessExpired` instead of returning null so the UI can explain why; `verifyToken` collapses it to null because raw socket/proxy transports have no JSON error channel, and any future transport copying that pattern inherits the check.[^auth]
- The enrollment token has no Session row, so every resource route rejects it.[^auth]

# Relationships

- Called by the [auth router](/api/auth.md), the console WebSocket handler in `console.routes.ts`, and the auth/enrollment middleware.
- Used by [ide-proxy](/services/ide-proxy.md), [kiosk](/services/kiosk.md), [sso](/services/sso.md), [password-reset](/services/password-reset.md), and setup.
- Depends on [config](/services/config.md) and [access](/services/access.md).

[^auth]: backend/src/services/auth.service.ts
