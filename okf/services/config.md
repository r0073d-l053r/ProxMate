---
type: Backend Service
title: Config service (SystemConfig key/value store)
description: Thin get/set wrapper over the SystemConfig table that transparently encrypts and decrypts rows flagged sensitive.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/config.service.ts
tags: [proxmate, config, encryption, system-config]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: config
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/config.service.ts
    title: backend/src/services/config.service.ts
---

# Purpose

Every runtime setting (Proxmox connection, SMTP, SSO, notifications, balancer, IDE, ...) is a row in [SystemConfig](/database/system-config.md); this service is the only accessor.[^config]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `isSetupComplete` | `() => Promise<boolean>` | True when key `setup_complete` equals `'true'`; returns false on any DB error. |
| `getConfig` | `(key) => Promise<string \| null>` | Returns the value, decrypting via `lib/crypto.decrypt` when `sensitive` is true; null when absent. |
| `setConfig` | `(key, value, sensitive = false) => Promise<void>` | Upserts; encrypts with `lib/crypto.encrypt` when `sensitive`, and stores the `sensitive` flag. |

# Data

[SystemConfig](/database/system-config.md) columns `key`, `value`, `sensitive`. Key groups are documented under `/config/` (e.g. [proxmox-connection](/config/proxmox-connection.md), [smtp](/config/smtp.md), [sso](/config/sso.md), [platform-secrets](/config/platform-secrets.md)).[^config]

# Gotchas

- `setConfig` rewrites the `sensitive` flag on every call: calling it later with the default `sensitive = false` stores that value in plaintext and clears the flag. Callers that clear a secret deliberately pass `''` non-sensitive (e.g. notify webhook URL, kiosk PIN).[^config]
- Decryption depends on `ENCRYPTION_KEY`; a DB restored with a different key cannot decrypt sensitive rows.[^config]
- `getConfig` returns `null` for a missing key but `''` for an explicitly cleared one; several services (e.g. [appdb-backup](/services/appdb-backup.md)) treat those differently.

# Relationships

- Used by nearly every service ([mail](/services/mail.md), [sso](/services/sso.md), [notify](/services/notify.md), [scheduler](/services/scheduler.md), [vm](/services/vm.md), [proxmox](/services/proxmox.md), ...) and by the [admin](/api/admin.md) and [vm](/api/vm.md) routers.

[^config]: backend/src/services/config.service.ts
