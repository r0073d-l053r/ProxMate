---
type: Backend Service
title: Key-backup service (ENCRYPTION_KEY backup confirmation)
description: Records which admin confirmed, and when, that ENCRYPTION_KEY is backed up off the host, tied to a non-reversible fingerprint of the key so a changed key brings the admin warning back.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/key-backup.service.ts
tags: [proxmate, security, encryption, admin]
generated: { by: okf-bootstrap/0.1, at: 2026-10-23T12:00:00Z }
sources:
  - id: svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/key-backup.service.ts
    title: backend/src/services/key-backup.service.ts
  - id: admin
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/admin.routes.ts
    title: backend/src/routes/admin.routes.ts
---

# Purpose

Every stored secret is encrypted with `ENCRYPTION_KEY`, so an app-database backup can't be restored without it. Admins see a banner on every dashboard page until one of them confirms the key is backed up.[^svc]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `getKeyBackupStatus` | `() => { confirmed, confirmedAt, confirmedBy, keyChanged }` | `confirmed` only when the stored fingerprint matches the current key; `keyChanged` when a confirmation exists for another key. |
| `confirmKeyBackup` | `(actor, req?) => KeyBackupStatus` | Stores `{ at, by, userId, fingerprint }` in SystemConfig `encryption_key_backup_confirmed` and records the `admin.encryption_key_backup_confirmed` audit entry. |
| `keyFingerprint` | `(env?) => string \| null` | First 16 hex chars of an HMAC-SHA256 keyed by the key itself; reveals nothing about it. |

Routes: `GET /api/admin/encryption-key-backup`, `POST /api/admin/encryption-key-backup/confirm` (session only).[^admin]

# Gotchas

- The key is never returned, logged or stored by this service; only the fingerprint is.[^svc]

# Relationships

- [Platform secrets](/config/platform-secrets.md), [backend environment](/env/backend-environment.md), [app-DB backups](/services/appdb-backup.md), [admin API](/api/admin.md), [audit](/services/audit.md).

[^svc]: backend/src/services/key-backup.service.ts
[^admin]: backend/src/routes/admin.routes.ts
