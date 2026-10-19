---
type: API Router
title: Backup download router
description: Public single-use token endpoint that streams a MateState vzdump backup file, mounted at /api/downloads.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/download.routes.ts
tags: [proxmate, api, backups, download, public]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/download.routes.ts
    title: backend/src/routes/download.routes.ts
  - id: app
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/app.ts
    title: backend/src/app.ts
  - id: ratelimit
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/middleware/rate-limit.ts
    title: backend/src/middleware/rate-limit.ts
---

# Purpose

Serves backup archives from emailed download links. Links are requested via `POST /api/vms/:id/matestates/:msid/download` (see [VM router](/api/vm.md)). Mounted at `/api/downloads` with no session.[^app]

# Authentication

- No session. The single-use token in the URL is the credential.[^routes]
- `publicTokenLimiter` on the route: default 60 requests per 15 min per IP (`PUBLIC_TOKEN_RATE_LIMIT_MAX`, `PUBLIC_TOKEN_RATE_LIMIT_WINDOW_MS`).[^ratelimit]

# Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/downloads/:token` | single-use token + `publicTokenLimiter` | Consumes the token (`consumeDownloadToken`) and streams the file as `application/octet-stream` with `Content-Disposition: attachment`. |

# Gotchas

- The token must match `/^[a-f0-9]{64}$/` before any DB lookup; otherwise 404.[^routes]
- Any invalid, expired or spent token returns a generic 404 so the endpoint is not a guessing oracle; non-`DownloadError` failures return 500.[^routes]
- Consuming the token happens before streaming, so a failed/aborted transfer still spends it (inferred from call order).
- `pruneDownloadTokens()` runs opportunistically after each successful token consumption, fire-and-forget.[^routes]
- On client abort the file read stream is destroyed so multi-GB vzdumps are not read into a closed socket.[^routes]
- The filename header uses `path.basename(filename)`.

# Relationships

- Backed by [DownloadToken](/database/download-token.md) and [MateState](/database/mate-state.md) via the [download service](/services/download.md).
- Link issuance lives in the [VM router](/api/vm.md); backups themselves in the [matestate service](/services/matestate.md).
- Overall surface: [HTTP API](/api/http-api.md).

[^routes]: backend/src/routes/download.routes.ts
[^app]: backend/src/app.ts
[^ratelimit]: backend/src/middleware/rate-limit.ts
