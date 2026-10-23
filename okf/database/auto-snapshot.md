---
type: Prisma Model
title: AutoSnapshot
description: A Proxmox snapshot ProxMate took on its own before a resize, data-disk grow or rescue boot, recorded so retention only ever deletes snapshots it made itself.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
tags: [proxmate, database, prisma, vm, snapshots]
generated: { by: okf-bootstrap/0.1, at: 2026-10-23T12:00:00Z }
sources:
  - id: schema
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
    title: backend/prisma/schema.prisma
  - id: svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/auto-snapshot.service.ts
    title: backend/src/services/auto-snapshot.service.ts
  - id: mig
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/migrations/20261023130000_reliability_reconcile_autosnapshot/migration.sql
    title: backend/prisma/migrations/20261023130000_reliability_reconcile_autosnapshot/migration.sql
---

# Purpose

One row per automatic snapshot (`pm-auto-<op>-<timestamp>`) of a QEMU VM. Retention reads these rows, not snapshot names, to decide what it may delete.[^svc]

# Schema

| Field | Type | Attributes | Description |
|---|---|---|---|
| id | String | `@id @default(cuid())` | Primary key. |
| vmId | String | FK | [VirtualMachine](/database/virtual-machine.md) the snapshot is of. |
| name | String | | Proxmox snapshot name, e.g. `pm-auto-resize-20261023-153000`. |
| op | String | | `resize`, `disk-resize` or `rescue`. |
| snaptime | Int? | | Proxmox's `snaptime` (epoch seconds) read back after the snapshot was taken. |
| createdAt | DateTime | `@default(now())` | |
| | | `@@unique([vmId, name])` | |

Added by migration `20261023130000_reliability_reconcile_autosnapshot`.[^schema] [^mig]

# Relationships

- Belongs to [VirtualMachine](/database/virtual-machine.md), `onDelete: Cascade`.[^schema]

# Invariants

- A row is written only after the snapshot exists on Proxmox. A snapshot whose task outlived the wait is never recorded, so retention never deletes it.[^svc]
- Retention deletes a snapshot only when a row names it AND the live snapshot's `snaptime` matches the row's: a user snapshot that reuses a recorded name is left alone, and a row without a recorded `snaptime` never makes its snapshot deletable. Rows whose snapshot is gone are dropped.[^svc]
- A rebuild deletes the VM's rows: deleting the guest deleted its snapshots.[^svc]

[^schema]: backend/prisma/schema.prisma
[^svc]: backend/src/services/auto-snapshot.service.ts
[^mig]: backend/prisma/migrations/20261023130000_reliability_reconcile_autosnapshot/migration.sql
