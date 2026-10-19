---
type: Configuration Group
title: Cloud-init feature selection
description: SystemConfig keys recording which cloud-init catalog features are offered to tenants as checkboxes and which are always installed on every cloud-init VM.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/template.service.ts
tags: [proxmate, config, cloud-init, templates]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: template-svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/template.service.ts
    title: backend/src/services/template.service.ts
  - id: template-routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/template.routes.ts
    title: backend/src/routes/template.routes.ts
  - id: pve
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/proxmox.service.ts
    title: backend/src/services/proxmox.service.ts
  - id: setup-page
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/frontend/src/app/(setup)/setup/defaults/page.tsx
    title: frontend/src/app/(setup)/setup/defaults/page.tsx
---

# Purpose

These keys shape the cloud-init "extras" catalog (`CLOUD_INIT_CATALOG` = `CLOUD_INIT_FEATURES` + `CLOUD_INIT_BASE`, defined in proxmox.service.ts). Feature ids include `docker`, `tailscale`, `guest-agent`, `superfile`, `cockpit`, `netdata`, `caddy`, `code-server`, `unattended-upgrades`, `fail2ban` and `btop`.[^pve] Both keys are JSON arrays of feature ids, and both readers and the writer filter them against the catalog.[^template-svc] The snippet files themselves live on the `iso_storage` storage (see [provisioning defaults](/config/provisioning-defaults.md)).

# Schema

| Key | Value format | Default / when unset | Written by | Read by | Description |
|---|---|---|---|---|---|
| `cloudinit_offered` | JSON array of catalog feature ids (deduped, unknown ids dropped) | Unset, empty or unparseable: `DEFAULT_OFFERED_IDS` (every id in `CLOUD_INIT_FEATURES`) | `setCloudInitConfig` ← `PUT /api/templates/cloud-init-config` (from the setup wizard's defaults page and from the Templates page) | `getOfferedFeatureIds`, `getCloudInitConfig` | Features tenants see as opt-in checkboxes. |
| `cloudinit_base` | JSON array of catalog feature ids | Unset or unparseable: `[]` (none). The wizard **pre-selects** `RECOMMENDED_BASE_IDS` (`CLOUD_INIT_BASE`), but nothing is stored until it saves | same | `getBaseFeatureIds`, `getCloudInitConfig` | Features installed on **every** cloud-init VM. |

# Validation

`CloudInitConfigSchema` (template.routes.ts): `offered` and `base` are each an array of `z.string().max(64)`, max 64 items. An invalid body returns 400 `Invalid feature selection.` The route requires admin (`requireAdmin`, after the router-wide `requireAuth` and `enforceMfaSetup`). It records a `cloudinit.config` audit entry and returns the updated config.[^template-routes]

# Gotchas

- `GET /api/templates/cloud-init-config` has no Proxmox dependency, so it works while the setup wizard is running. The wizard's admin session from step 1 satisfies `requireAdmin`.[^template-routes][^setup-page]

# Relationships

- [Templates API](/api/template.md), [templates service](/services/template.md)

[^template-svc]: backend/src/services/template.service.ts (`getOfferedFeatureIds`, `getBaseFeatureIds`, `setCloudInitConfig`)
[^template-routes]: backend/src/routes/template.routes.ts (`GET/PUT /cloud-init-config`, `CloudInitConfigSchema`)
[^pve]: backend/src/services/proxmox.service.ts (`CLOUD_INIT_FEATURES`, `CLOUD_INIT_BASE`, `CLOUD_INIT_CATALOG`, `DEFAULT_OFFERED_IDS`, `RECOMMENDED_BASE_IDS`)
[^setup-page]: frontend/src/app/(setup)/setup/defaults/page.tsx
