---
type: Configuration Group
title: SSO (OIDC) settings
description: SystemConfig keys configuring OpenID Connect single sign-on, including the issuer, client credentials, scopes, group-to-admin mapping, JIT sign-up and login button text.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/sso.service.ts
tags: [proxmate, config, sso, oidc, auth]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: sso
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/sso.service.ts
    title: backend/src/services/sso.service.ts
  - id: admin-routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/admin.routes.ts
    title: backend/src/routes/admin.routes.ts
  - id: auth-routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/auth.routes.ts
    title: backend/src/routes/auth.routes.ts
---

# Purpose

These keys configure OIDC login through `openid-client`. `getSsoConfig()` returns `null` unless **both** `sso_issuer` and `sso_client_id` are set. SSO is usable only when it is configured **and** `sso_enabled` is `"true"` (`isSsoEnabled`).[^sso] Only an admin can change them, through `PUT /api/admin/settings/sso` ([admin API](/api/admin.md)). Login itself runs through `GET /api/auth/sso/info`, `/sso/login` and `/sso/callback` ([auth API](/api/auth.md)).[^auth-routes]

# Schema

| Key | Value format | Default / when unset | Written by | Read by | Description |
|---|---|---|---|---|---|
| `sso_enabled` | `"true"` / `"false"` | zod default `false`; a missing row reads as disabled | `saveSsoConfig` ← `PUT /api/admin/settings/sso` | `getSsoConfig` / `isSsoEnabled` / `getPublicSsoInfo` | Master switch for the SSO login button and flow. |
| `sso_issuer` | URL (zod `z.string().url()`), trimmed | Unset: SSO counts as unconfigured (`getSsoConfig` returns null) | same | `getSsoConfig`; OIDC discovery (`oidc.discovery(new URL(issuer), …)`) | IdP issuer URL; `.well-known/openid-configuration` and the JWKS are fetched from it. |
| `sso_client_id` | string min 1, trimmed | Unset: unconfigured | same | `getSsoConfig`, discovery | OIDC client id. |
| `sso_client_secret` | string. **Secret, stored encrypted** (`sensitive=true`) | Unset: discovery throws `SSO client secret is not set.` | same, but only when `clientSecret` is non-blank (blank keeps the existing value) | `getOidcConfig` only. Admin settings expose just `sso.hasSecret` | OIDC client secret. |
| `sso_scopes` | space-separated scopes | `openid profile email` (written as the default when blank, and used as the fallback when the row is empty) | same | `getSsoConfig` | Requested scopes. |
| `sso_groups_claim` | claim name | `groups` | same | `getSsoConfig`, `completeLogin` (array or single string accepted) | ID-token claim that group membership is read from. |
| `sso_admin_group` | group name or `''` | `''`: no group-to-admin mapping | same | `getSsoConfig`; admin-role check `isAdminByGroup` (`!!cfg.adminGroup && (claims.groups ?? []).includes(cfg.adminGroup)`) | Membership in this group promotes the user to the admin role; it never demotes. |
| `sso_allow_signup` | `"true"` / `"false"` | `false` (`data.allowSignup ?? false`) | same | `getSsoConfig`; `upsertSsoUser` (called from `completeLogin`) refuses unknown users when it is false | JIT-provision brand-new users. Off means invite/link-only. |
| `sso_button_label` | string | `Sign in with SSO` | same | `getSsoConfig`, `getPublicSsoInfo` (public login page) | Text on the login button. |

# Validation

`SsoSchema` (admin.routes.ts): `enabled` boolean default false, `issuer` url, `clientId` min 1, and optional `clientSecret`, `scopes`, `groupsClaim`, `adminGroup`, `allowSignup`, `buttonLabel`.[^admin-routes]

# Gotchas

- Every save calls `resetOidcCache()`. The discovery cache is keyed on issuer plus client id. `POST /api/admin/settings/sso/test` runs `verifyDiscovery()` and fails if the issuer, secret or network is wrong.[^sso]
- The callback URL does **not** come from SystemConfig. It is `${BACKEND_PUBLIC_URL || http://localhost:${PORT || 4000}}/api/auth/sso/callback`, and that URL must be registered in the IdP. `GET /api/admin/settings` returns it as `sso.callbackUrl`.[^sso] See [backend environment](/env/backend-environment.md).
- `GET /api/admin/settings` never returns the client secret.[^admin-routes]

[^sso]: backend/src/services/sso.service.ts (`getSsoConfig`, `saveSsoConfig`, `getOidcConfig`, `callbackUrl`, `DEFAULTS`)
[^admin-routes]: backend/src/routes/admin.routes.ts (`SsoSchema`, `PUT /settings/sso`, `POST /settings/sso/test`)
[^auth-routes]: backend/src/routes/auth.routes.ts (`/sso/info`, `/sso/login`, `/sso/callback`)
