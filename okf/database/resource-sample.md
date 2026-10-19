---
type: Prisma Model
title: ResourceSample
description: A periodic CPU and memory usage sample of one running VM, kept for a rolling window to power the admin per-tenant usage view.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
tags: [proxmate, database, prisma, metrics, usage]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: schema
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
    title: backend/prisma/schema.prisma
  - id: svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/resource-history.service.ts
    title: backend/src/services/resource-history.service.ts
  - id: sched
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/scheduler.service.ts
    title: backend/src/services/scheduler.service.ts
---

# Purpose

Usage history ("who consumed what last week"). It complements the live-only admin monitor.[^svc] See [resource-history service](/services/resource-history.md).

# Schema

| Field | Type | Attributes | Description |
|---|---|---|---|
| id | String | `@id @default(cuid())` | Primary key. |
| userId | String | `@@index` | Owner of the sampled VM (denormalized). |
| vmId | String | | ProxMate VM id (denormalized). |
| cpu | Float | | 0..1 fraction of allocated vCPUs. |
| mem | Float | | Used memory, bytes. |
| maxmem | Float | | Allocated memory, bytes. |
| createdAt | DateTime | `@default(now())`, `@@index` | |

[^schema]

# Relationships

- None. `userId` / `vmId` are plain ids so history outlives deleted [User](/database/user.md) and [VirtualMachine](/database/virtual-machine.md) rows. The aggregator labels unknown users `(deleted user)`.[^schema] [^svc]

# Invariants

- Every 5 minutes (`*/5 * * * *`) the scheduler samples every ProxMate-managed VM that Proxmox `/cluster/resources` reports `running` (qemu and lxc), using `createMany`. It then prunes and evaluates [AlertRule](/database/alert-rule.md)s in the same tick.[^sched] [^svc]
- Retention is `RESOURCE_HISTORY_DAYS` (default 14, minimum 1). Rows with older `createdAt` are deleted every tick.[^svc]
- `getUsageByUser(days)` clamps the window to 1..90 days and returns per-user average CPU %, average memory and peak memory, sorted by average CPU descending.[^svc]

[^schema]: backend/prisma/schema.prisma
[^svc]: backend/src/services/resource-history.service.ts
[^sched]: backend/src/services/scheduler.service.ts
