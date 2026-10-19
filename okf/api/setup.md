---
type: API Router
title: Setup wizard router
description: First-run wizard (create admin, then admin-session-gated Proxmox connection, defaults, finalize) that locks itself once setup_complete is set, mounted at /api/setup.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/setup.routes.ts
tags: [proxmate, api, setup, onboarding]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/setup.routes.ts
    title: backend/src/routes/setup.routes.ts
  - id: app
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/app.ts
    title: backend/src/app.ts
  - id: ratelimit
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/middleware/rate-limit.ts
    title: backend/src/middleware/rate-limit.ts
  - id: setupsvc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/setup.service.ts
    title: backend/src/services/setup.service.ts
---

# Purpose

The first-run wizard. Mounted at `/api/setup`.[^app]

# Authentication

- Open only until setup is complete. Step 1 (`/admin`) needs no session; every later step requires the admin's session (`requireAuth` + `requireAdmin`, so cookie callers also send the CSRF header).[^routes]
- Router-level: non-GET/HEAD/OPTIONS requests pass `authLimiter` (default 20 per 15 min per IP, env `AUTH_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_WINDOW_MS`); GET `/status` is never throttled because the frontend auth guard polls it.[^routes][^ratelimit]
- After `/status`, a guard returns 403 `Setup already completed` for every route once `isSetupComplete()` is true.[^routes]

# Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/setup/status` | public | `{ setupComplete, adminExists }`. Always reachable. |
| POST | `/api/setup/admin` | public, pre-completion | Step 1: create the admin `{ email, password (min 8), displayName (1..100) }`; sets session + CSRF cookies. |
| POST | `/api/setup/proxmox` | admin session, pre-completion | Step 2: save `{ host (URL), tokenId, tokenSecret, verifySsl (default true) }`. |
| POST | `/api/setup/proxmox/test` | admin session, pre-completion | Step 2b: test the saved connection; 502 `{ connected: false, error }` on failure. |
| GET | `/api/setup/proxmox/resources` | admin session, pre-completion | Step 3: `{ storages, bridges, nodeCount, isoStorages, backupStorages }` for choosing defaults; `bridges` is `getGuestNetworks()` output (Linux/OVS bridges and SDN VNets, each with the nodes it exists on); 502 on failure.[^setupsvc] |
| POST | `/api/setup/defaults` | admin session, pre-completion | Step 3b: save `{ storage, bridge, isoStorage }`; `storage`/`isoStorage` non-empty, `bridge` trimmed and matching `NETWORK_NAME_RE` (letter first, then letters/digits/`.`/`_`/`-`, max 32). |
| POST | `/api/setup/complete` | admin session, pre-completion | Step 4: finalize; mints no new session (the caller keeps its step-1 session); returns `{ user, redirectTo: '/' }` for the calling admin. |

# Gotchas

- All bodies are zod-validated (`AdminSchema`, `ProxmoxConfigSchema`, `DefaultsSchema`); 400 with `details` on failure.[^routes]
- An operator who lost the step-1 session signs in through `/api/auth/login` and continues the wizard; without a session, steps 2-4 return 401.[^routes]
- `/admin` errors are 400 with the error message; `/proxmox`, `/defaults`, `/complete` errors are 500; Proxmox reachability errors are 502.

# Relationships

- Logic in the [setup service](/services/setup.md); writes [SystemConfig](/database/system-config.md) keys (see [Proxmox connection](/config/proxmox-connection.md), [provisioning defaults](/config/provisioning-defaults.md)) and the first [User](/database/user.md) / [Session](/database/session.md).
- Cookies: see [HTTP API](/api/http-api.md). Post-setup changes go through the [admin router](/api/admin.md).

[^routes]: backend/src/routes/setup.routes.ts
[^app]: backend/src/app.ts
[^ratelimit]: backend/src/middleware/rate-limit.ts
[^setupsvc]: backend/src/services/setup.service.ts
