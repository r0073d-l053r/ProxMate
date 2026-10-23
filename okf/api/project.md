---
type: API Router
title: Project router
description: Tenant and admin Projects view (VMs grouped by a project tag with allocation and usage rollups) and moving VMs into or out of a project, mounted at /api/projects.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/project.routes.ts
tags: [proxmate, api, projects, tags, usage]
generated: { by: human:r0073dl053r, at: 2026-10-23T12:00:00Z }
sources:
  - id: routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/project.routes.ts
    title: backend/src/routes/project.routes.ts
  - id: svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/project.service.ts
    title: backend/src/services/project.service.ts
  - id: app
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/app.ts
    title: backend/src/app.ts
---

# Purpose

Backs the **Projects** page: a project is a `project:<name>` tag on a VM (see the [project service](/services/project.md)). Mounted at `/api/projects`.[^app]

# Authentication

- `router.use(requireAuth)` + `enforceMfaSetup`, like the [VM router](/api/vm.md).[^routes]

# Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/projects` | user | `?days=1..90` (default 7). Returns `{ days, owners: [{ owner, projects }], shared }`. Each project: `name` (null = no project), `vmCount`, `running`, `cpu`, `ram` (MB), `storage` (GB), `usage { samples, avgCpuPct, avgMemBytes }`, `vms`. A tenant gets one owner entry (their own VMs) plus `shared`; an admin gets every owner and `shared: null`. |
| POST | `/api/projects/assign` | user | Body `{ ids: string[1..50], project: string \| null }`. Sets or clears the project on each VM the caller owns (admins: any VM); others come back `{ ok: false, error: "not found" }`. Returns `{ project, results }`. Audited `vm.project` once per VM moved. |

# Gotchas

- Project names are trimmed and lowercased, then must match `^[a-z0-9][a-z0-9_-]{0,31}$`; anything else is a 400. An empty string is treated as `null` (clear).[^routes]
- The view makes no Proxmox call: `running` is the row status the VMs list shows, and usage comes from [ResourceSample](/database/resource-sample.md) in one grouped query.[^svc]
- `shared` is one flat group with no tags and no project names; each VM carries the caller's share role as `access`. Sharees cannot move a VM between projects.[^svc]
- Project power actions are sent to `POST /api/vms/bulk` by the UI, so the bulk route's owner check and per-VM locks apply unchanged.

# Relationships

- Reads and writes `tags` on [VirtualMachine](/database/virtual-machine.md); shares from [VmShare](/database/vm-share.md).
- `PATCH /api/vms/:id` `tags` on the [VM router](/api/vm.md) keeps the project tag.
- Audit via the [audit service](/services/audit.md).

[^routes]: backend/src/routes/project.routes.ts
[^svc]: backend/src/services/project.service.ts
[^app]: backend/src/app.ts
