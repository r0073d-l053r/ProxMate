---
type: Configuration Group
title: Proxmox connection settings
description: SystemConfig keys holding the Proxmox VE API endpoint, API token and TLS-verification flag that every Proxmox client ProxMate builds is created from.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/proxmox.service.ts
tags: [proxmate, config, proxmox, api-token, secrets]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T20:00:00Z }
sources:
  - id: pve
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/proxmox.service.ts
    title: backend/src/services/proxmox.service.ts
  - id: setup-svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/setup.service.ts
    title: backend/src/services/setup.service.ts
  - id: setup-routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/setup.routes.ts
    title: backend/src/routes/setup.routes.ts
  - id: admin-routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/admin.routes.ts
    title: backend/src/routes/admin.routes.ts
  - id: config-svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/config.service.ts
    title: backend/src/services/config.service.ts
---

# Purpose

The four keys ProxMate needs to talk to the Proxmox VE API. `getConnectionConfig()` reads all four and `getClient()` builds an axios client from them on every call; nothing is cached, so a change takes effect on the next Proxmox request.[^pve] Rows live in [SystemConfig](/database/system-config.md) and are accessed through `getConfig`/`setConfig`.[^config-svc]

# Schema

| Key | Value format | Default / when unset | Written by | Read by | Description |
|---|---|---|---|---|---|
| `proxmox_host` | URL string, e.g. `https://192.168.1.100:8006` (zod `z.string().url()`) | Unset: `getConnectionConfig()` throws `Proxmox is not configured` | `POST /api/setup/proxmox` (wizard step 2), `PUT /api/admin/settings/proxmox` | `proxmox.service.getConnectionConfig`; `GET /api/admin/settings` (returned as `proxmox.host`) | Base URL of the Proxmox VE API. |
| `proxmox_token_id` | string, min length 1, e.g. `user@realm!tokenid` | Unset: same throw as above | same as `proxmox_host` | `getConnectionConfig`; `GET /api/admin/settings` (`proxmox.tokenId`) | API token id. |
| `proxmox_token_secret` | string, min length 1. **Secret, stored encrypted** (`sensitive=true`, AES-256-GCM) | Unset: same throw as above | Wizard: always (required). Admin: only when `tokenSecret` is non-blank; blank keeps the existing secret | `getConnectionConfig` only. Never returned; `GET /api/admin/settings` exposes only `proxmox.hasSecret` (boolean) | API token secret (UUID part). |
| `proxmox_verify_ssl` | `"true"` / `"false"` (`String(boolean)`) | zod default `true` on both write routes; but if the row is missing the reader treats it as **false** (`=== 'true'`) | same as `proxmox_host` | `getConnectionConfig` (passed to `buildClient`); `GET /api/admin/settings` (`proxmox.verifySsl`) | Whether the Proxmox TLS certificate is verified. Combined with the env CA (`PROXMOX_CA_CERT` / `PROXMOX_CA_CERT_FILE`) for private-CA setups. |

# Validation

- Setup wizard `ProxmoxConfigSchema`: `host` url, `tokenId` min 1, `tokenSecret` min 1, `verifySsl` boolean default true.[^setup-routes]
- Admin `ProxmoxUpdateSchema`: same, but `tokenSecret` optional (blank or omitted keeps the stored secret).[^admin-routes]
- Neither route tests the connection on save. Testing is a separate call: `POST /api/setup/proxmox/test` or `POST /api/admin/settings/proxmox/test`, both running `testProxmoxConnection()`.[^setup-svc]

# Gotchas

- `testProxmoxConnection()` checks `/version`, then `/access/permissions`. It fails if the token holds no privileges at all (the usual cause is privsep), if `VM.Audit` is missing or `/cluster/resources` cannot be read, or if `Datastore.Audit` is missing or returns no storages. Zero visible guests is only a warning. Missing operational privileges (`VM.Allocate`, `VM.Clone`, `Sys.Audit`, and others), `SDN.Use` on PVE 8+, and `SDN.Audit` only produce warnings.[^setup-svc] See [Proxmox privileges](/proxmox/privileges.md).
- `PUT /api/admin/settings/proxmox` records an `admin.proxmox_config` audit entry (host, token id, `verifySsl` and whether the secret was replaced, never the secret) and does not re-test the connection.[^admin-routes]
- The token secret can only be decrypted with the same `ENCRYPTION_KEY` that encrypted it. If that key changes, `getConfig('proxmox_token_secret')` throws while decrypting and every Proxmox call fails. See [backend environment](/env/backend-environment.md).

# Relationships

- Wizard routes: [setup API](/api/setup.md). Admin routes: [admin API](/api/admin.md).
- Consumer: [Proxmox service](/services/proxmox.md), [Proxmox API surface](/proxmox/pve-api-surface.md).

[^pve]: backend/src/services/proxmox.service.ts (`getConnectionConfig`, `getClient`, `getProxmoxCa`)
[^config-svc]: backend/src/services/config.service.ts
[^setup-svc]: backend/src/services/setup.service.ts (`saveProxmoxConfig`, `testProxmoxConnection`)
[^setup-routes]: backend/src/routes/setup.routes.ts (`ProxmoxConfigSchema`)
[^admin-routes]: backend/src/routes/admin.routes.ts (`GET /settings`, `PUT /settings/proxmox`, `ProxmoxUpdateSchema`)
