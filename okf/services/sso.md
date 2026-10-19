---
type: Backend Service
title: SSO service (OpenID Connect)
description: OIDC authorization-code + PKCE login via openid-client, cached discovery, and mapping of ID-token claims to a local user with optional JIT provisioning and admin-group promotion.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/sso.service.ts
tags: [proxmate, auth, sso, oidc]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: sso
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/sso.service.ts
    title: backend/src/services/sso.service.ts
---

# Purpose

Single sign-on against any OIDC provider (e.g. Keycloak).[^sso]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `callbackUrl` | `() => string` | `<BACKEND_PUBLIC_URL or http://localhost:PORT>/api/auth/sso/callback`; must be registered at the IdP. |
| `getSsoConfig` | `() => SsoConfig \| null` | Null unless issuer and client id are set; never includes the secret. Defaults: scopes `openid profile email`, groups claim `groups`, label `Sign in with SSO`. |
| `isSsoEnabled` / `getPublicSsoInfo` | `()` | Enabled flag; `{ enabled, label }` for the login page. |
| `saveSsoConfig` | `(data)` | Writes keys; `sso_client_secret` only when supplied, encrypted; resets the discovery cache. |
| `hasClientSecret` | `()` | Whether a secret is stored. |
| `verifyDiscovery` | `()` | Admin "Test": fresh discovery (`.well-known` + JWKS). |
| `beginLogin` | `() => { url, cookie }` | PKCE S256 verifier, state, nonce; cookie value is JSON `{ state, nonce, codeVerifier }`. |
| `completeLogin` | `(currentUrl, cookieValue) => User` | `authorizationCodeGrant` validating state, PKCE, nonce, signature, issuer, audience, expiry; normalises claims. |
| `upsertSsoUser` | `(claims, cfg) => User` | Link by `ssoSubject`, else link by email (only when the ID token has `email_verified: true` and the account has `emailBound`; otherwise throws, telling the user to sign in with their password), else JIT-create if `allowSignup`; promote to admin by group. |

# Data

- SystemConfig `sso_issuer`, `sso_client_id`, `sso_client_secret` (sensitive), `sso_enabled`, `sso_scopes`, `sso_groups_claim`, `sso_admin_group`, `sso_allow_signup`, `sso_button_label` — see [sso config](/config/sso.md).[^sso]
- [User](/database/user.md): `ssoSubject`, `emailBound`, `email`, `displayName`, `role`, `passwordHash`.
- Env `BACKEND_PUBLIC_URL`, `PORT`.

# Gotchas

- Admin group membership can PROMOTE but never auto-demotes (to avoid lockout); removing someone from the IdP admin group does not revoke ProxMate admin.[^sso]
- Linking by email: an existing local account with the same email is bound to the IdP subject on first SSO login only when the ID token asserts `email_verified: true` and the account's `emailBound` is true (addressed invite, setup-wizard admin, or SSO sign-up with a verified email). Otherwise the login is refused. Upgrade impact: accounts registered before `emailBound` existed with a self-typed address, and every account when the IdP omits `email_verified`, never auto-link; those users keep signing in with their password. There is no self-service link flow.[^sso]
- JIT users get an unusable random bcrypt password.[^sso]
- Discovery is cached in-process keyed by issuer + client id.[^sso]
- The access-window refusal is applied by the auth router after this returns (see [access](/services/access.md)).

# Relationships

- Called by the [auth router](/api/auth.md) and [admin router](/api/admin.md).
- Uses [config](/services/config.md) and [auth service](/services/auth.md). [mfa](/services/mfa.md) exempts SSO users from mandated 2FA.

[^sso]: backend/src/services/sso.service.ts
