---
type: API Router
title: IDE LLM gateway router
description: OpenAI-compatible LLM proxy that the in-guest AI agent calls with a per-VM gateway Bearer token at /api/ide/:id/llm/v1.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/ide-gateway.routes.ts
tags: [proxmate, api, ide, llm, gateway]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/ide-gateway.routes.ts
    title: backend/src/routes/ide-gateway.routes.ts
  - id: app
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/app.ts
    title: backend/src/app.ts
  - id: ratelimit
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/middleware/rate-limit.ts
    title: backend/src/middleware/rate-limit.ts
---

# Purpose

Server-to-server surface for the AI agent (OpenCode) running inside an IDE-enabled guest. It lists the models the VM owner may use and forwards chat completions to the real upstream, rewriting the model name and injecting the upstream API key.[^routes]

Mounted at `/api/ide` **before** helmet, CORS, cookie-parser, the 1 MB JSON parser and `apiWriteLimiter`, with its own `express.json({ limit: '15mb' })` on `/api/ide/:id/llm`.[^app]

# Authentication

- **No router-level middleware**, so non-`/llm/` paths fall through to the session-authed [IDE router](/api/ide.md).[^routes]
- Each handler chains `gatewayAuthLimiter` (IP-keyed, default 600 req / 60 s, env `IDE_GATEWAY_RATE_LIMIT_MAX` / `IDE_GATEWAY_RATE_LIMIT_WINDOW_MS`) then `requireGatewayToken`.[^ratelimit]
- `requireGatewayToken` verifies `Authorization: Bearer <gateway token>` scoped to the `:id` VM (`verifyGatewayToken(bearer, vmId)`); failure is 401 in OpenAI error shape.[^routes] The service also rejects revoked/expired tokens, a lapsed owner access window, a VM without the `ide` capability, and an IDE tier that excludes the user's role.
- Then an in-memory per-VM fixed window: 120 requests / 60 s, 429 `rate_limit_error` beyond.[^routes]
- No cookies, therefore no CSRF.

# Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/ide/:id/llm/v1/models` | gateway token (VM-scoped) | `{ object: 'list', data }` of models the token's user may use (admin `shared:*` and visibility-filtered `local:*` models, plus `byo:*` when BYO keys are on; empty when the IDE is unavailable to the user's role). Never leaks upstream URLs, keys or real model names. |
| POST | `/api/ide/:id/llm/v1/chat/completions` | gateway token (VM-scoped) | Resolves `body.model` with `resolveModelRoute` (403 `Model not available` if not allowed), replaces `model` with the upstream name, POSTs to `<route.url>/chat/completions` with `Bearer route.apiKey` (header omitted when the route has no key). Streams SSE through when `stream: true`. |

# Gotchas

- Errors use OpenAI shape `{ error: { message, type } }`, not ProxMate's `{ error: string }`.[^routes]
- Upstream status and `content-type` are passed through; upstream network failure gives 502 `api_error` (or just ends the response if headers were already sent).[^routes]
- No zod validation; `body.model` is taken only if it is a string.
- The per-VM counter is process-local memory, so it resets on restart and is not shared across instances.[^routes]
- Gateway base URL handed to guests must be https in production; see `publicBaseUrl` in the [IDE router](/api/ide.md).

# Relationships

- Tokens: [IdeGatewayToken](/database/ide-gateway-token.md); BYO upstreams: [TenantLlmKey](/database/tenant-llm-key.md).
- Logic in the [ide-gateway service](/services/ide-gateway.md); policy from [IDE config](/config/ide.md).
- Token minting: `POST /api/ide/:id/gateway-token` in the [IDE router](/api/ide.md).

[^routes]: backend/src/routes/ide-gateway.routes.ts
[^app]: backend/src/app.ts
[^ratelimit]: backend/src/middleware/rate-limit.ts
