---
type: Backend Service
title: Template service (Template Store and cloud-image builder)
description: Manages the Template Store (register, discover, convert, unregister), builds cloud-init templates from cloud-image URLs with a guest-agent bake, refreshes them monthly, and holds the admin cloud-init feature/snippet configuration.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/template.service.ts
tags: [proxmate, templates, cloud-init, images, scheduler]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: tpl
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/template.service.ts
    title: backend/src/services/template.service.ts
  - id: scheduler
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/scheduler.service.ts
    title: backend/src/services/scheduler.service.ts
---

# Purpose

Templates are Proxmox template VMs registered as [Template](/database/template.md) rows; published ones appear in the tenant Template Store.[^tpl]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `listPublished` / `listAll` | `()` | Store view (published) / admin view. |
| `discover` | `()` | Proxmox templates not yet registered, with disk GB and arch (arm64 if on an arm64 node, else amd64). |
| `register` | `(input: RegisterTemplateInput) => Template` | Upsert by `proxmoxVmId`; auto-detects disk size, `cloudInit` (`isCloudInitTemplate`) and arch (`aarch64` → arm64) when not given; sets `published: true`. Tags the template's guest `proxmate-template-<id>` (best-effort; the scheduled ownership-tag backfill retries), so it reads as no machine's. |
| `updateTemplate` | `(id, { notes?, description?, icon? })` | Admin edits. |
| `unregister` | `(id)` | Deletes the Proxmox template VM (tolerates already gone) then the row; rethrows other errors (e.g. "still has linked clones"), keeping the row. Only a guest that still carries the template's tag (`proxmate-template-<id>`) is deleted; any other guest at that VMID is left in place and admins are notified. |
| `convertVmToTemplate` | `(vm, meta)` | Refused unless the guest is the row's own (`requireOurGuest`) and has no PCI/GPU passthrough. Stops, converts on Proxmox, deletes the VirtualMachine row and its IDE credential rows in one transaction, registers the template. |
| `CURATED_IMAGES` / `curatedImagesWithArch` / `archFromImageUrl` | consts / helpers | Vetted qcow2/img cloud images (Debian, Ubuntu, Fedora, Alma, Rocky, CentOS Stream, Oracle, openSUSE, Arch, ARM64 variants); arch inferred from `arm64`/`aarch64` in the URL. |
| `addCloudImage` | `(input) => Template` | `buildCloudTemplateVm` then `register` with `cloudInit: true`, `sourceUrl`, measured `guestAgent`. |
| `refreshTemplate` | `(id)` | Rebuild from `sourceUrl`, repoint the SAME row (id/name/notes/icon kept), set `refreshedAt`, tag the new template guest `proxmate-template-<id>`, delete the old template VM. Only a guest that still carries the template's tag (`proxmate-template-<id>`) is deleted; any other guest at that VMID is left in place and admins are notified. |
| `refreshAllTemplates` | `() => { refreshed, failed }` | Every `cloudInit` template with a `sourceUrl`. |
| `getOfferedFeatureIds` / `getBaseFeatureIds` / `setCloudInitConfig` / `getCloudInitConfig` | | Admin choice of cloud-init catalog features offered to tenants vs always-on base, validated against `pve.CLOUD_INIT_CATALOG`. |
| `getSnippetStorage` | `()` | `iso_storage` or `local`. |
| `getCloudInitExtras` / `cloudInitStatus` | `()` | Admin snippet view (bundles of feature combos with copy-paste commands, per-node readiness in manual mode) / lightweight wizard status. |
| `enableCloudInitSnippets` | `()` | Enables the `snippets` content type on the snippet storage. |

# Steps

`buildCloudTemplateVm` (internal):[^tpl]

1. Require `default_storage` and `default_bridge`; arch from URL unless pinned; node from `pickBestNode` matching arch unless given.
2. Pick an import-capable storage on the node (prefer `iso_storage`); download the image via `download-url` (15 min timeout).
3. Take the next VMID only now (after the download), then `createCloudInitVm` importing the disk (10 min), read disk size.
4. `bakeGuestAgent`: write a `guest-agent` cloud-init snippet, set `cicustom`, `ipconfig0=ip=dhcp`, `agent=enabled=1`, boot, poll the agent up to 6 min; on success run `cloud-init clean --logs --seed`, vacuum journals/logs, truncate `/etc/machine-id`; always shut down and strip `cicustom`/`ipconfig0`.
5. Convert to template, delete the imported image; on failure delete the image, and the VM only if Proxmox accepted this build's own create for that VMID.

# Data

- [Template](/database/template.md): `proxmoxVmId` (unique), `proxmoxNode`, `name`, `description`, `os`, `arch`, `diskGb`, `cloudInit`, `published`, `notes`, `icon`, `sourceUrl`, `guestAgent` (true/false/null = unknown), `refreshedAt`.[^tpl]
- [VirtualMachine](/database/virtual-machine.md) (deleted on convert).
- SystemConfig `default_storage`, `default_bridge`, `iso_storage` ([provisioning defaults](/config/provisioning-defaults.md)); `cloudinit_offered`, `cloudinit_base` (JSON arrays; [cloud-init config](/config/cloud-init.md)); `template_refresh_enabled` ([template refresh](/config/template-refresh.md)).
- Snippet env `SNIPPET_DIR` / `SNIPPET_STORAGE` (via `pve.snippetWriteConfig`) for on-demand snippet writing.

# Scheduling

`refreshAllTemplates()` on env `TEMPLATE_REFRESH_CRON`, default `0 4 1 * *` (1st of month 04:00), only when SystemConfig `template_refresh_enabled === 'true'`; guarded by `templateRunning`.[^scheduler]

# Gotchas

- Why the bake exists: login passwords are applied in-guest via the agent, never as `cipassword` (whose hash would be tenant-readable on the seed drive and `/var/lib/cloud`). The importer otherwise never boots the image, so every UI-built template shipped agentless.[^tpl]
- The bake never throws or fails the build (clusters without egress still need templates); the outcome is stored in `guestAgent`. No writable snippet storage → `null` (not attempted).[^tpl]
- The bake uses DHCP on the admin's configured bridge deliberately; baking elsewhere would misstate provenance and could cross an isolation boundary.[^tpl]
- `cloud-init clean` is non-optional (else the bake boot's user-data/instance state leaks into every clone); journal vacuum was added after a deployed guest was seen holding the bake VM's DHCP address (2026-08-11). `machine-id` is truncated, not deleted, because a missing file breaks some images' early boot.[^tpl]
- `register` only updates `notes` / `guestAgent` when supplied, so re-registering never wipes admin credentials notes or a builder measurement.[^tpl]
- Comments disagree on clone type: `unregister` says ProxMate deploys are linked clones (so deletion fails while clones exist), while `refreshTemplate` says cloud-init templates are FULL-cloned (so the old template can be deleted). The deploy path ([vm service](/services/vm.md) `planTemplateClone`) settles it: `cloudInit` templates are always full-cloned; other templates are linked-cloned unless the configured disk pool differs from where the template lives.[^tpl]
- Fedora and Oracle curated URLs pin specific builds and may need bumping.[^tpl]
- Bundles enumerate all feature combinations only up to 8 offered features (2^n); beyond that singles only.[^tpl]

# Relationships

- Called by the [template router](/api/template.md), [vm router](/api/vm.md) and the [scheduler](/services/scheduler.md); used by [vm service](/services/vm.md) for deploys.
- Uses [proxmox service](/services/proxmox.md) and [config](/services/config.md). Deploy-time agent use: [deploy-lock](/services/deploy-lock.md). Proxmox side: [storage](/proxmox/storage.md), [guest lifecycle](/proxmox/guest-lifecycle.md).

[^tpl]: backend/src/services/template.service.ts
[^scheduler]: backend/src/services/scheduler.service.ts
