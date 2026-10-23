---
type: Configuration Group
title: Platform secrets and internal state
description: SystemConfig keys for the JWT signing secret, the setup-complete flag, the kiosk exit PIN hash, the public frontend URL override, the ENCRYPTION_KEY backup confirmation and the MateState scheduler markers.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/setup.service.ts
tags: [proxmate, config, secrets, jwt, setup]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: setup-svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/setup.service.ts
    title: backend/src/services/setup.service.ts
  - id: config-svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/config.service.ts
    title: backend/src/services/config.service.ts
  - id: auth-svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/auth.service.ts
    title: backend/src/services/auth.service.ts
  - id: kiosk
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/kiosk.service.ts
    title: backend/src/services/kiosk.service.ts
  - id: scheduler
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/scheduler.service.ts
    title: backend/src/services/scheduler.service.ts
  - id: setup-routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/setup.routes.ts
    title: backend/src/routes/setup.routes.ts
  - id: admin-routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/admin.routes.ts
    title: backend/src/routes/admin.routes.ts
  - id: key-backup
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/key-backup.service.ts
    title: backend/src/services/key-backup.service.ts
---

# Purpose

Keys that are not admin-facing feature settings: the auto-generated JWT secret, setup state, the kiosk exit PIN, a URL override used in outbound links, and a scheduler bookkeeping marker.

# Schema

| Key | Value format | Default / when unset | Written by | Read by | Description |
|---|---|---|---|---|---|
| `jwt_secret` | 128 hex chars (`randomBytes(64).toString('hex')`). **Secret, stored encrypted** (`sensitive=true`) | Generated only if missing, at wizard step 1 (`createAdmin`) and again at `completeSetup` | `setup.service.createAdmin`, `setup.service.completeSetup` | `auth.service.getJwtSecret` (signs and verifies session JWTs, `expiresIn: '24h'`). Missing → throws `JWT secret not configured — run setup first` | HMAC key for session JWTs. No route exposes or rotates it.[^setup-svc][^auth-svc] |
| `setup_complete` | `"true"` | Missing: setup is open. `isSetupComplete()` returns `row?.value === 'true'` and returns false on any DB error | `setup.service.completeSetup` (`POST /api/setup/complete`) | `config.service.isSetupComplete` (read through Prisma directly, not `getConfig`) → `GET /api/setup/status` and the setup-router guard | Once `"true"`, every `/api/setup/*` route except `GET /status` returns 403 `Setup already completed`.[^config-svc][^setup-routes] |
| `kiosk_exit_pin` | bcrypt hash (cost 12, `hashPassword`), **also stored encrypted** (`sensitive=true`); or `''` stored plain when cleared | Unset or empty: no PIN; `verifyKioskPin` always returns false | `kiosk.service.setKioskPin` ← `PUT /api/admin/settings/kiosk` (`pin`: 4–12 digits, or `''` to clear; zod `max(64)` + `isValidKioskPin`) | `isKioskPinSet` (`GET /api/admin/settings` → `kiosk.pinSet`), `verifyKioskPin` (`POST /api/auth/kiosk-exit`) | PIN a human must enter to leave kiosk mode (passkeys also work). The value is never returned. The route records an `admin.kiosk_config` audit entry.[^kiosk][^admin-routes] |
| `frontend_url` | URL string | Unset (the normal state): each reader falls back to env. Alerts and the access sweep use `FRONTEND_URL`, then `''`. Broadcast unsubscribe links and the backup-download email use `BACKEND_PUBLIC_URL`, then `FRONTEND_URL`, then `''` | **No route or UI writes it**; it can only be set by editing the DB row directly | `alert.service`, `access-sweep.service.dashboardUrl`, `POST /api/admin/broadcast` (unsubscribe URL), `POST /api/vms/:id/matestates/:msid/download` | Optional override for the public base URL in outbound email and alert links. CORS, cookies and passkeys use only the env `FRONTEND_URL`. See [backend environment](/env/backend-environment.md). |
| `matestate_last_run` | ISO-8601 timestamp | Missing at boot: `catchUpMissedBackups` sets it to the previous scheduled occurrence, so a fresh install doesn't back everything up at once | `scheduler.service` (after each weekly run, and on first-boot init) | `scheduler.catchUpMissedBackups` (10 s after boot) | Last completed weekly MateState backup run (stamped after `runScheduledBackups` returns, even if some guests failed). If it is older than the most recent `MATESTATE_CRON` occurrence (default `0 3 * * 0`), the run is caught up immediately.[^scheduler] |
| `encryption_key_backup_confirmed` | JSON `{ at, by, userId, fingerprint }` (fingerprint: first 16 hex of an HMAC-SHA256 keyed by `ENCRYPTION_KEY`) | Unset: every admin sees the "Back up ENCRYPTION_KEY" banner | `key-backup.service.confirmKeyBackup` ← `POST /api/admin/encryption-key-backup/confirm` (session only; audited `admin.encryption_key_backup_confirmed`) | `getKeyBackupStatus` ← `GET /api/admin/encryption-key-backup` | Who confirmed the key is backed up off the host, and when. Counts only while the fingerprint matches the running key, so a new key brings the banner back. The key is never stored or returned.[^key-backup] |
| `matestate_vm_tick_last` | ISO-8601 timestamp | Missing: the first per-VM backup tick checks only its own minute | `scheduler.perVmBackupTick` (each tick that runs) | `scheduler.perVmBackupTick` (first tick after boot) | The minute the last per-VM backup tick covered. After a restart the first tick backs up every VM whose `backupCron` fired since then (at most 24 h back).[^scheduler] |

# Invariants

- Encryption: `setConfig(key, value, true)` stores `encrypt(value)` (AES-256-GCM, 12-byte IV, `iv:tag:ciphertext` hex) and sets `sensitive=true`. `getConfig` decrypts any row whose `sensitive` flag is true. The flag is rewritten on every `setConfig`, so the same key can go back to plaintext. That happens with `kiosk_exit_pin` and `notify_webhook_url` when they are cleared.[^config-svc]

# Gotchas

- Losing or changing `ENCRYPTION_KEY` makes `jwt_secret` undecryptable, so every authenticated request fails. Nothing regenerates the row after setup: the only writers are setup steps, and those routes return 403 once `setup_complete` is `"true"`. The other encrypted keys must also be re-entered.
- `kiosk_exit_pin` is both bcrypt-hashed and encrypted at rest.

# Relationships

- [SystemConfig table](/database/system-config.md), [setup API](/api/setup.md), [auth API](/api/auth.md), [admin API](/api/admin.md)

[^setup-svc]: backend/src/services/setup.service.ts (`createAdmin`, `completeSetup`)
[^config-svc]: backend/src/services/config.service.ts (`isSetupComplete`, `getConfig`, `setConfig`)
[^auth-svc]: backend/src/services/auth.service.ts (`getJwtSecret`, `signToken`, `hashPassword`)
[^kiosk]: backend/src/services/kiosk.service.ts
[^scheduler]: backend/src/services/scheduler.service.ts (`LAST_RUN_KEY`, `catchUpMissedBackups`)
[^setup-routes]: backend/src/routes/setup.routes.ts (setup-complete guard)
[^admin-routes]: backend/src/routes/admin.routes.ts (`PUT /settings/kiosk`, broadcast)
[^key-backup]: backend/src/services/key-backup.service.ts
