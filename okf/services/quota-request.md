---
type: Backend Service
title: Quota-request service
description: Tenant requests for higher absolute CPU/RAM/storage caps and the admin approve/deny queue that applies them.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/quota-request.service.ts
tags: [proxmate, quota, tenancy, admin]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: qr
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/quota-request.service.ts
    title: backend/src/services/quota-request.service.ts
---

# Purpose

Lets a tenant ask for new quota caps; an admin reviews and approves (caps applied) or denies.[^qr]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `QuotaRequestError` | `(message, status = 400)` | Carries an HTTP status for the route. |
| `createQuotaRequest` | `(userId, { cpu, ram, storage, reason? })` | One pending request per user (409 otherwise); values are absolute target caps. |
| `listMyQuotaRequests` | `(userId)` | Newest first. |
| `listPendingQuotaRequests` | `() => PendingQuotaRequest[]` | Oldest first, with requester's current `maxCpu/maxRam/maxStorage`. |
| `approveQuotaRequest` | `(id, adminId)` | Transaction: set user caps to requested values, mark `approved`, `resolvedAt`, `resolvedById`. 404/409 on missing/resolved. |
| `denyQuotaRequest` | `(id, adminId)` | Mark `denied`; quota untouched. |

# Data

[QuotaRequest](/database/quota-request.md) (`cpu`, `ram`, `storage`, `reason`, `status`, `resolvedAt`, `resolvedById`) and [User](/database/user.md) `maxCpu`, `maxRam`, `maxStorage`.[^qr]

# Gotchas

- Approving REPLACES caps with the requested values (not additive); a request lower than current caps lowers them.[^qr]

# Relationships

- Called by the [quota-request router](/api/quota-request.md) and [admin router](/api/admin.md). Quota enforcement is in [vm service](/services/vm.md).

[^qr]: backend/src/services/quota-request.service.ts
