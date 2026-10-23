---
type: API Router
title: Template router
description: Template Store listing and deploy for users plus admin management of templates, cloud images and cloud-init extras, mounted at /api/templates.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/template.routes.ts
tags: [proxmate, api, templates, cloud-init, provisioning]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/template.routes.ts
    title: backend/src/routes/template.routes.ts
  - id: app
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/app.ts
    title: backend/src/app.ts
---

# Purpose

The Template Store: tenants list published templates and deploy VMs from them (clone + autoscale); admins register Proxmox templates, build cloud-init templates from cloud images, and configure cloud-init features. Mounted at `/api/templates`.[^app]

# Authentication

- `router.use(requireAuth)` then `router.use(enforceMfaSetup)` (also covers `POST /deploy`).[^routes]
- Admin routes add `requireAdmin` per route.[^routes]

# Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/templates` | user | Published templates (`listPublished`). In OpenAPI doc. |
| GET | `/api/templates/cloud-init-status` | user | Which ProxMate extras snippets exist on each node. |
| POST | `/api/templates/deploy` | user (`forUserId`/`quotaExempt` admin-only) | Deploy a VM from a published template; 201 `{ vm, status }`. An admin deploying for a tenant (`forUserId`) emails the tenant after the response ([activity-mail](/services/activity-mail.md)). In OpenAPI doc. |
| POST | `/api/templates/deploy-bulk` | user (`forUserId`/`forUserIds`/`quotaExempt` admin-only) | Deploy several copies: `count` (1..20 for tenants, 1..50 for admins) named from `namePattern` (`{n}` = copy number, required for more than one), or one copy per user in `forUserIds` (admin, max 50). Same sizing and cloud-init fields as `/deploy`. Quota is checked for the whole batch first (403 naming the owner(s), nothing deployed); 202 with the batch `{ id, items: [{ name, userId, vmId, proxmoxVmId, node, status }] }`. Audited `template.deploy_bulk` and `template.deploy_bulk_done`. See [bulk deploy](/services/bulk-deploy.md). |
| GET | `/api/templates/deploy-bulk/:id` | user | A batch's per-copy results (`queued`/`deploying`/`done`/`failed` with `error`); 404 unless the caller started it or is an admin. |
| GET | `/api/templates/all` | admin | All templates including unpublished. |
| GET | `/api/templates/cloud-images` | admin | Curated cloud images with arch (`curatedImagesWithArch`). |
| GET | `/api/templates/cloud-init-extras` | admin | Docker/Tailscale extras status and snippet bundles. |
| POST | `/api/templates/cloud-init-extras/enable` | admin | Enable the `snippets` content type on the snippet storage. |
| GET | `/api/templates/cloud-init-config` | admin | Offered vs always-on (`base`) cloud-init features. |
| PUT | `/api/templates/cloud-init-config` | admin | Set `{ offered: string[], base: string[] }` (each max 64 items of max 64 chars). Audited `cloudinit.config`. |
| POST | `/api/templates/cloud-image` | admin | Build a cloud-init template from an image URL (download, import, convert). Long-running. 201. |
| GET | `/api/templates/discover` | admin | Discover Proxmox templates not yet registered. |
| POST | `/api/templates` | admin | Register an existing Proxmox template `{ proxmoxVmId, node, name, description?, os?, diskGb?, notes?, arch? }`; 201. |
| PATCH | `/api/templates/:id` | admin | Update `notes`, `description`, `icon`; 404 on failure. |
| POST | `/api/templates/:id/refresh` | admin | Rebuild a cloud-image template from its source URL. Audited `template.refresh`. |
| DELETE | `/api/templates/:id` | admin | Unregister; 409 if linked clones still depend on it. |

# Gotchas

- `DeploySchema`: `name` 1..63 `[a-zA-Z0-9-]`, `cpu` int 1..64, `ram` int >= 64 (MB), `storage` positive int, `sshKey` must start with an OpenSSH key type, `username` matches `^[a-z_][a-z0-9_-]{0,31}$`, `password` 1..128, `install*` booleans, `features` max 20.[^routes]
- Deploying a `cloudInit` template without `sshKey` or `password` gives 400. Unpublished or missing template gives 404.[^routes]
- `resolveCreateTarget(actor, body)` decides the owner (admin may deploy into another user's account); `adminManaged` is set when owner differs from actor. Template deploys cannot choose a node: a full clone on shared storage goes to the least-loaded node, anything else stays on the template's node.[^routes]
- Errors: `CreateOptionError` uses its status, `QuotaError` gives 403 `Quota exceeded` with `details`, Proxmox errors 502.[^routes]
- `CloudImageSchema.imageUrl` must be http(s) and end in `.qcow2`, `.img` or `.raw`; `assertPublicHttpUrlShape` additionally blocks private/loopback/metadata targets (SSRF), returning 400.[^routes]
- `icon` must be a raster data URI (`png|jpeg|webp|gif`), max 400,000 chars; SVG is excluded because it can carry script.[^routes]
- `PUT /cloud-init-config` has no Proxmox dependency, so it works during the setup wizard.[^routes]

# Relationships

- Data: [Template](/database/template.md), [VirtualMachine](/database/virtual-machine.md), [SystemConfig](/database/system-config.md) ([cloud-init config](/config/cloud-init.md), [template refresh](/config/template-refresh.md)).
- Services: [template](/services/template.md), [vm](/services/vm.md) (`deployFromTemplate`, `resolveCreateTarget`), [bulk deploy](/services/bulk-deploy.md), [audit](/services/audit.md).
- Converting a VM to a template is `POST /api/vms/:id/convert-template` in the [VM router](/api/vm.md); rebuild-from-template is `POST /api/vms/:id/rebuild`.

[^routes]: backend/src/routes/template.routes.ts
[^app]: backend/src/app.ts
