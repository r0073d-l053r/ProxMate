---
type: API Router
title: API token router
description: Lists, creates and revokes the caller's personal API tokens (pm_ prefixed Bearer credentials) under /api/api-tokens.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/api-token.routes.ts
tags: [proxmate, api, auth, api-tokens]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/api-token.routes.ts
    title: backend/src/routes/api-token.routes.ts
  - id: app
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/app.ts
    title: backend/src/app.ts
  - id: svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/api-token.service.ts
    title: backend/src/services/api-token.service.ts
---

# Purpose

Self-service management of personal API tokens used by scripts, CLIs and Terraform. Mounted at `/api/api-tokens`.[^app]

# Authentication

- `router.use(requireAuth)` on every route.[^routes]
- A second router-level guard, `requireSession`, returns **403** `API tokens cannot manage account security — use the web app.` when the caller authenticated with an API token (`isApiToken(req.sessionToken)`), so a leaked token cannot mint or revoke tokens. A real browser (or session-JWT Bearer) session is required.[^routes]
- No `enforceMfaSetup` on this router.
- Mutating requests are subject to the global `apiWriteLimiter` and (for cookie auth) CSRF via `requireAuth`. See [HTTP API](/api/http-api.md).

# Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/api-tokens` | session (not API token) | List the caller's tokens (no secrets). |
| POST | `/api/api-tokens` | session (not API token) | Create a token; body `{ name }`. Returns 201 with the raw token, shown once. Audited `apitoken.create`. |
| DELETE | `/api/api-tokens/:id` | session (not API token) | Revoke one of the caller's tokens; 404 if not theirs/not found. Audited `apitoken.revoke`. |

# Gotchas

- Body validated with zod `CreateSchema = { name: string 1..60 }`; the name is trimmed before storing. Failure returns 400 `{ error: 'Validation failed', details }`.[^routes]
- Tokens are stored as an HMAC-SHA256 of the raw value keyed by `ENCRYPTION_KEY` (not plain SHA-256); hashing throws if `ENCRYPTION_KEY` is unset.[^svc]
- The raw token is only in the POST response; listings expose only the display prefix, `lastUsedAt`, `expiresAt`, `createdAt`.[^svc]

# Relationships

- Persists [ApiToken](/database/api-token.md) rows owned by a [User](/database/user.md).
- Logic in the [api-token service](/services/api-token.md); writes [audit log](/database/audit-log.md) entries via the [audit service](/services/audit.md).
- Tokens are accepted by `requireAuth` across the [HTTP API](/api/http-api.md).

[^routes]: backend/src/routes/api-token.routes.ts
[^app]: backend/src/app.ts
[^svc]: backend/src/services/api-token.service.ts
