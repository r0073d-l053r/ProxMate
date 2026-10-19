---
type: Backend Service
title: API-token service (personal access tokens)
description: Mints, lists, revokes and verifies `pm_`-prefixed personal API tokens stored only as an HMAC-SHA256 hash peppered with ENCRYPTION_KEY.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/api-token.service.ts
tags: [proxmate, auth, api-token, security]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: token
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/api-token.service.ts
    title: backend/src/services/api-token.service.ts
---

# Purpose

Bearer tokens for the public REST API (CLI, Terraform, scripts). A raw token is `pm_` + 24 random bytes base64url; it is returned once at creation and never stored in clear.[^token]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `isApiToken` | `(bearer) => boolean` | True when the bearer starts with `pm_` (vs a session JWT). |
| `createApiToken` | `(userId, name) => Promise<{ id, name, token, createdAt }>` | Generates the secret, stores `tokenHash` and display `prefix` (first 11 chars). |
| `listApiTokens` | `(userId)` | Non-secret metadata: `id, name, prefix, lastUsedAt, expiresAt, createdAt`, newest first. |
| `revokeApiToken` | `(userId, id) => Promise<boolean>` | `deleteMany` scoped to the owner; false if not theirs. |
| `verifyApiToken` | `(raw) => Promise<AuthUser \| null>` | Looks up by hash; rejects unknown, expired (`expiresAt`) and access-expired owners; updates `lastUsedAt` fire-and-forget. |

# Data

- [ApiToken](/database/api-token.md): `tokenHash` (unique lookup), `prefix`, `expiresAt`, `lastUsedAt`.[^token]
- [User](/database/user.md): `id, email, role, displayName, accessExpiresAt`.
- Env `ENCRYPTION_KEY` (see [backend environment](/env/backend-environment.md)).

# Gotchas

- Hash is HMAC-SHA256 keyed by `ENCRYPTION_KEY`: fast (192-bit random secret, so a slow KDF would only add latency) and deterministic (lookup by value). The pepper binds hashes to the deployment; it throws if `ENCRYPTION_KEY` is unset rather than using a static pepper.[^token]
- Rotating `ENCRYPTION_KEY` invalidates every existing API token (hashes no longer match).[^token]
- A personal token never reaches `requireAuth`'s session path, so the access-window check is done here; without it a token would outlive its owner's suspension.[^token]

# Relationships

- Called by the [api-token router](/api/api-token.md) and the auth middleware.
- Uses [access service](/services/access.md) `isAccessExpired`.

[^token]: backend/src/services/api-token.service.ts
