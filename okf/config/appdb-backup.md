---
type: Configuration Group
title: App-database backup settings
description: SystemConfig keys configuring the nightly VACUUM INTO snapshot of ProxMate's own SQLite database, namely the target directory and rolling retention.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/appdb-backup.service.ts
tags: [proxmate, config, backup, sqlite, scheduler]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: appdb
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/appdb-backup.service.ts
    title: backend/src/services/appdb-backup.service.ts
  - id: admin-routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/admin.routes.ts
    title: backend/src/routes/admin.routes.ts
  - id: scheduler
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/scheduler.service.ts
    title: backend/src/services/scheduler.service.ts
---

# Purpose

Backups of ProxMate's **own** database: users, VM records, config and encrypted secrets. A nightly `VACUUM INTO` writes a consistent snapshot of the live SQLite database named `proxmate-appdb-YYYYMMDD-HHMMSS.db` (UTC). Retention prunes only files that match `APPDB_BACKUP_FILE_RE`.[^appdb] Admins configure it with `PUT /api/admin/settings/appdb-backup` and can run a backup immediately with `POST /api/admin/settings/appdb-backup/run` ([admin API](/api/admin.md)).

# Schema

| Key | Value format | Default / when unset | Written by | Read by | Description |
|---|---|---|---|---|---|
| `appdb_backup_dir` | absolute path or `''` (zod `max(500)`, must pass `isValidBackupDir`), trimmed | Row missing: `DEFAULT_BACKUP_DIR` = env `APPDB_BACKUP_DIR` (Docker sets `/var/backups/proxmate`), else `''`. An **explicit `''` disables** backups and is not overridden by the default | `saveAppDbBackupConfig` ← `PUT /api/admin/settings/appdb-backup` | `getAppDbBackupConfig` (scheduler tick, run-now, `GET /api/admin/settings` → `appdbBackup`) | Directory snapshots are written to. |
| `appdb_backup_keep` | integer string 1–365 | `7` (`KEEP_DEFAULT`); out-of-range values also fall back to 7 | same | `getAppDbBackupConfig` | How many snapshots to keep. |

# Validation

`AppDbBackupSchema`: `dir` max 500 and absolute-or-empty; `keep` int 1–365, default 7. Before saving, the route `mkdir -p`s the directory and writes and deletes a probe file. If that fails it returns 400 with `explainBackupDirError(...)`, so an unwritable directory is caught at save time. It records an `admin.appdb_backup_config` audit entry.[^admin-routes]

# Gotchas

- Schedule: `APPDB_BACKUP_CRON`, default `30 2 * * *` (nightly 02:30). It is a no-op until a directory is configured.[^scheduler]
- In Docker only mounted paths are writable. `GET /api/admin/settings` returns `appdbBackup.mountedDir` (`DEFAULT_BACKUP_DIR`) so the UI can show it. The host side is chosen by `PROXMATE_BACKUP_DIR`. See [Docker environment](/env/docker-environment.md).
- A snapshot contains the same AES-256-GCM-encrypted secrets as the live DB and is useless without the same `ENCRYPTION_KEY`.[^appdb]

[^appdb]: backend/src/services/appdb-backup.service.ts (`getAppDbBackupConfig`, `saveAppDbBackupConfig`, `DEFAULT_BACKUP_DIR`, `KEEP_DEFAULT`, `APPDB_BACKUP_FILE_RE`)
[^admin-routes]: backend/src/routes/admin.routes.ts (`AppDbBackupSchema`, `PUT /settings/appdb-backup`, `POST /settings/appdb-backup/run`)
[^scheduler]: backend/src/services/scheduler.service.ts (`DEFAULT_APPDB_SCHEDULE`)
