---
type: API Router
title: Quota request router
description: Tenant endpoints to ask an admin for a higher CPU/RAM/storage quota and list their own requests, mounted at /api/quota-requests.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/quota-request.routes.ts
tags: [proxmate, api, quota, requests]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/quota-request.routes.ts
    title: backend/src/routes/quota-request.routes.ts
  - id: app
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/app.ts
    title: backend/src/app.ts
---

# Purpose

Tenant side of the quota-raise workflow; admins approve/deny under `/api/admin/quota-requests` (see [admin router](/api/admin.md)). Mounted at `/api/quota-requests`.[^app]

# Authentication

- `router.use(requireAuth)` only. No `enforceMfaSetup` here (unlike most tenant routers).[^routes]

# Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/quota-requests` | user | Body `{ cpu, ram, storage, reason? }`. Creates a request; 201 `{ success: true }`. Audited `quota.request` with `"<cpu> vCPU / <ram> MB / <storage> GB"`. |
| GET | `/api/quota-requests/mine` | user | Caller's requests: `id, cpu, ram, storage, reason, status, createdAt, resolvedAt`. |

# Gotchas

- zod `CreateSchema`: `cpu` int 1..1024; `ram` positive int (MB); `storage` positive int (GB); `reason` optional max 1000.[^routes]
- `QuotaRequestError` maps to its `status`; other errors give 500 `Failed to submit request`.[^routes]
- Approval semantics (what the requested numbers do to the user's quota) live in the service, not this router.

# Relationships

- Persists [QuotaRequest](/database/quota-request.md) for a [User](/database/user.md) via the [quota-request service](/services/quota-request.md).
- Audit via the [audit service](/services/audit.md) into [AuditLog](/database/audit-log.md).
- Approval: [admin router](/api/admin.md); direct quota edits: [user router](/api/user.md).

[^routes]: backend/src/routes/quota-request.routes.ts
[^app]: backend/src/app.ts
