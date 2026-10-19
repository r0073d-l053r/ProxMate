---
type: API Router
title: Auth router
description: Registration, password/2FA/passkey/SSO login, sessions, kiosk exit, account MFA management and password reset, mounted at /api/auth.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/auth.routes.ts
tags: [proxmate, api, auth, mfa, sso, passkeys]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/auth.routes.ts
    title: backend/src/routes/auth.routes.ts
  - id: app
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/app.ts
    title: backend/src/app.ts
  - id: mw-auth
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/middleware/auth.ts
    title: backend/src/middleware/auth.ts
  - id: mw-enroll
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/middleware/enrollment.ts
    title: backend/src/middleware/enrollment.ts
  - id: authsvc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/auth.service.ts
    title: backend/src/services/auth.service.ts
  - id: ratelimit
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/middleware/rate-limit.ts
    title: backend/src/middleware/rate-limit.ts
---

# Purpose

Every credential flow. Mounted at `/api/auth`.[^app] Successful logins call `createSession` (24 h HS256 JWT with a random `jti` plus a `Session` row holding a 32-byte hex CSRF token) and `setAuthCookies`.[^authsvc]

# Authentication

No router-level middleware; each route picks its own:[^routes]

- **public + `authLimiter`** (default 20 / 15 min / IP): register, login, 2fa/verify, passkey auth, forgot/reset password.[^ratelimit]
- **public + `publicTokenLimiter`** (default 60 / 15 min / IP): invite lookup.
- **`requireAuth`**: session routes; `allowExpiredAccess` is placed before it only on `GET /me` and `POST /logout` so a tenant with a lapsed compute window can still see why and log out.[^mw-auth]
- **`requireAuthOrEnrollment`**: first-factor enrollment (TOTP setup/enable, passkey register); accepts a real session or a 15-minute scoped enrollment token that only works while the user still needs MFA setup.[^mw-enroll][^authsvc]
- **`kioskExitLimiter` + `requireAuth` + admin role check**: kiosk exit (default 10 / 5 min / IP).[^ratelimit]
- **`requireSession`** (after `requireAuth` / `requireAuthOrEnrollment`): 403 for a caller authenticated with a `pm_` API token. On session refresh, kiosk exit, every 2FA route except `/2fa/verify`, and passkey register/list/delete.[^mw-auth]
- No `enforceMfaSetup` on this router (it hosts the enrollment flows).

# Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/register` | public + authLimiter | Redeem invite `{ email, password (min 8), displayName, inviteToken }`. When the invite has an `email`, the registration email must match it (case-insensitive), else 400; the account then gets `emailBound`. 201 with user + cookies, or `{ mfaEnrollmentRequired, enrollmentToken }` when the invite requires 2FA (no session). |
| POST | `/api/auth/login` | public + authLimiter | `{ email, password }`. Returns user + cookies, or `{ twoFactorRequired, challenge }`, or `{ mfaEnrollmentRequired, enrollmentToken }`, or 401 `passkey_required`, or 403 access-expired. |
| POST | `/api/auth/2fa/verify` | public + authLimiter | Exchange `{ challenge, code }` (TOTP or recovery code) for a session. A challenge is single-use, is checked against one code at a time, and stops working after 5 attempts; each code also reserves an attempt against the account before it is checked (locks at the lockout threshold); a locked account cannot complete 2FA. |
| POST | `/api/auth/logout` | allowExpiredAccess + requireAuth | Deletes the `Session` row, clears cookies. |
| POST | `/api/auth/session/refresh` | requireAuth + requireSession | Mint a fresh 24 h session, set cookies, retire old session with a ~90 s grace, prune the user's expired sessions. |
| POST | `/api/auth/kiosk-exit` | kioskExitLimiter + requireAuth + requireSession + admin | `{ method: 'pin' or 'password', value }` unlock check; `{ ok: true }`, or 403 `{ code: 'reauth_failed' }` for a wrong PIN or password (401 is reserved for a missing or dead session, which the frontend treats as signed out). |
| POST | `/api/auth/kiosk-exit/passkey-options` | kioskExitLimiter + requireAuth + requireSession + admin | WebAuthn assertion options; sets challenge cookie. |
| POST | `/api/auth/kiosk-exit/passkey-verify` | kioskExitLimiter + requireAuth + requireSession + admin | Verify that the passkey belongs to the current admin; mints no session. A failed or foreign passkey is 403 `{ code: 'reauth_failed' }`. |
| GET | `/api/auth/me` | allowExpiredAccess + requireAuth | Current user, 2FA/passkey/MFA flags, `broadcastOptOut`, `accessExpiresAt`, server-computed `accessExpired`, quota usage. In OpenAPI doc. |
| PUT | `/api/auth/email-preferences` | requireAuth | `{ broadcastOptOut: boolean }`. Audited. |
| POST | `/api/auth/2fa/setup` | requireAuthOrEnrollment + requireSession | Begin TOTP setup. While 2FA is on, needs `{ currentCode }` (current TOTP or recovery code); the active factor stays on until `/2fa/enable` confirms the new one. |
| POST | `/api/auth/2fa/enable` | requireAuthOrEnrollment + requireSession | `{ code }`; returns `{ recoveryCodes }`. Audited `auth.2fa_enabled`. |
| POST | `/api/auth/2fa/disable` | requireAuth + requireSession | `{ code }`. Audited `auth.2fa_disabled`. |
| GET | `/api/auth/2fa/status` | requireAuth + requireSession | TOTP status. |
| POST | `/api/auth/passkeys/auth/options` | public + authLimiter | Usernameless passkey login options; sets `proxmate_webauthn` cookie (5 min) holding a handle to the challenge, which stays server-side. Every passkey verify route accepts only a challenge the server issued for that ceremony (and user), once. |
| POST | `/api/auth/passkeys/auth/verify` | public + authLimiter | Verify assertion and issue a session. |
| POST | `/api/auth/passkeys/register/options` | requireAuthOrEnrollment + requireSession | Passkey registration options. |
| POST | `/api/auth/passkeys/register/verify` | requireAuthOrEnrollment + requireSession | `{ response, name? }`; stores the passkey. Audited `auth.passkey_added`. |
| GET | `/api/auth/passkeys` | requireAuth + requireSession | List caller's passkeys. |
| DELETE | `/api/auth/passkeys/:id` | requireAuth + requireSession | Remove a passkey. Audited `auth.passkey_removed`. |
| GET | `/api/auth/sso/info` | public | Whether to show an SSO button and its label. |
| GET | `/api/auth/sso/login` | public | Sets `proxmate_sso` cookie (state/nonce/PKCE, 10 min) and 302s to the IdP. |
| GET | `/api/auth/sso/callback` | public (SSO cookie) | Completes OIDC, sets session cookies, redirects to `FRONTEND_URL/`; errors redirect to `/login?sso_error=…`. |
| GET | `/api/auth/invite/:token` | public + publicTokenLimiter | Validate an invite; returns quotas, expiry, label, `require2fa`, `email` (the invited address or null); 404 if used/expired. |
| POST | `/api/auth/forgot-password` | public + authLimiter | `{ email }`. Email a reset link if SMTP is configured, else file an admin request; returns `{ method: 'email' or 'admin', message }`, where `method` reflects SMTP config only and the message does not reveal whether the account exists. |
| POST | `/api/auth/reset-password` | public + authLimiter | `{ token, password (min 8) }`. Returns `{ success, remainingPasskeys }` (names of passkeys that still sign in; the reset page lists them and points to Security to remove any). Audited `auth.password_reset`. |

# Gotchas

- All bodies are zod-validated (Register/Login/TwoFaVerify/KioskExit/EmailPrefs/TwoFaCode/PasskeyRegister/Forgot/Reset schemas).[^routes]
- Login hardening: locked accounts get the same generic 401 after a dummy bcrypt; each login reserves an attempt (`reserveLoginAttempt`) before bcrypt runs and a failure settles it with `registerFailedLogin`; correct passwords clear the password streak but never lift a lock in force, and the lock is re-checked after the password check so no challenge or session is issued while one holds (e.g. one applied by wrong 2FA codes during the request); bcrypt always runs so timing does not reveal account existence.[^routes]
- Compute-access gate (`loginRefusal`, admins exempt) runs on every session-minting path: password login (before 2FA/enrollment branches), 2FA verify, passkey login and SSO callback.[^routes]
- A `require2fa` user whose only factor is a passkey (`twoFactorEnabled=false`) cannot log in with a password alone (401 `passkey_required`), whether or not the account is SSO-linked; one with no factor yet gets an enrollment token instead of a session.[^routes]
- Register claims the invite atomically (`updateMany where usedById: null`) and deletes the just-created user if the claim loses a race. Access window starts at redemption. Email is lowercased and trimmed.[^routes]
- 2FA challenge JWT lives 5 min; enrollment token 15 min.[^authsvc] Outstanding challenges are tracked in process memory, so a backend restart ends any 2FA sign-in in progress.[^authsvc]
- Kiosk passkey exit never mints a session, so another person's passkey cannot swap the kiosk session.[^routes]

# Relationships

- Data: [User](/database/user.md), [Session](/database/session.md), [InviteToken](/database/invite-token.md), [Passkey](/database/passkey.md), [TwoFactorRecoveryCode](/database/two-factor-recovery-code.md), [PasswordResetToken](/database/password-reset-token.md), [PasswordResetRequest](/database/password-reset-request.md), [AuditLog](/database/audit-log.md).
- Services: [auth](/services/auth.md), [twofactor](/services/twofactor.md), [passkey](/services/passkey.md), [sso](/services/sso.md), [mfa](/services/mfa.md), [access](/services/access.md), [account-lockout](/services/account-lockout.md), [password-reset](/services/password-reset.md), [kiosk](/services/kiosk.md), [audit](/services/audit.md).
- Config: [SSO](/config/sso.md), [SMTP](/config/smtp.md). Cookie and CSRF model: [HTTP API](/api/http-api.md).

[^routes]: backend/src/routes/auth.routes.ts
[^app]: backend/src/app.ts
[^mw-auth]: backend/src/middleware/auth.ts
[^mw-enroll]: backend/src/middleware/enrollment.ts
[^authsvc]: backend/src/services/auth.service.ts
[^ratelimit]: backend/src/middleware/rate-limit.ts
