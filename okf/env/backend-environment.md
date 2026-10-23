---
type: Environment Variables
title: Backend environment variables
description: Every process environment variable the ProxMate Express backend reads, with its default, whether it is required, and what it controls.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/.env.example
tags: [proxmate, env, backend, configuration, deployment]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: env-example
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/.env.example
    title: .env.example
  - id: env-ts
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/config/env.ts
    title: backend/src/config/env.ts
  - id: index
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/index.ts
    title: backend/src/index.ts
  - id: app
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/app.ts
    title: backend/src/app.ts
  - id: crypto
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/lib/crypto.ts
    title: backend/src/lib/crypto.ts
  - id: rate-limit
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/middleware/rate-limit.ts
    title: backend/src/middleware/rate-limit.ts
  - id: scheduler
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/scheduler.service.ts
    title: backend/src/services/scheduler.service.ts
  - id: pve
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/proxmox.service.ts
    title: backend/src/services/proxmox.service.ts
  - id: misc
    resource: https://github.com/r0073d-l053r/ProxMate/tree/main/backend/src
    title: backend/src (process.env reads across services, routes and lib)
---

# Purpose

The backend loads `.env` with `import 'dotenv/config'` (the first line of `src/index.ts`) and reads `process.env` directly wherever a value is needed.[^index][^misc] There is **no zod or other schema validation** for environment variables. `backend/src/config/env.ts` only exports a plain object (`PORT`, `NODE_ENV`, `FRONTEND_URL` with defaults), and nothing in `src` imports it.[^env-ts] Runtime settings that admins can change live in SystemConfig instead (see the [key index](/config/system-config-keys.md)). For Docker deployments see [Docker environment](/env/docker-environment.md).

# Schema

## Core

| Variable | Default | Required | Read in | Meaning |
|---|---|---|---|---|
| `ENCRYPTION_KEY` | Auto-generated at first start if missing (see Gotchas) | Effectively yes; must be stable | `index.ts`, `lib/crypto.ts`, `api-token.service`, `broadcast-optout.service` | 64 hex chars (32 bytes). It is the AES-256-GCM key for sensitive [SystemConfig](/database/system-config.md) rows, the HMAC pepper for API-token hashes, and the HMAC key for broadcast-unsubscribe tokens. Any other format throws `ENCRYPTION_KEY must be a 64-character hex string`.[^crypto] |
| `DATABASE_URL` | none (`.env.example`: `file:./proxmate.db`) | **yes** (Prisma `env("DATABASE_URL")`) | `prisma/schema.prisma`, `scripts/migrate-modules.ts` | Prisma datasource. The provider is `sqlite`; Postgres requires changing the provider in schema.prisma.[^env-example] |
| `PORT` | `4000` | no | `index.ts`, `sso.service` (callback fallback) | API listen port. |
| `BIND_ADDR` | `0.0.0.0` | no | `index.ts` | Interface the API listens on. Use `127.0.0.1` on bare metal behind a same-host proxy. |
| `NODE_ENV` | `development` | no | `app.ts`, `index.ts`, `lib/cookies.ts`, `lib/logger.ts`, `lib/prisma.ts` | `production` switches on Secure cookies by default, makes `/metrics` return 404 without a token, and sets the log level default to `info`. |
| `FRONTEND_URL` | `http://localhost:3000` | no (set it in production) | `app.ts` (CORS `origin`), auth/invite/console/vm/admin routes, `passkey.service`, `ide-proxy.service`, `alert.service`, `access-sweep.service` | Public frontend origin. Used for the CORS allow-list, the console and IDE WebSocket origin check, invite and auth links, and as the WebAuthn origin fallback. The SystemConfig key `frontend_url` overrides it for alert and email links only (see [platform secrets](/config/platform-secrets.md)). |
| `BACKEND_PUBLIC_URL` | `http://localhost:${PORT}` (SSO) | no (needed for SSO) | `sso.service.callbackUrl`, `ide.routes`, broadcast and backup-download link builders | Public API origin. The SSO callback is `${BACKEND_PUBLIC_URL}/api/auth/sso/callback` (see [SSO](/config/sso.md)). |
| `TRUST_PROXY` | `0` | no | `app.ts` (`app.set('trust proxy', envNumber(...))`) | Number of reverse-proxy hops to trust when resolving the client IP. |
| `REAL_IP_HEADER` | `cf-connecting-ip` | no | `audit.service.clientIp` | Header holding the real client IP for audit entries. An empty string disables it and falls back to `req.ip`. Only honoured when `TRUST_PROXY` ≥ 1; `x-forwarded-for` resolves to `req.ip` (trusted hop count applied). |
| `COOKIE_SECURE` | unset, meaning `NODE_ENV === 'production'` | no | `lib/cookies.ts` | Explicit `"true"` / `"false"` for the cookie `Secure` flag. |
| `WEBAUTHN_ORIGIN` | `FRONTEND_URL`, then `http://localhost:3000` | no | `passkey.service` | Passkey expected origin. |
| `WEBAUTHN_RP_ID` | hostname of the WebAuthn origin | no | `passkey.service` | Passkey relying-party id. |

## Observability and safety

| Variable | Default | Required | Read in | Meaning |
|---|---|---|---|---|
| `LOG_LEVEL` | `info` in production, else `debug` | no | `lib/logger.ts` | pino level. |
| `METRICS_TOKEN` | unset | no | `app.ts` | When set, `/metrics` requires `Authorization: Bearer <token>`. When unset in production, `/metrics` returns 404.[^app] |
| `ALLOW_PRIVATE_OUTBOUND_URLS` | `false` (only `"true"` enables it) | no | `lib/url-safety.ts` | Allows admin-configured webhooks and cloud-image URLs to target private or loopback hosts. Scheme and no-credentials checks always apply. |

## Rate limits and lockout

| Variable | Default | Read in | Meaning |
|---|---|---|---|
| `AUTH_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_WINDOW_MS` | `20` / `900000` (15 min) | `middleware/rate-limit.ts` | Auth limiter, also applied to mutating `/api/setup` calls. |
| `API_WRITE_RATE_LIMIT_MAX` / `API_WRITE_RATE_LIMIT_WINDOW_MS` | `60` / `60000` | same | Mutating `/api` requests per IP. |
| `SHARE_RATE_LIMIT_MAX` / `SHARE_RATE_LIMIT_WINDOW_MS` | `30` / `3600000` | same | `POST /api/vms/:id/shares` requests per signed-in user. Forwarded by `docker-compose.yml`. |
| `GUEST_FILE_RATE_LIMIT_MAX` / `GUEST_FILE_RATE_LIMIT_WINDOW_MS` | `30` / `600000` | same | `POST /api/vms/:id/files` pushes per signed-in user. Forwarded by `docker-compose.yml`. |
| `GUEST_LOG_RATE_LIMIT_MAX` | `30` | same | `GET /api/ide/:id/install-log` reads per signed-in user per minute. Forwarded by `docker-compose.yml`. |
| `GUEST_FILE_PUSH_MAX_BYTES` | `1048576` | at most `8388608` | Largest file `POST /api/vms/:id/files` accepts (1 MiB default, 8 MiB ceiling). Forwarded by `docker-compose.yml`. |
| `PUBLIC_TOKEN_RATE_LIMIT_MAX` / `PUBLIC_TOKEN_RATE_LIMIT_WINDOW_MS` | `60` / `900000` | same | Public token GETs (invite lookup, downloads). Forwarded by `docker-compose.yml`. |
| `MODULE_RATE_LIMIT_MAX` / `MODULE_RATE_LIMIT_WINDOW_MS` | `300` / `60000` | same | Optional-module routes. |
| `KIOSK_EXIT_RATE_LIMIT_MAX` / `KIOSK_EXIT_RATE_LIMIT_WINDOW_MS` | `10` / `300000` | same | `/api/auth/kiosk-exit*`. |
| `IDE_GATEWAY_RATE_LIMIT_MAX` / `IDE_GATEWAY_RATE_LIMIT_WINDOW_MS` | `600` / `60000` | same | IDE LLM gateway. |
| `AUTH_LOCKOUT_MAX` | `10` (min 1) | `account-lockout.service` | Failed logins before an account is locked. |
| `AUTH_LOCKOUT_MINUTES` | `15` (min 1) | `account-lockout.service` | Lock duration. |

## Proxmox client

| Variable | Default | Read in | Meaning |
|---|---|---|---|
| `PROXMOX_TIMEOUT_MS` | `15000` | `proxmox.service` | Per-request timeout. |
| `PROXMOX_RETRIES` | `2` (min 0) | `proxmox.service` | Retries for transient failures on idempotent reads only. |
| `PROXMOX_CA_CERT` | unset | `proxmox.service.getProxmoxCa` | Inline PEM. Used only if the value contains `BEGIN CERTIFICATE`. It takes precedence over the file. |
| `PROXMOX_CA_CERT_FILE` | unset | same | Path to a CA PEM. An unreadable path silently falls back to the default trust store.[^pve] |
| `SNIPPET_DIR` / `SNIPPET_STORAGE` | unset | `proxmox.service.snippetWriteConfig` | Both must be set to enable writing cloud-init snippets on demand into a shared storage's `snippets/` dir (see [cloud-init](/config/cloud-init.md)). |

## Schedules (5-field cron; an invalid value falls back to the default)

| Variable | Default | Meaning |
|---|---|---|
| `MATESTATE_CRON` | `0 3 * * 0` (Sun 03:00) | Weekly MateState backups. An invalid value logs a warning. |
| `BALANCER_CRON` | `*/15 * * * *` | Cluster balancer tick, which acts only in `auto` mode ([cluster balancer](/config/cluster-balancer.md)). |
| `TEMPLATE_REFRESH_CRON` | `0 4 1 * *` | Template refresh tick, which acts only when enabled ([template refresh](/config/template-refresh.md)). |
| `APPDB_BACKUP_CRON` | `30 2 * * *` | App-DB snapshot ([appdb backup](/config/appdb-backup.md)). |
| `ACCESS_EXPIRY_CRON` | `20 * * * *` | Tenant access-expiry sweep. |

All schedules are read in `scheduler.service.ts`.[^scheduler]

## Features and paths

| Variable | Default | Read in | Meaning |
|---|---|---|---|
| `APPDB_BACKUP_DIR` | `''` | `appdb-backup.service` | Default app-DB backup directory, used when the `appdb_backup_dir` row is missing. Docker sets `/var/backups/proxmate`. |
| `BACKUP_DOWNLOAD_DIR` | unset (feature off) | `download.service.backupDir` | Mounted vzdump dump directory for tenant backup downloads. SMTP must also be configured. |
| `RESTORE_UPLOAD_MAX_GB` | `50` | `vm.routes` | Cap on restore-from-upload size. |
| `ALERT_COOLDOWN_MIN` | `60` (min 5) | `alert.service` | Minimum minutes between repeat alerts. Forwarded by `docker-compose.yml`. |
| `RESOURCE_HISTORY_DAYS` | `14` (min 1) | `resource-history.service` | Retention of resource-usage samples. |
| `LIVE_FEED_INTERVAL_MS` | `1000` (min 250) | `live-stats.service` | Admin live-feed push interval. |
| `PROXMATE_MODULES` | unset (no modules) | `modules/registry.ts`, `scripts/migrate-modules.ts` | CSV of compiled-in modules to mount at `/api/ext/<name>`. A named module that fails to load stops the boot. |
| `UPDATE_REPO` | `r0073d-l053r/ProxMate` | `update.service` | GitHub repo checked for releases. |
| `APP_VERSION` | `package.json` version | `update.service.currentVersion` | Overrides the reported version. |
| `GITHUB_TOKEN` | unset | `update.service` | Optional token for the GitHub release check. |
| `SELF_UPDATE_ENABLED` | `false` (only `"true"` enables it) | `update.service` | Enables the admin "Install update" button. The host updater must be installed. |
| `UPDATE_CONTROL_DIR` | `/control` | `update.service` | Directory watched by the host updater. |
| `IDE_GUEST_PORT` | `8080` | `ide-provision.service` | code-server port inside the guest. |
| `IDE_CODE_SERVER_VERSION` | `4.128.0` | same | code-server version installed. |
| `IDE_OPENCODE_VERSION` | `1.17.18` | same | OpenCode agent version installed. |
| `IDE_TARGET_OVERRIDE` | unset | same (`probeIdeReachability`) | Overrides the IDE reachability probe target URL. |

# Gotchas

- **ENCRYPTION_KEY auto-generation:** when the variable is unset or empty, `index.ts` (via `lib/encryption-key.ts`) generates `randomBytes(32).toString('hex')` only outside production and only when a `.env` exists in the current working directory: it writes the key there (filling an existing `ENCRYPTION_KEY=` line or appending one), sets the file to mode 0600 and logs the path. In production, or with no `.env`, the server exits at boot with instructions instead of running on a key that would be lost on restart. Never change the key after setup.[^index][^env-example]
- `config/env.ts` is dead code. Changing its defaults has no effect.[^env-ts]
- The logger header comment mentions `LOG_PRETTY=1`, but no code reads that variable.
- Numeric variables (lockout, every rate-limit window and limit, alert cooldown, Proxmox timeout and retries, resource-history retention, live-feed interval, `IDE_GUEST_PORT`, `TRUST_PROXY`) are read with `envNumber` (`lib/env-number.ts`): an unset, empty or non-numeric value falls back to the default, and a value below the minimum is raised to it (minimum 1 for rate-limit windows and limits and the guest port, 0 for `TRUST_PROXY`).[^rate-limit]

[^env-example]: .env.example
[^env-ts]: backend/src/config/env.ts
[^index]: backend/src/index.ts and backend/src/lib/encryption-key.ts (dotenv load, ENCRYPTION_KEY auto-generation, PORT/BIND_ADDR)
[^app]: backend/src/app.ts (trust proxy, CORS, /metrics)
[^crypto]: backend/src/lib/crypto.ts (`getKey`)
[^rate-limit]: backend/src/middleware/rate-limit.ts
[^scheduler]: backend/src/services/scheduler.service.ts
[^pve]: backend/src/services/proxmox.service.ts (`TIMEOUT_MS`, `MAX_RETRIES`, `getProxmoxCa`, `snippetWriteConfig`)
[^misc]: process.env reads in backend/src/services/*.ts, backend/src/routes/*.ts and backend/src/lib/*.ts
