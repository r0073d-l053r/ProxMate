---
type: API Router
title: Proxmox introspection router
description: Read-only cluster introspection (resources, nodes, ISOs, storage) for any signed-in user, mounted at /api/proxmox.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/proxmox.routes.ts
tags: [proxmate, api, proxmox, cluster]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/proxmox.routes.ts
    title: backend/src/routes/proxmox.routes.ts
  - id: app
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/app.ts
    title: backend/src/app.ts
---

# Purpose

Exposes the cluster data the VM create wizard and settings pages need. All GET; mounted at `/api/proxmox`.[^app]

# Authentication

- `router.use(requireAuth)` then `router.use(enforceMfaSetup)`. Any authenticated role (not admin-only).[^routes]

# Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/proxmox/resources` | user + MFA-enrolled | `getProxmoxResources` from the setup service: `{ storages (image-capable), bridges (guest networks from `getGuestNetworks`: Linux/OVS bridges and SDN VNets with their nodes), nodeCount, isoStorages, backupStorages }`. |
| GET | `/api/proxmox/nodes` | user + MFA-enrolled | Nodes projected to `node, status, maxcpu, maxmem, cpu, mem`. |
| GET | `/api/proxmox/isos` | user + MFA-enrolled | Installable ISOs (`getIsos`). Listed in the OpenAPI doc. |
| GET | `/api/proxmox/storage` | user + MFA-enrolled | Storages projected to `name, type, content`. |

# Gotchas

- Proxmox failures return 502 with `pveMessage(err)`.[^routes]
- No input validation needed (no params/body).

# Relationships

- Calls the [proxmox service](/services/proxmox.md) and [setup service](/services/setup.md); reads connection settings from [SystemConfig](/database/system-config.md) (see [Proxmox connection config](/config/proxmox-connection.md)).
- Proxmox endpoints used: [PVE API surface](/proxmox/pve-api-surface.md), [storage](/proxmox/storage.md), [networking](/proxmox/networking.md).

[^routes]: backend/src/routes/proxmox.routes.ts
[^app]: backend/src/app.ts
