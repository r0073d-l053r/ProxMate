---
type: Prisma Model
title: DownloadToken
description: A single-use one-hour token, emailed to a tenant, that streams one MateState backup file off an admin-mounted backup share.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
tags: [proxmate, database, prisma, backup, download]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: schema
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
    title: backend/prisma/schema.prisma
  - id: svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/download.service.ts
    title: backend/src/services/download.service.ts
  - id: routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/download.routes.ts
    title: backend/src/routes/download.routes.ts
---

# Purpose

The Proxmox API can't stream vzdump bytes. So when the admin mounts the backup share into the API container and sets `BACKUP_DOWNLOAD_DIR`, a tenant can request a link that streams the file straight off the mount. The raw token exists only in the email; the link is `<appUrl>/api/downloads/<raw>`.[^svc] See [download router](/api/download.md).

# Schema

| Field | Type | Attributes | Description |
|---|---|---|---|
| id | String | `@id @default(cuid())` | Primary key. |
| tokenHash | String | `@unique` | Hex SHA-256 of the raw token (32 random bytes hex). |
| userId | String | | Requester (scalar, for audit). |
| mateStateId | String | | [MateState](/database/mate-state.md) id (scalar, no FK). |
| filename | String | | Validated vzdump basename. |
| expiresAt | DateTime | `@@index` | Now + 1 hour. |
| usedAt | DateTime? | | Set on first use. |
| createdAt | DateTime | `@default(now())` | |

[^schema] [^svc]

# Relationships

- No Prisma relations. `userId` points at a [User](/database/user.md) and `mateStateId` at a [MateState](/database/mate-state.md) by plain id.[^schema]

# Invariants

- Requesting a token needs `BACKUP_DOWNLOAD_DIR` set, SMTP configured, a `ready` MateState belonging to the VM, and the file present on the mount.[^svc]
- `filename` must match `^vzdump-(qemu|lxc)-\d+-[\w.-]+\.(vma|tar)(\.(zst|gz|lzo))?$`. The file is resolved only under `<dir>` or `<dir>/dump`, with a path-relative escape check.[^svc]
- Consumption marks `usedAt` **before** streaming, so a token is single-use even if the transfer is interrupted. Unknown, used, expired and missing tokens all surface as a generic 404.[^svc]
- The download route calls `pruneDownloadTokens` opportunistically. It deletes rows that are expired or already used.[^routes] [^svc]

[^schema]: backend/prisma/schema.prisma
[^svc]: backend/src/services/download.service.ts
[^routes]: backend/src/routes/download.routes.ts
