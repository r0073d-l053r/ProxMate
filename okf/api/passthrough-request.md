---
type: API Router
title: Passthrough request router
description: Tenant endpoints to request GPU/PCI passthrough for a VM and list their own requests, mounted at /api/passthrough-requests.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/passthrough-request.routes.ts
tags: [proxmate, api, passthrough, gpu, requests]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/passthrough-request.routes.ts
    title: backend/src/routes/passthrough-request.routes.ts
  - id: app
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/app.ts
    title: backend/src/app.ts
---

# Purpose

Tenant side of the GPU/PCI passthrough workflow. Admins approve/deny under `/api/admin/passthrough-requests` (see [admin router](/api/admin.md)). Mounted at `/api/passthrough-requests`.[^app]

# Authentication

- `router.use(requireAuth)` and `router.use(enforceMfaSetup)` (403 `mfa_setup_required` until a required second factor is enrolled).[^routes]

# Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/passthrough-requests` | user + MFA-enrolled | Body `{ vmId, reason? }`. Caller must own the VM or be an admin (`getOwnedVm`; shares do not qualify) else 404. Creates the request; 201 `{ success: true }`. Audited `passthrough.request`. |
| GET | `/api/passthrough-requests/mine` | user + MFA-enrolled | Caller's requests: `id, vmId, vmName, reason, status, mapping, createdAt, resolvedAt`. |

# Gotchas

- zod `CreateSchema = { vmId: string min 1, reason?: string max 1000 }`.[^routes]
- `PassthroughRequestError` maps to its own `status`; other errors return 500 `Failed to submit request`.[^routes]

# Relationships

- Persists [PassthroughRequest](/database/passthrough-request.md) linked to [VirtualMachine](/database/virtual-machine.md) and [User](/database/user.md) via the [passthrough-request service](/services/passthrough-request.md).
- VM authorization via the [vm service](/services/vm.md) (`getOwnedVm`; the route comment's "co-owner" is not what the function checks); audit via the [audit service](/services/audit.md).
- Approval and attach logic: [admin router](/api/admin.md).

[^routes]: backend/src/routes/passthrough-request.routes.ts
[^app]: backend/src/app.ts
