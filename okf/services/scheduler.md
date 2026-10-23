---
type: Backend Service
title: Scheduler service (node-cron jobs)
description: Starts every in-process node-cron job after the HTTP server listens, each guarded by its own in-memory running flag, with env-overridable schedules and boot-time catch-up for weekly backups and access expiry.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/scheduler.service.ts
tags: [proxmate, scheduler, cron, jobs]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T20:00:00Z }
sources:
  - id: sch
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/scheduler.service.ts
    title: backend/src/services/scheduler.service.ts
  - id: index
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/index.ts
    title: backend/src/index.ts
---

# Purpose

Single place where periodic work is registered. `startScheduler()` is called from the `server.listen` callback in `index.ts` and is idempotent (returns if already started).[^sch][^index]

# Schema

| Job | Default schedule | Env override | Lock flag | Service call |
|---|---|---|---|---|
| Weekly MateState backups | `0 3 * * 0` (Sun 03:00) | `MATESTATE_CRON` | `running` | [matestate](/services/matestate.md) `runScheduledBackups`, then sets `matestate_last_run` |
| Weekly backup catch-up | once, 10 s after start | — | `running` | `catchUpMissedBackups` |
| Per-VM power schedules | `* * * * *` | — | `powerRunning` | [power-schedule](/services/power-schedule.md) `runDuePowerActions` (due VMs handled side by side) |
| Per-VM backups | `* * * * *` | — | `backupRunning` | [matestate](/services/matestate.md) `runDueBackups` |
| Cloud-init deploy lock | `* * * * *` | — | `deployLockRunning` | [deploy-lock](/services/deploy-lock.md) `advanceDeployingVms` (`deployLockTick`) |
| Resource history + alerts | `*/5 * * * *` | — | `historyRunning` | [resource-history](/services/resource-history.md) `sampleResourceUsage`, `pruneResourceSamples`; [alert](/services/alert.md) `evaluateAlerts` |
| Cluster balancer | `*/15 * * * *` | `BALANCER_CRON` | `balancerRunning` | [cluster-balancer](/services/cluster-balancer.md) `runAutoBalance` (no-op unless mode `auto`) |
| Template refresh | `0 4 1 * *` (1st, 04:00) | `TEMPLATE_REFRESH_CRON` | `templateRunning` | [template](/services/template.md) `refreshAllTemplates`, only if `template_refresh_enabled === 'true'` |
| App-DB backup | `30 2 * * *` | `APPDB_BACKUP_CRON` | `appDbRunning` | [appdb-backup](/services/appdb-backup.md) `runAppDbBackup` (no-op without a dir) |
| Guest ownership-tag backfill | `*/15 * * * *` | — | `markerRunning` | [vm](/services/vm.md) `runGuestMarkerBackfill`; a no-op once a pass completed without Proxmox errors (also run at boot from index.ts) |
| Malformed stored schedules report | once, 20 s after start | — | — | [power-schedule](/services/power-schedule.md) `reportInvalidStoredCrons` |
| Access-expiry sweep | `20 * * * *` | `ACCESS_EXPIRY_CRON` | `accessRunning` | [access-sweep](/services/access-sweep.md) `runAccessExpiryTick`; also once 15 s after start |
| Weekly usage digest | `0 8 * * 1` (Mon 08:00) | `USAGE_DIGEST_CRON` | `digestRunning` | [usage-digest](/services/usage-digest.md) `runUsageDigest` (`usageDigestTick`); no-op while disabled or SMTP is off; no catch-up |

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `startScheduler` | `() => void` | Registers every job above. |
| `catchUpMissedBackups` | `(now?) => { caughtUp, reason }` | Compares `matestate_last_run` with `previousCronOccurrence(schedule)`; runs the weekly backup if the window was missed. First boot (no marker) only initialises the marker. |

# Data

SystemConfig `matestate_last_run` (ISO timestamp), `matestate_vm_tick_last` (last minute the per-VM backup tick covered) and `template_refresh_enabled` ([template refresh config](/config/template-refresh.md)).[^sch]

# Gotchas

- Locks are plain in-process booleans: a tick is skipped while the previous one is still running. This assumes a single backend process; multiple replicas would each run every job.[^sch]
- The per-VM backup lock is separate from the power lock so a slow vzdump never blocks start/stop.[^sch]
- A per-VM backup tick that fires while the previous one is still running returns at once; the next tick that runs (`perVmBackupTick`) passes the last covered minute as `since`, so schedules that fired meanwhile are still backed up. The marker is also stored as SystemConfig `matestate_vm_tick_last`, so after a restart schedules missed while down (up to 24 h) are caught up.[^sch]
- An invalid `MATESTATE_CRON` logs a warning and falls back to the default; other overrides silently fall back if `cron.validate` fails.[^sch]
- node-cron uses server local time; cron matching inside services (`cronMatches`) also uses local time.[^sch]
- Errors inside each periodic tick are logged and swallowed, and ticks log only when they acted. The weekly backup job (`runWeeklyBackups`) catches and logs an error outside the per-VM loop (per-VM failures are caught in [matestate](/services/matestate.md)); `matestate_last_run` is then left as it was, so the next boot's catch-up retries the window.[^sch]
- Access sweep is hourly because sign-in refusal is already instant; the sweep exists to stop a lapsed tenant's guests burning resources. `:20` avoids the 02:30 app-db snapshot and Sunday 03:00 backups.[^sch]

# Relationships

- Started by `backend/src/index.ts`; see [architecture](/services/architecture.md).
- Uses [config service](/services/config.md) and [power-schedule](/services/power-schedule.md) `previousCronOccurrence`.

[^sch]: backend/src/services/scheduler.service.ts
[^index]: backend/src/index.ts
