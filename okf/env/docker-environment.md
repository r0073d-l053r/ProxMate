---
type: Environment Variables
title: Docker Compose environment
description: The docker-compose.yml services, volumes, ports, build args and the .env.docker.example variables they consume for a containerised ProxMate deployment.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/docker-compose.yml
tags: [proxmate, env, docker, deployment, compose]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T20:00:00Z }
sources:
  - id: compose
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/docker-compose.yml
    title: docker-compose.yml
  - id: env-docker
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/.env.docker.example
    title: .env.docker.example
  - id: entrypoint
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/docker-entrypoint.sh
    title: backend/docker-entrypoint.sh
  - id: fe-dockerfile
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/frontend/Dockerfile
    title: frontend/Dockerfile
  - id: fe-api
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/frontend/src/lib/api.ts
    title: frontend/src/lib/api.ts
---

# Purpose

`docker-compose.yml` (project name `proxmate`) defines two services, `backend` and `frontend`, and one named volume, `proxmate-data`. Copy `.env.docker.example` to `.env` next to the compose file before running `docker compose up -d`. The example offers a LOCAL profile (HTTP, two ports) and a PRODUCTION profile (one HTTPS domain behind a reverse proxy that routes `/api` to `backend:4000` and everything else to `frontend:3000`).[^env-docker] For what each backend variable does, see [backend environment](/env/backend-environment.md).

# Schema

## Services

| Service | Image / build | Ports | Volumes | Notes |
|---|---|---|---|---|
| `backend` | `proxmate-backend`, built from `./backend` (`node:22-alpine`) | `${BIND_ADDR:-0.0.0.0}:${BACKEND_PORT:-4000}:4000` | `proxmate-data:/data` (SQLite DB); `${PROXMATE_BACKUP_DIR:-./backups}:/var/backups/proxmate`; optional mounts go in an untracked `docker-compose.override.yml` (template `docker-compose.override.example.yml`): `/snippets` (shared snippets dir), `/backups:ro` (vzdump dump for downloads), `/control` (self-update), `/certs/pve-ca.pem:ro` (private Proxmox CA) | `cap_drop: ALL` plus `CHOWN`, `DAC_OVERRIDE`, `SETUID`, `SETGID`; `no-new-privileges`. Healthcheck: `fetch http://127.0.0.1:4000/api/health` every 30 s (start period 40 s). `restart: unless-stopped`.[^compose] |
| `frontend` | `proxmate-frontend`, built from `./frontend` (`node:22-alpine`) | `${BIND_ADDR:-0.0.0.0}:${FRONTEND_PORT:-3000}:3000` | none | `cap_drop: ALL`, `no-new-privileges`. `depends_on: backend` with `condition: service_healthy`. |

## Backend container environment

| Variable | Compose value / default | Required | Description |
|---|---|---|---|
| `PORT` | `"4000"` (fixed) | n/a | Container listen port. |
| `NODE_ENV` | `production` (fixed) | n/a | Production mode. |
| `DATABASE_URL` | `file:/data/proxmate.db` (fixed) | n/a | SQLite on the `proxmate-data` volume. |
| `APPDB_BACKUP_DIR` | `/var/backups/proxmate` (fixed) | n/a | Container side of the backup mount and default for the [app-DB backup](/config/appdb-backup.md) dir. |
| `ENCRYPTION_KEY` | `${ENCRYPTION_KEY:?…}` | **yes**: compose refuses to start without it | 64 hex chars (`openssl rand -hex 32`). Must stay stable. |
| `FRONTEND_URL` | `${FRONTEND_URL:-http://localhost:3000}` | prod: yes | CORS allow-list and links. |
| `BACKEND_PUBLIC_URL` | `${BACKEND_PUBLIC_URL:-http://localhost:4000}` | prod / SSO: yes | Used to build the SSO callback. |
| `COOKIE_SECURE` | `${COOKIE_SECURE:-false}` | prod: `true` | Secure cookies. Passkeys need a secure context. |
| `TRUST_PROXY` | `${TRUST_PROXY:-0}` | prod: `1` behind one proxy | Proxy hops. |
| `REAL_IP_HEADER` | `${REAL_IP_HEADER-cf-connecting-ip}` (note: `-`, not `:-`) | no | An explicitly empty value is passed through and disables the header (`install.sh --local` writes it empty). Only honoured when `TRUST_PROXY` ≥ 1. |
| `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` | `${…:-}` (empty) | prod: recommended | Passkey RP id and origin. |
| `AUTH_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_WINDOW_MS` | `20` / `900000` | no | Auth limiter. |
| `SHARE_RATE_LIMIT_MAX` / `SHARE_RATE_LIMIT_WINDOW_MS` | `30` / `3600000` | no | VM-share throttle, per signed-in user. |
| `GUEST_FILE_RATE_LIMIT_MAX` / `GUEST_FILE_RATE_LIMIT_WINDOW_MS` | `30` / `600000` | no | Guest file-push throttle, per signed-in user. |
| `GUEST_LOG_RATE_LIMIT_MAX` | `30` | no | IDE install-log reads per signed-in user per minute. |
| `GUEST_FILE_PUSH_MAX_BYTES` | `1048576` | no | Largest pushable file; capped at 8 MiB. |
| `PUBLIC_TOKEN_RATE_LIMIT_MAX` / `PUBLIC_TOKEN_RATE_LIMIT_WINDOW_MS` | `60` / `900000` | no | Public token lookups (invite links, downloads), per IP. |
| `ALERT_COOLDOWN_MIN` | `60` | no | Minutes before a firing alert rule can fire again (minimum 5). |
| `AUTH_LOCKOUT_MAX` / `AUTH_LOCKOUT_MINUTES` | `10` / `15` | no | Account lockout. |
| `PROXMOX_CA_CERT_FILE` | `${…:-}` | no | e.g. `/certs/pve-ca.pem` with the matching volume in `docker-compose.override.yml`. |
| `UPDATE_REPO` | `r0073d-l053r/ProxMate` | no | Release source. |
| `SELF_UPDATE_ENABLED` | `false` | no | Also needs the `/control` mount and the host updater. |
| `METRICS_TOKEN` | `${…:-}` | no | Without it `/metrics` returns 404 in production. |
| `ALLOW_PRIVATE_OUTBOUND_URLS` | `false` | no | SSRF escape hatch. |
| `SNIPPET_DIR` / `SNIPPET_STORAGE` | `${…:-}` | no | On-demand cloud-init snippets. Needs the `/snippets` mount. |
| `BACKUP_DOWNLOAD_DIR` | `${…:-}` | no | Tenant backup downloads. Needs the `/backups` mount. |
| `RESTORE_UPLOAD_MAX_GB` | `${…:-}` | no | An empty value falls back to the built-in 50. |
| `MATESTATE_CRON` / `ACCESS_EXPIRY_CRON` | `${…:-}` | no | Schedule overrides. Empty means the defaults. |
| `APPDB_BACKUP_CRON` / `BALANCER_CRON` / `TEMPLATE_REFRESH_CRON` | `${…:-}` | no | Schedule overrides for app-DB snapshots, the balancer and template refresh. Empty or invalid means the defaults. |
| `USAGE_DIGEST_CRON` | `${…:-}` | no | Schedule override for the weekly usage digest (default Mondays 08:00). |
| `PROXMATE_MODULES` | `${…:-}` | no | Comma-separated optional modules; empty enables none. |
| `LOG_LEVEL` | `info` | no | pino log level. |
| `GITHUB_TOKEN` | `${…:-}` | no | Optional token for the release check. |
| `IDE_GUEST_PORT` | `${…:-}` | no | code-server port in guests; empty means the built-in 8080. |

## Host-side and frontend variables (`.env`)

| Variable | Default | Used by | Description |
|---|---|---|---|
| `BIND_ADDR` | `0.0.0.0` (the example's prod profile uses `127.0.0.1`) | both port mappings | Host interface the ports are published on. |
| `BACKEND_PORT` / `FRONTEND_PORT` | `4000` / `3000` | port mappings | Host ports. |
| `PROXMATE_BACKUP_DIR` | `./backups` | backend volume | **Host** directory for app-DB snapshots. Changing it requires `docker compose up -d backend` (mounts are set at container creation), not just a restart.[^env-docker] |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000/api` | frontend **build arg** | API URL baked into the client bundle. The frontend code falls back to `http://localhost:4000/api` (`lib/api.ts`).[^fe-api] |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` | frontend build arg and runtime env | Public origin for SEO metadata (OG image, canonical, manifest). |
| `CSP_CONNECT_SRC` | `''`, giving the default `'self' https: wss:` plus the `NEXT_PUBLIC_API_URL` origin and its `ws:`/`wss:` counterpart | frontend runtime env (`src/proxy.ts`) | Pins the CSP `connect-src`. In `.env` the whole value must be wrapped in double quotes. |

# Gotchas

- `NEXT_PUBLIC_*` values are inlined at **build** time (`frontend/Dockerfile` `ARG`/`ENV`). Changing them in the runtime environment without a rebuild has no effect.[^fe-dockerfile][^compose]
- The entrypoint starts as root, runs `chown -R node:node /data`, and does non-recursive `chown`s of `$APPDB_BACKUP_DIR` and, when it exists, the self-update control dir `${UPDATE_CONTROL_DIR:-/control}` (failures there are non-fatal). It then re-execs as `node` through `su-exec`, runs `npx prisma migrate deploy`, applies migrations for any modules in `PROXMATE_MODULES`, and starts the server.[^entrypoint]
- Only the variables listed in the `backend.environment` block reach the container; there is no `env_file`. The numeric tuning knobs (`PROXMOX_TIMEOUT_MS`, `PROXMOX_RETRIES`, `API_WRITE_RATE_LIMIT_*`, `MODULE_RATE_LIMIT_*`, `RESOURCE_HISTORY_DAYS`, `LIVE_FEED_INTERVAL_MS`) and `IDE_*_VERSION` are not forwarded. To use one, add it with an explicit default (`${VAR:-<default>}`), e.g. in `docker-compose.override.yml`.[^compose]
- Because `ENCRYPTION_KEY` is required by compose (`:?`), the backend's auto-generate-and-write-to-`.env` path never runs in Docker. Back the key up together with the `proxmate-data` volume.

# Relationships

- [Backend environment](/env/backend-environment.md), [SystemConfig key index](/config/system-config-keys.md), [app-DB backup](/config/appdb-backup.md)

[^compose]: docker-compose.yml
[^env-docker]: .env.docker.example
[^entrypoint]: backend/docker-entrypoint.sh
[^fe-dockerfile]: frontend/Dockerfile
[^fe-api]: frontend/src/lib/api.ts
