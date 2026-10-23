---
type: Backend Service
title: Project service (project tags and rollups)
description: Treats a `project:<name>` VM tag as the VM's project, builds the scoped Projects view with allocation and usage rollups from the DB alone, and moves owned VMs between projects.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/project.service.ts
tags: [proxmate, projects, tags, usage, authorization]
generated: { by: human:r0073dl053r, at: 2026-10-23T12:00:00Z }
sources:
  - id: svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/project.service.ts
    title: backend/src/services/project.service.ts
---

# Purpose

Groups VMs by project without a new table: the project is one entry in `VirtualMachine.tags`, `project:<name>`. A VM is in at most one project, and only its owner or an admin sets it.[^svc]

# Functions

| Function | Notes |
|---|---|
| `normalizeProjectName` | Trim + lowercase, then `^[a-z0-9][a-z0-9_-]{0,31}$`, else null. |
| `projectOf` | The project from a tag CSV; malformed `project:` tags are ignored. |
| `withProject` | Replace (or drop, for null) the project tag, keeping the other tags in order. |
| `rollupProject` | Pure. Totals vCPU/RAM/disk, counts `status === 'running'`, and folds per-VM usage: `avgCpuPct` is the sample-weighted mean CPU fraction ×100; `avgMemBytes` is the sum of each VM's average memory. VMs without samples count toward allocation only. |
| `groupByProject` | Named projects alphabetically, then the no-project group. |
| `getProjectsView` | Tenant: own VMs by project, plus VMs shared with them as one flat group with no tags. Admin: every owner, ordered like the admin VM list. Usage window clamped 1–90 days. |
| `tagsForAccess` | The tag list as a caller may see it: owner and admin get it whole; a sharee gets it without the `project:` tag. Applied by `annotateAccess` (VM list), `GET /api/vms/:id` and `PATCH /api/vms/:id`. |
| `assignProject` | Owner-or-admin per VM (one `findMany` scoped by `userId` for tenants); unknown or foreign ids report `not found`. |

# Gotchas

- Queries: shares, VMs and one `resourceSample.groupBy` by `vmId` (plus users for admins). No Proxmox call and no per-VM query.[^svc]
- ResourceSample only has rows for running VMs, so the averages describe the VM while it was running.
- The plain-label editor can't set a project: the PATCH tag charset has no `:`, and the route re-applies the existing project tag.

# Relationships

- Exposed by the [project router](/api/project.md); samples written by the [resource-history service](/services/resource-history.md).
- Share roles from the [VM-share service](/services/vm-share.md).

[^svc]: backend/src/services/project.service.ts
