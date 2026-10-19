---
type: Backend Service
title: Proxmox service
description: The single Proxmox VE REST client and every guest, storage, network, backup, firewall and cluster operation built on it.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/proxmox.service.ts
tags: [proxmate, service, proxmox, api-client]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: pve
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/proxmox.service.ts
    title: backend/src/services/proxmox.service.ts
---

# Purpose

`proxmox.service.ts` is about 3,700 lines and exports roughly 130 functions. It is the
only module that builds Proxmox API requests. Most exported functions that call Proxmox take an
optional `client?: AxiosInstance` (falling back to `getClient()`), so tests can pass a fake client
instead of a real one.[^pve]
The detail lives in the [Proxmox integration](/proxmox/) section; this concept is the map.

# Sections of the file

| Section | Covers | Detail |
|---------|--------|--------|
| Client builder | Token auth header, TLS/CA, timeout, retries for idempotent reads only, `pveMessage` error mapping | [API surface](/proxmox/pve-api-surface.md) |
| Cluster / connection info | `getVersion`, `getNodes`, `getDefaultNode`, `getEffectivePermissions`, `heldPrivileges` | [privileges](/proxmox/privileges.md) |
| Placement diagnostics | Which nodes satisfy each placement constraint (e.g. a non-shared ISO storage) and the remedy when one pins placement | [guest lifecycle](/proxmox/guest-lifecycle.md) |
| Storage / network / ISO listing | `getStorages`, `getGuestNetworks`, `NETWORK_NAME_RE`, ISO listing | [storage](/proxmox/storage.md), [networking](/proxmox/networking.md) |
| VM lifecycle, LXC containers | Create, power, delete, config | [guest lifecycle](/proxmox/guest-lifecycle.md) |
| Cloud-init extras | First-boot snippets built from a feature catalog (`CLOUD_INIT_CATALOG`: Docker, Tailscale, guest agent, Cockpit, code-server and more) | [cloud-init config](/config/cloud-init.md) |
| Templates & cloning, migration progress | Clone, template bake, migrate with progress | [guest lifecycle](/proxmox/guest-lifecycle.md) |
| PCI / GPU passthrough | Mappings and host-readiness preflight | [passthrough requests](/api/passthrough-request.md) |
| Backups, snapshots | vzdump, restore, snapshot CRUD | [storage](/proxmox/storage.md) |
| Firewall / tenant isolation | NIC bridge and VLAN tag, per-guest firewall rules, cluster firewall toggle | [tenant isolation](/config/tenant-isolation.md) |
| Rescue mode | Booting a guest from the rescue ISO | [provisioning defaults](/config/provisioning-defaults.md) |

# Invariants

- Only idempotent methods (GET, HEAD, OPTIONS) are retried, so a VM create can never be
  sent twice.[^pve]
- Any `netN` name written passes `NETWORK_NAME_RE` first, because a comma or `=` would
  corrupt the NIC line.[^pve]

[^pve]: backend/src/services/proxmox.service.ts
