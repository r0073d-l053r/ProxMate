---
type: Prisma Model
title: MateState
description: A point-in-time Proxmox vzdump backup of a VM ("MateState"), with rolling per-VM retention.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
tags: [proxmate, database, prisma, backup, vzdump]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: schema
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
    title: backend/prisma/schema.prisma
  - id: svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/matestate.service.ts
    title: backend/src/services/matestate.service.ts
  - id: download
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/download.service.ts
    title: backend/src/services/download.service.ts
  - id: bigint-mig
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/migrations/20260703074813_matestate_size_bigint/migration.sql
    title: backend/prisma/migrations/20260703074813_matestate_size_bigint/migration.sql
---

# Purpose

ProxMate's name for a VM backup (always "MateState", never "droplet"). Each row points at a vzdump volume on Proxmox storage.[^schema] See [MateState service](/services/matestate.md) and [storage](/proxmox/storage.md).

# Schema

| Field | Type | Attributes | Description |
|---|---|---|---|
| id | String | `@id @default(cuid())` | Primary key. |
| vmId | String | FK, `@@index` | [VirtualMachine](/database/virtual-machine.md) id. |
| proxmoxVmId | Int | | VMID the backup was taken of. |
| proxmoxNode | String | | Where the backup currently lives. |
| storage | String | | Proxmox storage holding it. |
| volid | String | `@unique` | e.g. `local:backup/vzdump-qemu-100-...`. Placeholder `pending:<vmid>:<ms>` while creating. |
| size | BigInt | `@default(0)` | Bytes. |
| status | String | `@default("creating")` | `creating`, `ready`, `restoring`, `error`. |
| kind | String | `@default("scheduled")` | `scheduled` or `manual`. |
| notes | String? | | |
| createdAt | DateTime | `@default(now())` | |
| updatedAt | DateTime | `@updatedAt` | |

[^schema] [^svc]

# Relationships

- Belongs to [VirtualMachine](/database/virtual-machine.md), `onDelete: Cascade`.[^schema]
- Referenced by scalar `mateStateId` from [DownloadToken](/database/download-token.md).[^schema] [^download]

# Invariants

- Creation inserts a `creating` placeholder, runs vzdump in `snapshot` mode (waits up to 30 min), finds the new volid by diffing the storage listing, then sets `ready` with the real volid and size. Any failure sets `error`.[^svc]
- After each successful backup, `pruneOldMateStates` keeps only the newest N `ready` rows. N is the VM's `backupKeep`, or `MATESTATE_RETENTION` = 2. It deletes the Proxmox file best-effort, then the row.[^svc]
- Backup storage comes from the `backup_storage` [SystemConfig](/database/system-config.md) key; if unset, the first storage with `backup` content is picked and saved there.[^svc]
- Restore requires `status === 'ready'` and a matching `vmId`. The row is `restoring` during the operation and returns to `ready` afterwards.[^svc]

# Gotchas

- `size` is a BigInt (migration `matestate_size_bigint`) because real backups exceed Int32. Use `serializeMateState` before sending JSON.[^svc] [^bigint-mig]
- Deleting a VM cascades its MateState rows, but the vzdump files on Proxmox are left behind. `deleteBackup` is only called by retention pruning, a manual MateState delete and restore-upload cleanup.[^schema] [^svc]

[^schema]: backend/prisma/schema.prisma
[^svc]: backend/src/services/matestate.service.ts
[^download]: backend/src/services/download.service.ts
[^bigint-mig]: backend/prisma/migrations/20260703074813_matestate_size_bigint/migration.sql
