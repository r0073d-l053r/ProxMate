---
type: Backend Service
title: Download service (tenant backup downloads)
description: Emails tenants a single-use, one-hour link that streams a MateState vzdump file straight off an admin-mounted backup share, with path-traversal-hardened file resolution.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/download.service.ts
tags: [proxmate, backup, download, security]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: download
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/download.service.ts
    title: backend/src/services/download.service.ts
---

# Purpose

The Proxmox API cannot stream vzdump bytes, so downloads work only when the admin mounts the backup share into the API container and sets `BACKUP_DOWNLOAD_DIR`. A request mints a token, the link is emailed, and the link streams the file from the mount. Only the token's SHA-256 hash is stored.[^download]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `backupDir` | `() => string \| null` | Trimmed env `BACKUP_DOWNLOAD_DIR`, or null (feature off). |
| `downloadsEnabled` | `() => Promise<boolean>` | Mount configured AND SMTP configured. |
| `filenameFromVolid` | `(volid) => string \| null` | Last path segment, validated against `VZDUMP_RE`. |
| `resolveBackupFile` | `(filename) => string \| null` | Looks in `<dir>` and `<dir>/dump`; verifies the resolved path stays under the root and is a regular file. |
| `requestBackupDownload` | `(mateStateId, vmId, requester, appUrl) => { emailedTo }` | Checks the MateState belongs to the VM and is `ready`, file exists; creates a token (TTL 1 h); emails `<appUrl>/api/downloads/<raw>`. |
| `consumeDownloadToken` | `(raw) => { fullPath, filename }` | Validates hash, unused, unexpired, file present; claims the token (`usedAt`) with a write conditional on it still being unused, before streaming. |
| `pruneDownloadTokens` | `(now?) => number` | Deletes expired or used tokens (opportunistic). |
| `DownloadError` | class | Thrown for every failure. |

# Data

- [DownloadToken](/database/download-token.md): `tokenHash`, `userId`, `mateStateId`, `filename`, `expiresAt`, `usedAt`.[^download]
- [MateState](/database/mate-state.md): `vmId`, `status`, `volid`.
- Env `BACKUP_DOWNLOAD_DIR`; [smtp config](/config/smtp.md).

# Gotchas

- `VZDUMP_RE` = `^vzdump-(qemu|lxc)-\d+-[\w.-]+\.(vma|tar)(\.(zst|gz|lzo))?$`; input is reduced to a basename and must equal it, so nothing path-like passes.[^download]
- Tokens are single-use even if the stream is interrupted (marked used up-front), and under concurrency: only the request whose conditional claim lands gets the file.[^download]
- The route answers any `DownloadError` from consume with a generic 404 so there is no oracle for token guessing.[^download]

# Relationships

- Called by the [vm router](/api/vm.md) (request) and the public [download router](/api/download.md) (consume).
- The write-side twin is [restore-upload](/services/restore-upload.md), which reuses `backupDir()`.
- Backups come from [matestate](/services/matestate.md); uses [mail](/services/mail.md).

[^download]: backend/src/services/download.service.ts
