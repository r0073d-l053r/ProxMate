---
type: Backend Service
title: Access-sweep service (access-window warnings and suspension)
description: Hourly sweep that emails tenants 7 and 1 days before their compute-access window closes and powers off lapsed tenants' guests, latching a suspension and notifying admins.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/access-sweep.service.ts
tags: [proxmate, access-expiry, scheduler, tenancy]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: sweep
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/access-sweep.service.ts
    title: backend/src/services/access-sweep.service.ts
  - id: scheduler
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/scheduler.service.ts
    title: backend/src/services/scheduler.service.ts
---

# Purpose

The periodic half of tenant compute-access windows. Per-request enforcement (refusing sign-in, HTTP, WebSocket, API tokens) is instantaneous and lives in [access service](/services/access.md); this sweep handles side effects that cannot happen inside a request: warning emails and powering off a lapsed tenant's guests. Nothing here is destructive: no VM, disk, backup or account is deleted.[^sweep]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `runAccessExpiryTick` | `(now = new Date()) => Promise<{ warned, suspended, stopped }>` | One pass: `sendWarnings` then `suspendLapsed`. The only export. |
| `sendWarnings` (internal) | `(now) => Promise<number>` | Non-admin users with `accessExpiresAt` in `(now, now+7d]`; sends the 1-day or 7-day `accessExpiringEmail`, then stamps `accessWarned1For`/`accessWarned7For` with the deadline. |
| `suspendLapsed` (internal) | `(now) => Promise<{ suspended, stopped }>` | Non-admin users with `accessExpiresAt <= now`; stops their running/paused guests, sets `accessSuspendedAt` on the first pass, audits, and calls `notify({ event: 'access.expired' })`. |

# Data

- [User](/database/user.md): reads `role`, `accessExpiresAt`, `accessSuspendedAt`, `displayName`, `email`, VM count; writes `accessWarned7For`, `accessWarned1For`, `accessSuspendedAt`.[^sweep]
- [VirtualMachine](/database/virtual-machine.md): reads the tenant's VMs; stops them through `vm.service.stopVm`.
- [AuditLog](/database/audit-log.md): writes `vm.stop` (actor null) and `admin.access_suspended`.
- SystemConfig `frontend_url` (falls back to env `FRONTEND_URL`) for the dashboard link; SMTP via [smtp config](/config/smtp.md); admin alert via [notifications config](/config/notifications.md).

# Scheduling

Runs on cron `20 * * * *` (hourly at :20), overridable with env `ACCESS_EXPIRY_CRON`; plus a catch-up tick 15 s after boot so a window that closed while the backend was down is not given a free extra hour. Guarded by the scheduler's `accessRunning` lock.[^scheduler]

# Gotchas

- Warning columns store WHICH deadline was warned, not a flag: no double-send per deadline, extending the window re-arms both warnings, and a missed tick still warns late (range predicate).[^sweep]
- No SMTP configured → nothing is stamped, so warnings still fire once SMTP is set up. A failed send is still stamped (one attempt per deadline per level) so a bad address does not re-send forever.[^sweep]
- If less than a day remains when armed, only the 1-day mail is sent but both columns are stamped.[^sweep]
- The lapsed query deliberately does NOT filter on `accessSuspendedAt: null`: the latch controls the one-shot notification, not the power-off. First pass sends a graceful stop; later passes force a hard stop (`stopVm(vm, !firstPass)`) for guests that ignored ACPI.[^sweep]
- Live status is read from Proxmox, not the DB, because `stopVm` writes `status: 'stopped'` whether or not the guest went down. A status-read failure counts as "still running" for the next tick.[^sweep]
- Admins are excluded (`role: { not: 'admin' }`) even if they were promoted after an invite set an expiry.[^sweep]
- Restoring access is done by an admin extending the window (or setting never) in Admin → Users.[^sweep]

# Relationships

- Invoked only by the [scheduler](/services/scheduler.md).
- Uses [vm service](/services/vm.md) `stopVm`/`kindOf`, [proxmox service](/services/proxmox.md) `getVmStatus`, [mail](/services/mail.md), [notify](/services/notify.md), [audit](/services/audit.md), [config](/services/config.md).
- Policy defined in [access service](/services/access.md); Proxmox stop semantics in [guest lifecycle](/proxmox/guest-lifecycle.md).

[^sweep]: backend/src/services/access-sweep.service.ts
[^scheduler]: backend/src/services/scheduler.service.ts
