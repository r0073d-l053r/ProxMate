---
type: Backend Service
title: Audit service
description: Never-throwing append-only audit log writer plus paginated and per-target readers, with real-client-IP extraction behind a proxy.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/audit.service.ts
tags: [proxmate, audit, logging, security]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: audit
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/audit.service.ts
    title: backend/src/services/audit.service.ts
---

# Purpose

Records dotted-verb audit events (e.g. `vm.create`, `auth.login`) and serves them to the admin log and the per-VM activity feed.[^audit]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `recordAudit` | `({ action, actor?, targetType?, targetId?, detail?, req? }) => Promise<void>` | Inserts one row; `actor` null for anonymous/system; IP from `req`. Never throws. |
| `listAudit` | `({ limit?, offset? }) => Promise<{ items, total, limit, offset }>` | Newest first; `limit` clamped 1..500 (default 100). |
| `listAuditForTarget` | `(targetType, targetId, limit = 20, { hideActionsByAdminsExcept? })` | Per-target feed, `limit` clamped 1..100; optionally hides rows by admins other than the given owner id. |

# Data

Writes/reads [AuditLog](/database/audit-log.md) (`userId`, `actorEmail`, `action`, `targetType`, `targetId`, `detail`, `ip`); reads admin ids from [User](/database/user.md).[^audit]

Env: `REAL_IP_HEADER` (default `cf-connecting-ip`; set empty to disable) and `TRUST_PROXY` (the header is only honoured when it is ≥ 1; `req.ip` applies its hop count) — see [backend environment](/env/backend-environment.md).[^audit]

# Gotchas

- Failures are logged and swallowed: auditing must not break the action being recorded.[^audit]
- Client IP prefers the edge header (`CF-Connecting-IP`) because behind a proxy `req.ip` is the same for every request unless `TRUST_PROXY` is configured. The header is only read when `TRUST_PROXY` ≥ 1 (with no proxy, a client could set it itself); with `REAL_IP_HEADER=x-forwarded-for` the address is `req.ip`, which Express derives from XFF using the trusted hop count. Otherwise falls back to `req.ip`, then the socket address.[^audit]
- Tenant VM feed (owner decision 2026-07-11): admin interventions are filtered out at read time; rows kept when actor is null, non-admin, or the admin who is the owner. Retroactive, and the write path is untouched.[^audit]

# Relationships

- Written by most routers: [admin](/api/admin.md), [auth](/api/auth.md), [vm](/api/vm.md), [user](/api/user.md), [template](/api/template.md), [api-token](/api/api-token.md), [ide](/api/ide.md), [quota-request](/api/quota-request.md), [passthrough-request](/api/passthrough-request.md), [broadcast](/api/broadcast.md).
- Written by services [cluster-balancer](/services/cluster-balancer.md), [access-sweep](/services/access-sweep.md), [account-lockout](/services/account-lockout.md), [power-schedule](/services/power-schedule.md), [passthrough-request](/services/passthrough-request.md).

[^audit]: backend/src/services/audit.service.ts
