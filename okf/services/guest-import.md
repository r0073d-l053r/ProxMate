---
type: Backend Service
title: Guest-import service (bring an existing Proxmox guest under management)
description: Lists Proxmox guests ProxMate doesn't manage and imports one for a chosen owner - writes its ownership tag, applies the default bridge and isolation firewall, and counts it toward the owner's quota unless marked exempt.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/guest-import.service.ts
tags: [proxmate, import, onboarding, isolation, quota, admin]
generated: { by: okf-bootstrap/0.1, at: 2026-10-23T12:00:00Z }
sources:
  - id: imp
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/guest-import.service.ts
    title: backend/src/services/guest-import.service.ts
---

# Purpose

ProxMate otherwise only manages guests it created (each carries its row's `proxmate-<row id>` tag). An admin can import an existing QEMU VM or LXC container for an owner: a row is written from the guest's own config (cores, memory, disk sizes), the guest gets the row's tag with its other tags kept, then the same network placement and isolation a new guest gets (`reapplyIsolation`: default bridge, isolation firewall and VLAN, per-NIC firewall flag, trunks removed). The row counts toward the owner's quota unless the admin marks it quota-exempt. Audited `vm.import`.[^imp]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `listImportableGuests` | `() => Promise<ImportableGuest[]>` | One `/cluster/resources?type=vm` read: QEMU/LXC guests whose VMID no row or Template Store entry references, with no ProxMate tag, that are not Proxmox templates. |
| `importGuest` | `(actor, { vmid, owner, quotaExempt?, adminManaged? }) => Promise<VirtualMachine>` | Re-checks everything on the guest's own config, then writes the row (under the owner's quota lock), the tag and isolation. `ImportError` (409, 404 when there is no guest) or `QuotaError`. |
| `hostLevelKeys` (lib/guest-config) | `(cfg, kind) => string[]` | Config lines no tenant guest may carry: `hostpciN`, host `usbN`, host `serialN`/`parallelN`, `virtiofsN`, `ivshmem`, QEMU `args`, LXC `devN`/`lxc.*`, `hookscript`, and a privileged container. Also used by snapshot rollback (which allows only approved `hostpciN`). |

# Gotchas

- Refused: a VMID a row already references, a Template Store VMID, a Proxmox template, any ProxMate tag (a machine's or a template's), a guest locked by a running Proxmox task, a volume that is not the guest's own (`foreignVolumeKeys`, which also catches bind mounts and raw host paths), host devices and host-level settings, any of those in one of the guest's snapshots (a tenant may roll back to it — the snapshots are named, to be deleted first), a container without a core limit, and a disk with no recorded size. A PCI device is attached afterwards through a [passthrough request](/services/passthrough-request.md).[^imp]
- Imports of one VMID run one at a time (an in-process per-VMID lock), so two admins importing the same guest can't both succeed: the second finds the row and is refused.[^imp]
- A quota-exempt import is always `adminManaged` (a tenant who could resize a free grant would bypass quota); otherwise `adminManaged` defaults to true for another user's account.[^imp]
- Isolation is applied before the tag is written, while the row is `creating` (which every tenant action refuses): a failure part-way never leaves a tagged guest without its firewall. If isolation or the tag write fails, the row is dropped and the error says the guest is still unmanaged (with its network possibly part-changed).[^imp]
- Import turns on the ProxMate isolation firewall (inbound dropped by default, `firewall=1` on every NIC); the guest's own firewall rules are kept below ProxMate's, so inbound services may need rules added.[^imp]
- The guest's NICs move to the configured default bridge, so its network changes on import.[^imp]

# Relationships

- Called by the [admin router](/api/admin.md) (`GET /api/admin/guests/importable`, `POST /api/admin/guests/import`).
- Uses the [vm service](/services/vm.md) (`writeGuestMarker`, `withQuotaLock`, `assertWithinQuota`, `holdErroredRow`), [matestate](/services/matestate.md) (`reapplyIsolation`), [proxmox](/services/proxmox.md) and [audit](/services/audit.md).
- Related: [unconfirmed machines](/playbooks/unconfirmed-machines.md) (adopting a row ProxMate already has).

[^imp]: backend/src/services/guest-import.service.ts
