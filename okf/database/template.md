---
type: Prisma Model
title: Template
description: A published, cloneable OS build in the Template Store, mapped one-to-one to a Proxmox template VM.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
tags: [proxmate, database, prisma, template, cloud-init]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: schema
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
    title: backend/prisma/schema.prisma
  - id: svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/template.service.ts
    title: backend/src/services/template.service.ts
  - id: sched
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/scheduler.service.ts
    title: backend/src/services/scheduler.service.ts
  - id: tpl-page
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/frontend/src/app/(dashboard)/templates/page.tsx
    title: frontend/src/app/(dashboard)/templates/page.tsx
---

# Purpose

The store of deployable images. A row points at a Proxmox template VM (`proxmoxVmId` on `proxmoxNode`). Tenants deploy by cloning it.[^schema] See [template router](/api/template.md), [template service](/services/template.md), [cloud-init config](/config/cloud-init.md) and [template refresh config](/config/template-refresh.md).

# Schema

| Field | Type | Attributes | Description |
|---|---|---|---|
| id | String | `@id @default(cuid())` | Primary key; stable across refreshes. |
| name | String | | |
| description | String? | | |
| os | String? | | Display label, e.g. "Debian 12". |
| arch | String? | | `amd64` or `arm64`; null = legacy/unknown. Auto-detected from PVE config (`aarch64` -> `arm64`). |
| proxmoxVmId | Int | `@@unique` | The Proxmox template's VMID. |
| proxmoxNode | String | | Node the template lives on. |
| diskGb | Int | `@default(0)` | Base disk = minimum deployable disk. Read from Proxmox `maxdisk` when not supplied. |
| notes | String? | | Admin notes shown to users (e.g. default login creds). |
| cloudInit | Boolean | `@default(false)` | Cloud image: deploy injects SSH key/user. Auto-detected when not asserted. |
| icon | String? | | Custom icon data-URI; null = automatic OS icon. |
| published | Boolean | `@default(true)` | Only published rows appear in the tenant store. |
| sourceUrl | String? | | Upstream cloud-image URL (importer-built templates). |
| refreshedAt | DateTime? | | Last successful refresh. |
| guestAgent | Boolean? | | Whether qemu-guest-agent answered during the build bake; null = never determined. |
| createdAt | DateTime | `@default(now())` | |
| updatedAt | DateTime | `@updatedAt` | |

[^schema] [^svc]

# Relationships

- None. [VirtualMachine](/database/virtual-machine.md) rows do not reference the template they were cloned from.[^schema]

# Invariants

- `register` upserts on `proxmoxVmId` and forces `published: true`. On update it touches `notes` and `guestAgent` only when the caller supplied them, so re-registering keeps admin notes and builder measurements.[^svc]
- `unregister` deletes the Proxmox template VM ("does not exist" is tolerated), then the row. Only a guest that still carries the template's tag (`proxmate-template-<id>`) is deleted; any other guest at that VMID is left in place and admins are notified. When the guest can't be checked the row is kept.[^svc]
- `convertVmToTemplate` deletes the source VM's [VirtualMachine](/database/virtual-machine.md) row (with its IDE credential rows) and registers the template.[^svc]
- `refreshTemplate` only works for `cloudInit` rows with a `sourceUrl`. It rebuilds from the URL, repoints the **same row** to the new VMID/node, re-measures `guestAgent`, sets `refreshedAt`, then deletes the old template VM. Only a guest that still carries the template's tag (`proxmate-template-<id>`) is deleted; any other guest at that VMID is left in place and admins are notified. `refreshAllTemplates` runs on `TEMPLATE_REFRESH_CRON` (default `0 4 1 * *`, when enabled).[^svc] [^sched]

# Gotchas

- Because `proxmoxVmId` changes on refresh, never cache it. Look the row up by `id`.[^svc]
- The backend records `guestAgent` but does not branch on it. It's read by the frontend templates page.[^tpl-page]

[^schema]: backend/prisma/schema.prisma
[^svc]: backend/src/services/template.service.ts
[^sched]: backend/src/services/scheduler.service.ts
[^tpl-page]: frontend/src/app/(dashboard)/templates/page.tsx
