---
type: Backend Service
title: Power-schedule service (auto start/stop and cron evaluator)
description: Minimal 5-field cron evaluator plus the per-minute tick that auto-starts and gracefully stops VMs whose `startCron`/`stopCron` fires.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/power-schedule.service.ts
tags: [proxmate, scheduler, cron, power]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T20:00:00Z }
sources:
  - id: power
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/power-schedule.service.ts
    title: backend/src/services/power-schedule.service.ts
  - id: scheduler
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/scheduler.service.ts
    title: backend/src/services/scheduler.service.ts
---

# Purpose

Per-VM power schedules ("at HH:MM on these weekdays") and the shared cron matcher that per-VM backups and the weekly backup catch-up also use.[^power]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `cronMatches` | `(expr, date) => boolean` | 5 fields; supports `*`, numbers, lists, ranges, steps; DOW 0 or 7 = Sunday. Uses local server time (`getHours`, `getDay`). |
| `previousCronOccurrence` | `(expr, now?, maxLookbackMinutes = 8 days) => Date \| null` | Scans backwards minute by minute. |
| `isValidCron` | `(expr) => boolean` | Same grammar; every list item of every field must be well-formed (digits only, no empty items, `lo <= hi`, step > 0) and within the field's range. A malformed field never matches in `cronMatches` (the whole field is parsed before matching). |
| `reportInvalidStoredCrons` | `() => Promise<number>` | Startup check: logs every stored `startCron`/`stopCron`/`backupCron` that fails `isValidCron` and sends one `vm.error` notification listing them. Never throws. |
| `runDuePowerActions` | `(now?) => { started, stopped }` | VMs with `startCron` or `stopCron`; one `/cluster/resources` read (15 s timeout); start if `startCron` fires and not running, else graceful stop if `stopCron` fires and running; audits each. The due VMs are handled side by side, not one after another, because each stop waits for its guest to go down. |

# Data

[VirtualMachine](/database/virtual-machine.md) `startCron`, `stopCron`, `proxmoxVmId`; [User](/database/user.md) `accessSuspendedAt`, `role`; writes [AuditLog](/database/audit-log.md) `vm.start`/`vm.stop` with actor null.[^power]

# Scheduling

`* * * * *` under the scheduler's `powerRunning` lock (skips if the previous tick is still working).[^scheduler]

# Gotchas

- Month/day names (mon, jan) are intentionally NOT supported; the UI generates numeric expressions.[^power]
- VMs of suspended non-admin tenants are excluded so a schedule does not quietly undo an access suspension; admins are exempt because a promoted tenant keeps a stale `accessSuspendedAt` latch.[^power]
- A VM not visible in `/cluster/resources` is skipped this tick; per-VM errors are isolated (a graceful stop the guest ignores is logged, not retried).[^power]
- Stops run concurrently so a few slow shutdowns cannot hold the tick past the next minute, whose schedules would then never fire.[^power]
- The bounded timeout exists so a hung Proxmox cannot wedge the per-minute lock.[^power]

# Relationships

- Called by the [scheduler](/services/scheduler.md) and the [vm router](/api/vm.md) (validation).
- Uses [vm service](/services/vm.md) `startVm`/`stopVm`, [proxmox service](/services/proxmox.md), [audit](/services/audit.md). `cronMatches` is used by [matestate](/services/matestate.md).

[^power]: backend/src/services/power-schedule.service.ts
[^scheduler]: backend/src/services/scheduler.service.ts
