---
type: Prisma Model
title: AlertRule
description: A tenant-defined threshold alert on one VM (cpu, memory, disk or down), evaluated every 5 minutes and delivered by email and admin webhook.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
tags: [proxmate, database, prisma, alerts, monitoring]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: schema
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
    title: backend/prisma/schema.prisma
  - id: svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/alert.service.ts
    title: backend/src/services/alert.service.ts
  - id: vm-routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/vm.routes.ts
    title: backend/src/routes/vm.routes.ts
  - id: sched
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/scheduler.service.ts
    title: backend/src/services/scheduler.service.ts
---

# Purpose

Per-VM alerts managed under `/api/vms/:id/alerts`. Listing needs view access. Creating and deleting need the `configure` capability, and a delete is scoped to the VM.[^vm-routes] See [vm router](/api/vm.md) and [notifications config](/config/notifications.md).

# Schema

| Field | Type | Attributes | Description |
|---|---|---|---|
| id | String | `@id @default(cuid())` | Primary key. |
| vmId | String | FK, `@@index` | [VirtualMachine](/database/virtual-machine.md). |
| userId | String | `@@index` | VM owner at creation time (denormalized, no FK). |
| metric | String | | `cpu`, `memory`, `disk`, `down`. |
| threshold | Int | `@default(0)` | Percent 1..100 (route validation); stored 0 for `down`. |
| sustainedMin | Int | `@default(5)` | Minutes the condition must hold (1..1440). |
| enabled | Boolean | `@default(true)` | Only enabled rules are evaluated. |
| breachingSince | DateTime? | | When the condition first became true; null = not breaching. Service-managed. |
| lastFiredAt | DateTime? | | Last send, for cooldown. Service-managed. |
| createdAt | DateTime | `@default(now())` | |
| updatedAt | DateTime | `@updatedAt` | |

[^schema] [^vm-routes]

# Relationships

- Belongs to [VirtualMachine](/database/virtual-machine.md), `onDelete: Cascade`.[^schema]

# Invariants

- Conditions: `cpu`/`memory`/`disk` need the guest running and value >= threshold. Disk is the fullest filesystem via the QEMU guest agent, so it's never available for LXC. `down` fires when ProxMate's recorded `status` is `running` but Proxmox reports it not running.[^svc]
- A rule fires once the breach has lasted `sustainedMin` minutes **and** the cooldown has elapsed. The cooldown is `ALERT_COOLDOWN_MIN`, default 60, minimum 5.[^svc]
- Evaluation runs on the 5-minute resource-history scheduler tick.[^sched]
- Delivery: email to the VM's current owner (if SMTP is configured) plus `notifyWebhook` with event `vm.error`, one of each per VM per tick (rules that fire together are combined).[^svc]
- At most 20 rules per VM, and no two with the same `metric` and `threshold`; the create route refuses others with 409.[^vm-routes]

# Gotchas

- `threshold` is required by the route for non-`down` metrics, even though the Zod schema marks it optional.[^vm-routes]
- The email goes to the VM's live `userId`, not the rule's stored `userId`.[^svc]

[^schema]: backend/prisma/schema.prisma
[^svc]: backend/src/services/alert.service.ts
[^vm-routes]: backend/src/routes/vm.routes.ts
[^sched]: backend/src/services/scheduler.service.ts
