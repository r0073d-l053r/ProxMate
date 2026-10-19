---
type: Architecture
title: ProxMate backend and system architecture
description: How ProxMate is put together - Express 5 + Prisma/SQLite backend entrypoints and middleware order, route → service → proxmox.service/Prisma layering, scheduler jobs, the optional module seam, the Next.js frontend route groups, the in-guest IDE, and Docker Compose deployment.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/app.ts
tags: [proxmate, architecture, backend, deployment, overview]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T20:00:00Z }
sources:
  - id: index
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/index.ts
    title: backend/src/index.ts
  - id: app
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/app.ts
    title: backend/src/app.ts
  - id: sch
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/scheduler.service.ts
    title: backend/src/services/scheduler.service.ts
  - id: modules
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/modules/registry.ts
    title: backend/src/modules/registry.ts
  - id: modreadme
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/modules/README.md
    title: backend/src/modules/README.md
  - id: compose
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/docker-compose.yml
    title: docker-compose.yml
  - id: entry
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/docker-entrypoint.sh
    title: backend/docker-entrypoint.sh
  - id: install
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/install.sh
    title: install.sh
  - id: idedocker
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/ide/Dockerfile
    title: ide/Dockerfile
  - id: arch
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/project-architecture.md
    title: project-architecture.md
---

# Purpose

ProxMate is an invite-only, self-service cloud dashboard on top of Proxmox VE. Tenants get quota-limited VMs/containers through a Next.js UI; the Express API is the only component that holds the Proxmox API token, and it talks to Proxmox over HTTPS (REST) and WSS (consoles). State lives in a single SQLite file through Prisma.[^arch][^compose]

# Entrypoints

`backend/src/index.ts`:[^index]

1. Loads `.env`; if `ENCRYPTION_KEY` is missing, generates 32 random bytes hex and writes it into `.env` (mode 0600) when that file exists and `NODE_ENV` is not `production`; otherwise exits with instructions (compose REQUIRES it to be set).
2. Creates `http.Server(app)` with `requestTimeout = 0` (multi-GB backup uploads), `keepAliveTimeout = 65s`, `headersTimeout = 66s`.
3. One `upgrade` dispatcher: console relay (`handleConsoleUpgrade`, `/console` + `/serial`), then the IDE proxy (`handleIdeUpgrade`, `/api/ide/:id/proxy`), else destroy the socket.
4. `await loadModules()` BEFORE listen; a broken named module exits the process.
5. `listen(PORT=4000, BIND_ADDR=0.0.0.0)`, then `startScheduler()` and `reconcileInterruptedPassthroughApplies()`.

`backend/src/app.ts` middleware order (order is load-bearing):[^app]

| Order | Mount | Notes |
|---|---|---|
| 0 | `trust proxy` = `TRUST_PROXY` (default 0) | Real client IP for rate limits. |
| 1 | `mountIdeProxy(app)` | Claims `/api/ide/:id/proxy/*` before any body parsing or helmet. |
| 2 | `observability` | Request id, access log, latency metric. |
| 3 | `/api/ide/:id/llm` JSON 15 MB + `ideGatewayRoutes` | Bearer LLM gateway, before the 1 MB cap and write limiter. |
| 4 | `helmet`, `cors(FRONTEND_URL, credentials)`, `cookieParser`, `express.json({ limit: '1mb' })`, `/api` `apiWriteLimiter` | Shared middleware. |
| 5 | `GET /api/health` (`?deep=1` also probes Proxmox), `GET /metrics` (Bearer `METRICS_TOKEN`; 404 in production when unset), `GET /api/openapi.json` | Health and observability. |
| 6 | Routers | See table below. |
| 7 | `/api/ext` module router | After all core routes, before the error handler. |
| 8 | `errorHandler` | Flattens thrown errors. |

| Mount | Router doc |
|---|---|
| `/api/setup` | [setup](/api/setup.md) |
| `/api/auth` | [auth](/api/auth.md) |
| `/api/invites` | [invite](/api/invite.md) |
| `/api/vms` | [vm](/api/vm.md) |
| `/api/proxmox` | [proxmox](/api/proxmox.md) |
| `/api/users` | [user](/api/user.md) |
| `/api/admin` | [admin](/api/admin.md) |
| `/api/ide` | [ide](/api/ide.md) (session) and [ide-gateway](/api/ide-gateway.md) (bearer, mounted earlier) |
| `/api/templates` | [template](/api/template.md) |
| `/api/ssh-keys` | [ssh-key](/api/ssh-key.md) |
| `/api/api-tokens` | [api-token](/api/api-token.md) |
| `/api/quota-requests` | [quota-request](/api/quota-request.md) |
| `/api/passthrough-requests` | [passthrough-request](/api/passthrough-request.md) |
| `/api/downloads` | [download](/api/download.md) (public, token-authenticated) |
| `/api/broadcast` | [broadcast](/api/broadcast.md) (public, HMAC unsubscribe) |
| HTTP upgrade | [console](/api/console.md) |

# Layers

- **Routes** (`backend/src/routes/*.routes.ts`) validate input, apply `requireAuth` / `requireAdmin` / MFA / enrollment middleware (`backend/src/middleware/`), and map service errors to HTTP status codes.
- **Services** (`backend/src/services/*.service.ts`, documented under `/services/`) hold business rules: quota, ownership/capabilities ([vm](/services/vm.md), [vm-share](/services/vm-share.md)), access windows ([access](/services/access.md)), locks ([deploy-lock](/services/deploy-lock.md), [ide-provision](/services/ide-provision.md)).
- **Proxmox adapter**: [proxmox service](/services/proxmox.md) wraps the PVE REST API with an axios client built from the stored token (see [PVE API surface](/proxmox/pve-api-surface.md), [privileges](/proxmox/privileges.md)).
- **Persistence**: Prisma singleton `backend/src/lib/prisma.ts` over SQLite (`DATABASE_URL=file:/data/proxmate.db` in compose); models under `/database/`. Runtime settings are rows in [SystemConfig](/database/system-config.md) read through [config service](/services/config.md); sensitive rows are AES-256-GCM encrypted with `ENCRYPTION_KEY` (`backend/src/lib/crypto.ts`).[^compose]
- **Lib**: `cookies.ts`, `crypto.ts`, `email-templates.ts`, `logger.ts`, `metrics.ts` (Prometheus registry), `openapi.ts`, `url-safety.ts` (SSRF guards).

# Scheduler jobs

All jobs run in-process via node-cron, started from `index.ts`; each has its own in-memory "running" flag. Details in [scheduler](/services/scheduler.md).[^sch]

| Job | Schedule (default / env) | Service |
|---|---|---|
| Weekly guest backups (+ catch-up 10 s after boot) | `0 3 * * 0` / `MATESTATE_CRON` | [matestate](/services/matestate.md) |
| Per-VM power schedules | `* * * * *` | [power-schedule](/services/power-schedule.md) |
| Per-VM backup schedules | `* * * * *` | [matestate](/services/matestate.md) |
| Resource sampling, pruning, alerts | `*/5 * * * *` | [resource-history](/services/resource-history.md), [alert](/services/alert.md) |
| Cluster auto-balance (auto mode only) | `*/15 * * * *` / `BALANCER_CRON` | [cluster-balancer](/services/cluster-balancer.md) |
| Cloud-image template refresh (when enabled) | `0 4 1 * *` / `TEMPLATE_REFRESH_CRON` | [template](/services/template.md) |
| App-DB snapshot (when a dir is set) | `30 2 * * *` / `APPDB_BACKUP_CRON` | [appdb-backup](/services/appdb-backup.md) |
| Access-expiry sweep (+ catch-up 15 s after boot) | `20 * * * *` / `ACCESS_EXPIRY_CRON` | [access-sweep](/services/access-sweep.md) |

One-shot at boot (not cron): passthrough apply reconciliation in [passthrough-request](/services/passthrough-request.md).[^index]

# Module system

`backend/src/modules/` is an opt-in seam for adding routes (and optional tables) without patching `app.ts`. A stock build mounts nothing.[^modreadme]

- Enabled by env `PROXMATE_MODULES` (comma-separated). Each name must be lowercase kebab-case (`MODULE_NAME_RE`), checked before import because it becomes a path; it must match the module's declared `name` and `apiVersion` must equal `MODULE_API_VERSION`.[^modules]
- Each module default-exports `{ name, apiVersion, router, auth? }` and is mounted at `/api/ext/<name>` inside `moduleRouter`, behind `moduleLimiter` and (unless `auth: 'none'`) `requireAuth` (which also enforces CSRF). `auth: 'none'` is logged as a warning at every boot.[^modules]
- A module supplies a Router, never the app, so it cannot add app-level middleware or error handlers, and the reserved `/api/ext` prefix makes shadowing core routes impossible.[^modreadme]
- Optional tables: `prisma/modules/<name>/schema.prisma` + migrations named `<timestamp>_<module>_<desc>` (shared `_prisma_migrations` ledger); no generator block, accessed via the core Prisma client with raw SQL. Applied by `npm run db:migrate:modules` / the container entrypoint after core migrations.[^modreadme][^entry]
- Fail-closed: a named module that fails to import, validate or migrate stops the boot. Recovery is unsetting `PROXMATE_MODULES`.[^modules]

# Frontend

Next.js App Router under `frontend/src/app/`:

| Route group / path | Pages |
|---|---|
| `(setup)` | `/setup`, `/setup/proxmox`, `/setup/defaults`, `/setup/complete` (first-run wizard) |
| `(auth)` | `/login`, `/register/[token]`, `/forgot-password`, `/reset-password`, `/setup-2fa` |
| `(dashboard)` | `/` dashboard, `/vms`, `/vms/new`, `/vms/[id]`, `/vms/[id]/console`, `/templates`, `/templates/[id]`, `/security`, `/help`, and `/admin/` sub-pages `audit`, `balancer`, `invites`, `monitor`, `settings`, `usage`, `users` (no `/admin` index page) |
| `kiosk` | Full-screen unattended admin panel (exit via passkey or [kiosk](/services/kiosk.md) PIN) |
| `console-popout/[id]` | Pop-out console window |

- `frontend/src/lib/api.ts` uses `withCredentials: true` so the httpOnly session cookie goes with every request.
- `frontend/src/proxy.ts` (Next 16 "proxy", formerly middleware) sets a per-request nonce CSP; `connect-src` can be pinned with `CSP_CONNECT_SRC`; unpinned, it adds the `NEXT_PUBLIC_API_URL` origin and its WebSocket origin to a generic default (`src/lib/csp.ts`).
- `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_SITE_URL` are baked in at build time.[^compose]

# IDE component

`ide/` holds the ProxMate IDE assets: code-server rebranded with the OpenCode agent.[^idedocker]

- `ide/settings.json` and `ide/autostart/{package.json,extension.js}` are embedded into `backend/src/services/ide-assets.generated.ts` by `backend/scripts/gen-ide-assets.mjs` (regenerate and commit after editing). [ide-provision](/services/ide-provision.md) ships them into the guest through the QEMU guest agent and installs pinned code-server/OpenCode natively.
- `ide/provision.sh` is a stand-alone native in-guest provisioner; `ide/Dockerfile` builds an alternative container image (`codercom/code-server` + OpenCode + branding + `write-opencode-config.sh` entrypoint hook).
- Runtime path: browser → [ide-proxy](/services/ide-proxy.md) → guest `:<IDE_GUEST_PORT>` (8080 by default); in-guest agent → [ide-gateway](/services/ide-gateway.md) → upstream LLM; policy in [ide](/services/ide.md).

# Deploy

- `docker-compose.yml` defines `backend` (built from `./backend`, port 4000, named volume `proxmate-data:/data`, `${PROXMATE_BACKUP_DIR:-./backups}:/var/backups/proxmate`, `cap_drop: ALL` plus CHOWN/DAC_OVERRIDE/SETUID/SETGID, `no-new-privileges`, healthcheck on `/api/health`) and `frontend` (port 3000, `cap_drop: ALL`, waits for backend `service_healthy`). Both images build on `node:22-alpine`. Optional mounts (snippets dir, backup-download dir, update control dir, private Proxmox CA) go in an untracked `docker-compose.override.yml`, copied from `docker-compose.override.example.yml`, so updates never touch them. Ports bind to `${BIND_ADDR:-0.0.0.0}`. Env reference: [docker environment](/env/docker-environment.md), [backend environment](/env/backend-environment.md).[^compose]
- `backend/docker-entrypoint.sh` starts as root only to `chown` `/data` (and the app-DB backup dir, non-recursively), drops to `node` via `su-exec`, runs `prisma migrate deploy`, then module migrations if `PROXMATE_MODULES` is set, then `node dist/index.js`.[^entry]
- `install.sh` is a read-before-run installer: prerequisite checks (offers to install Docker, Compose v2, git, curl, openssl), `--local` (HTTP trial) or `--domain` (HTTPS behind a reverse proxy) mode, source checkout (`--ref`, default newest `vX.Y.Z` tag), writes `.env` with a generated `ENCRYPTION_KEY` (refusing to generate one while the `proxmate_proxmate-data` volume already exists, since a new key cannot read that database), builds and starts, waits for API health. It deliberately stops at the browser setup wizard so the Proxmox token never touches shell history.[^install]
- Self-update: [update service](/services/update.md) writes a request into the control dir; `deploy/proxmate-updater.path` triggers `deploy/proxmate-updater.service` → `deploy/update.sh` on the host (checkout tag, rebuild, restart; it refuses to run over local edits to tracked files). `deploy/Caddyfile` is a reverse-proxy example.

# Gotchas

- `project-architecture.md` is partly stale: its addendum says LXC containers are not implemented and the JWT is in localStorage, but the code has `createContainer` (LXC) in [vm service](/services/vm.md) and uses an httpOnly session cookie plus a readable CSRF token ([auth service](/services/auth.md), `withCredentials` in the frontend).[^arch]
- Scheduler locks, the IDE relocation tracker and caches are per-process; the design assumes exactly one backend process (SQLite is single-writer anyway).[^sch]
- `ENCRYPTION_KEY` must be stable: it encrypts SystemConfig secrets, tenant LLM keys, TOTP secrets, IDE guest secrets and pending passwords, and peppers API-token and unsubscribe HMACs.[^compose]

# Relationships

- Service catalogue: every file under `/services/`, notably [vm](/services/vm.md), [scheduler](/services/scheduler.md), [proxmox](/services/proxmox.md), [setup](/services/setup.md).
- Proxmox concepts: [pve-api-surface](/proxmox/pve-api-surface.md), [privileges](/proxmox/privileges.md), [networking](/proxmox/networking.md), [storage](/proxmox/storage.md), [guest-lifecycle](/proxmox/guest-lifecycle.md).

[^index]: backend/src/index.ts
[^app]: backend/src/app.ts
[^sch]: backend/src/services/scheduler.service.ts
[^modules]: backend/src/modules/registry.ts
[^modreadme]: backend/src/modules/README.md
[^compose]: docker-compose.yml
[^entry]: backend/docker-entrypoint.sh
[^install]: install.sh
[^idedocker]: ide/Dockerfile
[^arch]: project-architecture.md
