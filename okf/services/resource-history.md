---
type: Backend Service
title: Resource-history service (per-tenant usage samples)
description: Samples every running managed VM's CPU and memory every 5 minutes into ResourceSample, prunes a rolling window, and aggregates usage per owner for the admin usage view.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/resource-history.service.ts
tags: [proxmate, monitoring, usage, scheduler]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: rh
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/resource-history.service.ts
    title: backend/src/services/resource-history.service.ts
  - id: scheduler
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/scheduler.service.ts
    title: backend/src/services/scheduler.service.ts
---

# Purpose

Answers "who consumed what last week", complementing the live-only admin monitor ([live-stats](/services/live-stats.md)). Samples are denormalised (userId stored on each row) and pruned.[^rh]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `sampleResourceUsage` | `() => { sampled }` | One `/cluster/resources` call (15 s timeout); `createMany` rows for VMs whose live status is `running` and whose guest carries the row's ProxMate tag. |
| `pruneResourceSamples` | `(now?) => number` | Deletes samples older than `RESOURCE_HISTORY_DAYS`. |
| `aggregateUsage` | `(samples, users) => UserUsage[]` | Pure fold: `samples, avgCpuPct, avgMemBytes, peakMemBytes` per user; unknown ids → `(deleted user)`; sorted by avg CPU desc. |
| `getUsageByUser` | `(days = 7, now?)` | Window clamped 1..90 days. |

# Data

Writes/reads [ResourceSample](/database/resource-sample.md) (`userId, vmId, cpu, mem, maxmem, createdAt`); reads [VirtualMachine](/database/virtual-machine.md) and [User](/database/user.md). Env `RESOURCE_HISTORY_DAYS` (default 14, min 1).[^rh]

# Scheduling

`*/5 * * * *` under `historyRunning`: sample, prune, then [alert](/services/alert.md) `evaluateAlerts()` in the same tick.[^scheduler]

# Gotchas

- `cpu` is Proxmox's fraction of allocated cores; `avgCpuPct` multiplies by 100.[^rh]
- Stopped VMs produce no samples, so averages are over running time only.[^rh]

# Relationships

- Called by the [scheduler](/services/scheduler.md) and [admin router](/api/admin.md).
- Uses [proxmox service](/services/proxmox.md) `getClient`.

[^rh]: backend/src/services/resource-history.service.ts
[^scheduler]: backend/src/services/scheduler.service.ts
