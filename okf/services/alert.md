---
type: Backend Service
title: Alert service (per-VM resource alerts)
description: Evaluates tenant-defined per-VM alert rules (cpu, memory, disk, down) against a live cluster sample every 5 minutes and emails the owner plus the admin webhook when a sustained breach fires.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/alert.service.ts
tags: [proxmate, monitoring, alerts, scheduler]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: alert
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/alert.service.ts
    title: backend/src/services/alert.service.ts
  - id: scheduler
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/scheduler.service.ts
    title: backend/src/services/scheduler.service.ts
---

# Purpose

Tenants set thresholds on their own machines. A rule fires when its condition holds continuously for `sustainedMin` minutes (tracked via `breachingSince`), then stays quiet for a cooldown so a flapping metric cannot spam. Delivery is a branded email to the VM owner plus the admin webhook, one of each per VM per tick: rules of one VM that fire together are combined. A VM carries at most `MAX_ALERT_RULES_PER_VM` (20) rules.[^alert]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `ALERT_METRICS` | `['cpu','memory','disk','down']` | Supported metrics; labels in `ALERT_METRIC_LABEL`. |
| `conditionMet` | `(rule, signals: VmSignals) => boolean` | cpu/memory/disk need the guest running and value `>= threshold`; disk also needs a known `diskPct`; `down` = expected running but not running. |
| `describeAlert` | `(rule, signals) => string` | One-line notification body. |
| `evaluateRule` | `(rule, signals, now) => RuleAction` | Pure decision: `fire`, `start-breach`, `clear-breach` or `none`, honouring sustained window and cooldown. |
| `evaluateAlerts` | `(now?) => Promise<{ fired }>` | Loads enabled rules, reads `/cluster/resources` once, computes signals, persists `breachingSince`/`lastFiredAt`, sends notifications. Skips a rule whose VMID holds a guest without the row's ProxMate tag. |

# Data

- [AlertRule](/database/alert-rule.md): reads enabled rules (`metric`, `threshold`, `sustainedMin`); writes `breachingSince`, `lastFiredAt`.[^alert]
- [VirtualMachine](/database/virtual-machine.md): `status` (ProxMate's intended state, used for `down`), `proxmoxVmId`, `proxmoxNode`, `type`.
- [User](/database/user.md): owner email.
- SystemConfig `frontend_url` (or env `FRONTEND_URL`) for the VM link; [smtp](/config/smtp.md); [notifications](/config/notifications.md).
- Env `ALERT_COOLDOWN_MIN` (default 60, minimum 5).[^alert]

# Scheduling

Not its own cron: `evaluateAlerts()` runs at the end of the resource-history tick (`*/5 * * * *`) under the scheduler's `historyRunning` lock.[^scheduler]

# Gotchas

- `cpuPct` is Proxmox `cpu * 100` (fraction of allocated cores); `memPct` is `mem / maxmem`.[^alert]
- Disk % comes from the QEMU guest agent `agent/get-fsinfo` (2 s timeout), only for VMs with an enabled disk rule, memoized per tick; LXC and agent-less guests yield null, so a disk rule never fires for them.[^alert]
- Webhook delivery reuses the `vm.error` event channel, so it is gated by whether `vm.error` is enabled in notification settings.[^alert]
- All DB updates and sends are best-effort; a delivery failure never stops the loop.[^alert]

# Relationships

- Called by the [scheduler](/services/scheduler.md); rules are managed through the [vm router](/api/vm.md).
- Uses [proxmox service](/services/proxmox.md) `getClient`, [mail](/services/mail.md), [notify](/services/notify.md), [config](/services/config.md).
- Shares the sample cadence with [resource-history](/services/resource-history.md).

[^alert]: backend/src/services/alert.service.ts
[^scheduler]: backend/src/services/scheduler.service.ts
