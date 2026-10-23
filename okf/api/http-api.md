---
type: API
title: ProxMate HTTP API
description: Overview of the ProxMate backend HTTP and WebSocket surface under /api, covering middleware order, cookie/JWT/API-token auth, CSRF, rate limits, OpenAPI and every router.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/app.ts
tags: [proxmate, api, http, auth, middleware]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T20:00:00Z }
sources:
  - id: app
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/app.ts
    title: backend/src/app.ts
  - id: index
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/index.ts
    title: backend/src/index.ts
  - id: mw-auth
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/middleware/auth.ts
    title: backend/src/middleware/auth.ts
  - id: mw-enroll
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/middleware/enrollment.ts
    title: backend/src/middleware/enrollment.ts
  - id: mw-mfa
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/middleware/mfa.ts
    title: backend/src/middleware/mfa.ts
  - id: mw-admin
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/middleware/admin.ts
    title: backend/src/middleware/admin.ts
  - id: mw-rl
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/middleware/rate-limit.ts
    title: backend/src/middleware/rate-limit.ts
  - id: mw-obs
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/middleware/observability.ts
    title: backend/src/middleware/observability.ts
  - id: mw-err
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/middleware/errorHandler.ts
    title: backend/src/middleware/errorHandler.ts
  - id: cookies
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/lib/cookies.ts
    title: backend/src/lib/cookies.ts
  - id: authsvc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/auth.service.ts
    title: backend/src/services/auth.service.ts
  - id: tokensvc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/api-token.service.ts
    title: backend/src/services/api-token.service.ts
  - id: openapi
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/lib/openapi.ts
    title: backend/src/lib/openapi.ts
  - id: apidoc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/docs/api.md
    title: docs/api.md
  - id: modules
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/modules/registry.ts
    title: backend/src/modules/registry.ts
  - id: ideproxy
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/ide-proxy.service.ts
    title: backend/src/services/ide-proxy.service.ts
---

# Purpose

The Express 5 backend serves a JSON REST API under `/api`, plus `/metrics`, an IDE reverse proxy, and WebSocket upgrades. The HTTP server listens on `PORT` (default 4000) and `BIND_ADDR` (default `0.0.0.0`). `requestTimeout` is 0 so large backup uploads do not time out; `keepAliveTimeout` is 65 s and `headersTimeout` 66 s.[^index]

# Middleware order

As registered in `app.ts`:[^app]

1. `app.set('trust proxy', TRUST_PROXY)` (default 0; a non-numeric value falls back to 0): number of trusted proxy hops (affects `req.ip`, rate limiting and the audit log's client IP).
2. `mountIdeProxy(app)`: claims only `/api/ide/:id/proxy/*`, streaming raw to in-guest code-server ahead of everything else (session cookie; VM owner only).[^ideproxy]
3. `observability`: per-request id (honours inbound `x-request-id`, else a UUID; echoed in the `x-request-id` response header), a latency histogram labelled by method, route and status, and one structured access-log line (skipped for `/api/health` and `/metrics`).[^mw-obs]
4. `express.json({ limit: '15mb' })` on `/api/ide/:id/llm`, then the [IDE gateway router](/api/ide-gateway.md) on `/api/ide`, before the shared parsers and write limiter.
5. `helmet()`.
6. `cors({ origin: FRONTEND_URL or 'http://localhost:3000', credentials: true })`.
7. `cookieParser()`.
8. `express.json({ limit: '1mb' })`.
9. `apiWriteLimiter` on `/api`: every method except GET/HEAD/OPTIONS, default 60 per 60 s per IP (`API_WRITE_RATE_LIMIT_MAX`, `API_WRITE_RATE_LIMIT_WINDOW_MS`).[^mw-rl]
10. Inline endpoints: `GET /api/health`, `GET /metrics`, `GET /api/openapi.json`.
11. Core routers (table below).
12. Optional module router at `/api/ext` (`MODULE_MOUNT_ROOT`), after all core routes so it cannot shadow them.
13. `errorHandler`: logs `reqId`, message and stack; always responds 500 `{ error: 'Internal server error' }`.[^mw-err]

# Authentication model

**Session (browser).** Login mints an HS256 JWT (`sub`, random `jti`, 24 h) signed with the `jwt_secret` config value, plus a `Session` row holding the token, a 32-byte hex CSRF token and `expiresAt`.[^authsvc] Cookies:[^cookies]

| Cookie | httpOnly | Purpose |
|---|---|---|
| `proxmate_session` | yes | The session JWT. |
| `proxmate_csrf` | no | CSRF token; the frontend echoes it in `X-CSRF-Token`. |
| `proxmate_webauthn` | yes | Opaque handle to a server-held WebAuthn challenge, 5 min. Each challenge is single-use and bound to its ceremony (login, registration, kiosk exit). |
| `proxmate_sso` | yes | OIDC state/nonce/PKCE verifier, 10 min. |

All are `SameSite=Lax`, `path=/`; `Secure` defaults to on when `NODE_ENV=production`, overridable with `COOKIE_SECURE`.[^cookies]

**`requireAuth`** order of checks:[^mw-auth]

1. If there is no session cookie and the Bearer value starts with `pm_`, it is a personal API token: `verifyApiToken` (HMAC-SHA256 keyed by `ENCRYPTION_KEY`, token-expiry check, owner access-window check, best-effort `lastUsedAt` update). 401 if invalid or expired; 403 with `code` `ACCESS_EXPIRED_CODE` if the owner's access window has lapsed, on every route (a token gets no `allowExpiredAccess` leniency).[^tokensvc]
2. Otherwise cookie, else Bearer, must be a valid session (JWT verified with algorithm pinned to HS256 and a non-expired `Session` row). Missing gives 401; invalid gives 401.
3. Lapsed compute-access window (non-admins): 403 with `code` `ACCESS_EXPIRED_CODE`, unless the route set `allowExpiredAccess` (only `GET /api/auth/me` and `POST /api/auth/logout`).
4. CSRF: cookie-authenticated POST/PUT/PATCH/DELETE must send `x-csrf-token` equal to the session's CSRF token, else 403. Bearer clients are exempt.

Other gates:

- `requireSession`: 403 when the caller authenticated with a `pm_` API token. Mounted after `requireAuth` on account-security routes (session refresh, 2FA, passkeys, kiosk exit, API-token management) and on the admin sign-in settings (user password reset, SSO config, kiosk PIN) and invite create/send/list.[^mw-auth]
- `requireAdmin`: `user.role === 'admin'`, else 403.[^mw-admin]
- `enforceMfaSetup`: 403 `{ code: 'mfa_setup_required' }` while an admin-required second factor is not enrolled.[^mw-mfa]
- `requireAuthOrEnrollment`: a real session (with CSRF) or a scoped enrollment Bearer token that is honoured only while MFA setup is still required and the access window is not lapsed. Used only by first-factor enrollment endpoints.[^mw-enroll]
- IDE gateway: per-VM gateway Bearer token (see [IDE gateway router](/api/ide-gateway.md)).
- Public token links: download tokens, broadcast unsubscribe HMAC tokens, invite tokens.

# Rate limits

| Limiter | Default | Env overrides | Applied to |
|---|---|---|---|
| `authLimiter` | 20 / 15 min | `AUTH_RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_WINDOW_MS` | credential POSTs in auth, mutating setup steps |
| `apiWriteLimiter` | 60 / 60 s | `API_WRITE_RATE_LIMIT_MAX`, `API_WRITE_RATE_LIMIT_WINDOW_MS` | all non-GET/HEAD/OPTIONS under `/api` |
| `publicTokenLimiter` | 60 / 15 min | `PUBLIC_TOKEN_RATE_LIMIT_MAX`, `PUBLIC_TOKEN_RATE_LIMIT_WINDOW_MS` | invite lookup, downloads |
| `shareLimiter` | 30 / 1 h per signed-in user | `SHARE_RATE_LIMIT_MAX`, `SHARE_RATE_LIMIT_WINDOW_MS` | `POST /api/vms/:id/shares` |
| `kioskExitLimiter` | 10 / 5 min | `KIOSK_EXIT_RATE_LIMIT_MAX`, `KIOSK_EXIT_RATE_LIMIT_WINDOW_MS` | kiosk exit |
| `gatewayAuthLimiter` | 600 / 60 s | `IDE_GATEWAY_RATE_LIMIT_MAX`, `IDE_GATEWAY_RATE_LIMIT_WINDOW_MS` | IDE LLM gateway |
| `moduleLimiter` | 300 / 60 s (reads too) | `MODULE_RATE_LIMIT_MAX`, `MODULE_RATE_LIMIT_WINDOW_MS` | `/api/ext/<module>` |

All are IP-keyed except `shareLimiter`, which is keyed by the signed-in user; all send `draft-7` `RateLimit-*` headers and 429 JSON errors. A non-numeric env value falls back to the default.[^mw-rl]

# Endpoints

Inline in `app.ts`:[^app]

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | public | DB check `SELECT 1`; `?deep=1` also probes Proxmox (unreachable is reported, not a failure). 200 `ok` or 503 `degraded`. |
| GET | `/metrics` | `METRICS_TOKEN` Bearer | Prometheus metrics. In production returns 404 unless `METRICS_TOKEN` is set; 401 on a wrong token. |
| GET | `/api/openapi.json` | public | OpenAPI 3.1 document. |

# Routers

| Mount | Router concept | Router-level auth |
|---|---|---|
| `/api/setup` | [setup](/api/setup.md) | none for `/status` and step 1 (`/admin`); requireAuth + requireAdmin for later steps (authLimiter on writes; locked after completion) |
| `/api/auth` | [auth](/api/auth.md) | per route |
| `/api/invites` | [invite](/api/invite.md) | requireAuth + requireAdmin (+ requireSession on create/send/list) |
| `/api/vms` | [vm](/api/vm.md) | requireAuth + enforceMfaSetup |
| `/api/projects` | [project](/api/project.md) | requireAuth + enforceMfaSetup |
| `/api/proxmox` | [proxmox](/api/proxmox.md) | requireAuth + enforceMfaSetup |
| `/api/users` | [user](/api/user.md) | requireAuth + requireAdmin + enforceMfaSetup |
| `/api/admin` | [admin](/api/admin.md) | requireAuth + requireAdmin + enforceMfaSetup |
| `/api/ide` (early) | [ide-gateway](/api/ide-gateway.md) | none; per-route gateway token |
| `/api/ide` | [ide](/api/ide.md) | requireAuth |
| `/api/templates` | [template](/api/template.md) | requireAuth + enforceMfaSetup (+ requireAdmin per route) |
| `/api/ssh-keys` | [ssh-key](/api/ssh-key.md) | requireAuth |
| `/api/api-tokens` | [api-token](/api/api-token.md) | requireAuth + requireSession |
| `/api/quota-requests` | [quota-request](/api/quota-request.md) | requireAuth |
| `/api/passthrough-requests` | [passthrough-request](/api/passthrough-request.md) | requireAuth + enforceMfaSetup |
| `/api/downloads` | [download](/api/download.md) | none; single-use token |
| `/api/broadcast` | [broadcast](/api/broadcast.md) | none; HMAC token |
| WS upgrade | [console](/api/console.md) | session cookie + Origin |
| `/api/ext/<name>` | optional modules | moduleLimiter + requireAuth unless the module declares `auth: 'none'` (logged as a warning)[^modules] |

# WebSocket endpoints

One `upgrade` dispatcher in `index.ts` tries `handleConsoleUpgrade` then `handleIdeUpgrade`, else destroys the socket.[^index]

- `/api/vms/:id/console` and `/api/vms/:id/serial`: noVNC / xterm.js relays, session cookie + exact `FRONTEND_URL` Origin + `console` capability. See [console](/api/console.md).
- `/api/ide/:id/proxy/*`: code-server WebSocket, session cookie + VM owner + IDE target resolution; lenient Origin check (missing Origin, `FRONTEND_URL`, or `http(s)://<Host>`).[^ideproxy]

Both use `verifyToken`, which treats a lapsed access window as unauthenticated.[^authsvc]

# OpenAPI document

`GET /api/openapi.json` serves `openApiSpec`: OpenAPI 3.1.0, `servers: [{ url: '/api' }]`, a `bearerAuth` scheme for personal API tokens, schemas `Vm`, `VmCreate`, `Error`. It intentionally documents only the stable tenant surface (`/auth/me`, `/vms`, `/vms/{id}`, start/stop/restart/rebuild, `/templates`, `/templates/deploy`, `/proxmox/isos`) and omits admin/setup.[^openapi] `docs/api.md` is the human guide with curl examples.[^apidoc]

# Gotchas

- `docs/api.md` says tokens are stored as a SHA-256 hash; the code uses HMAC-SHA256 peppered with `ENCRYPTION_KEY`, so rotating `ENCRYPTION_KEY` invalidates all API tokens.[^apidoc][^tokensvc]
- Validation errors across routers follow `{ error: 'Validation failed', details: zodError.flatten() }` with 400; Proxmox failures are usually 502 with `pveMessage(err)`.
- The IDE gateway and IDE proxy are mounted before helmet/CORS/JSON parsing on purpose; adding global middleware above them changes their behaviour.[^app]
- Behind a reverse proxy, set `TRUST_PROXY` or every client shares one rate-limit bucket.[^app]

# Relationships

- Environment: [backend environment](/env/backend-environment.md), [docker environment](/env/docker-environment.md).
- Data: [Session](/database/session.md), [ApiToken](/database/api-token.md), [IdeGatewayToken](/database/ide-gateway-token.md), [User](/database/user.md), [SystemConfig](/database/system-config.md) (`jwt_secret`; see [platform secrets](/config/platform-secrets.md)).
- Services: [auth](/services/auth.md), [api-token](/services/api-token.md), [mfa](/services/mfa.md), [access](/services/access.md), [ide-proxy](/services/ide-proxy.md).

[^app]: backend/src/app.ts
[^index]: backend/src/index.ts
[^mw-auth]: backend/src/middleware/auth.ts
[^mw-enroll]: backend/src/middleware/enrollment.ts
[^mw-mfa]: backend/src/middleware/mfa.ts
[^mw-admin]: backend/src/middleware/admin.ts
[^mw-rl]: backend/src/middleware/rate-limit.ts
[^mw-obs]: backend/src/middleware/observability.ts
[^mw-err]: backend/src/middleware/errorHandler.ts
[^cookies]: backend/src/lib/cookies.ts
[^authsvc]: backend/src/services/auth.service.ts
[^tokensvc]: backend/src/services/api-token.service.ts
[^openapi]: backend/src/lib/openapi.ts
[^apidoc]: docs/api.md
[^modules]: backend/src/modules/registry.ts
[^ideproxy]: backend/src/services/ide-proxy.service.ts
