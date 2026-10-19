---
type: Backend Service
title: App-DB backup service
description: Nightly `VACUUM INTO` snapshot of ProxMate's own SQLite database into an admin-configured directory with filename-scoped rolling retention.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/appdb-backup.service.ts
tags: [proxmate, backup, sqlite, scheduler]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: appdb
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/appdb-backup.service.ts
    title: backend/src/services/appdb-backup.service.ts
  - id: scheduler
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/scheduler.service.ts
    title: backend/src/services/scheduler.service.ts
---

# Purpose

Backs up ProxMate's OWN database (users, VM records, config, encrypted secrets); MateStates cover guests. `VACUUM INTO` writes a consistent snapshot of the live SQLite DB, safe under concurrent writers. Intended to point at an off-host mount (NFS/CIFS).[^appdb]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `appDbBackupFileName` | `(now?) => string` | `proxmate-appdb-YYYYMMDD-HHMMSS.db` (UTC), so lexical order is chronological. |
| `APPDB_BACKUP_FILE_RE` | `/^proxmate-appdb-\d{8}-\d{6}\.db$/` | Only matching files are ever pruned. |
| `DEFAULT_BACKUP_DIR` | env `APPDB_BACKUP_DIR` trimmed, or `''` | Container-side mount target used when never configured. |
| `getAppDbBackupConfig` | `() => Promise<{ dir, keep }>` | `dir` from `appdb_backup_dir` (null → default; explicit `''` = disabled); `keep` 1..365, default 7. |
| `saveAppDbBackupConfig` | `({ dir, keep })` | Writes both keys. |
| `isValidBackupDir` | `(dir) => boolean` | Empty or absolute path only. |
| `explainBackupDirError` | `(dir, err) => string` | Maps `EACCES/EPERM/ENOENT/ENOTDIR/EROFS/ENOSPC` to actionable container-mount advice. |
| `pruneAppDbBackups` | `(dir, keep) => Promise<number>` | Deletes oldest own snapshots beyond `keep`. |
| `runAppDbBackup` | `(now?) => Promise<{ ran, file?, pruned?, reason? }>` | Validates, probes writability, runs `VACUUM INTO`, prunes. No-op with reason when unconfigured. |

# Data

- SystemConfig keys `appdb_backup_dir`, `appdb_backup_keep` — see [appdb-backup config](/config/appdb-backup.md) and [SystemConfig](/database/system-config.md).[^appdb]
- Env `APPDB_BACKUP_DIR` (container side; host side chosen by `PROXMATE_BACKUP_DIR` in `.env`) — see [docker environment](/env/docker-environment.md).

# Scheduling

Cron `30 2 * * *` (nightly 02:30), overridable with env `APPDB_BACKUP_CRON`; guarded by `appDbRunning`. Also triggered by the admin "Back up now" button.[^scheduler]

# Gotchas

- The snapshot contains the same AES-256-GCM-encrypted secrets as the live DB; restoring needs the SAME `ENCRYPTION_KEY`, which must be backed up separately.[^appdb]
- The snapshot file is created empty with mode `0600` before `VACUUM INTO` fills it (SQLite keeps an existing empty file's mode), so it is owner-only for its whole life; it holds the session table in plaintext. A failed VACUUM removes the placeholder so it never counts toward retention.[^appdb]
- A writability probe (`.proxmate-write-test-<pid>`) runs before the VACUUM so a misconfigured dir fails with an explanation instead of a raw SQLite errno.[^appdb]
- It deliberately never widens permissions or falls back to a container-internal path: a backup in the container layer would vanish on rebuild.[^appdb]
- The path is embedded in a SQL literal via `$executeRawUnsafe` with single quotes doubled; the path is admin-configured.[^appdb]

# Relationships

- Called by the [scheduler](/services/scheduler.md) and the [admin router](/api/admin.md).
- Uses [config service](/services/config.md).

[^appdb]: backend/src/services/appdb-backup.service.ts
[^scheduler]: backend/src/services/scheduler.service.ts
