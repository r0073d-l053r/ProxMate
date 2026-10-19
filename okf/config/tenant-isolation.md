---
type: Configuration Group
title: Tenant isolation settings
description: SystemConfig keys controlling per-guest firewall isolation, the DNS allow-list and the tenant VLAN tag applied to guest NICs.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/admin.routes.ts
tags: [proxmate, config, firewall, isolation, vlan]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T20:00:00Z }
sources:
  - id: admin-routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/admin.routes.ts
    title: backend/src/routes/admin.routes.ts
  - id: pve
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/proxmox.service.ts
    title: backend/src/services/proxmox.service.ts
  - id: vm-svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/vm.service.ts
    title: backend/src/services/vm.service.ts
  - id: matestate
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/matestate.service.ts
    title: backend/src/services/matestate.service.ts
---

# Purpose

These keys control whether ProxMate locks each tenant guest down with a Proxmox guest firewall, and how. `configureVmIsolation` enables the guest firewall with default-deny inbound and outbound blocks on RFC1918 ranges, while still allowing the internet and DNS. `readIsolationOptions()` is the single reader for the DNS and VLAN settings, so every call site configures a guest the same way.[^pve] All values are plain text, never encrypted.

# Schema

| Key | Value format | Default / when unset | Written by | Read by | Description |
|---|---|---|---|---|---|
| `isolation_enabled` | `"true"` / `"false"` | **On by default**: every reader tests `!== 'false'`, so a missing row means enabled | `PUT /api/admin/isolation` (`enabled`, required boolean) | `vm.service` (`createVm`, `createContainer`, `deployFromTemplate`, `duplicateVm`, `rebuildVm`), `matestate.service.reapplyIsolation` (MateState restore, snapshot rollback and admin adoption of a held machine re-apply the bridge, isolation, NIC firewall and IDE pinhole), `restore-upload.service.restoreFromUpload`, `GET /api/admin/isolation` | Whether ProxMate applies per-guest isolation firewall rules.[^vm-svc][^matestate] |
| `isolation_dns_servers` | comma- or whitespace-separated IPs (zod `z.string().optional()`, trimmed) | Unset or empty: DNS is allowed to **any** resolver | `PUT /api/admin/isolation` (only when `dnsServers` is present) | `proxmox.service.readIsolationOptions` (split on `/[,\s]+/`), `GET /api/admin/isolation` | DNS allow-list for the isolation rules. When set, tenant DNS is limited to these IPs. |
| `isolation_vlan_tag` | integer string `1`–`4094`, or `''` | Unset, empty or invalid: `vlanTag` is `undefined`, which means the NIC tag is left alone (not stripped) | `PUT /api/admin/isolation` (only when `vlanTag` is present; `''` clears it) | `readIsolationOptions`, `GET /api/admin/isolation` | VLAN tag set on tenant NICs. This is the control that contains L2 attacks (ARP, DHCP, IPv6-RA). It takes effect on a guest's next isolation run (create, deploy, rebuild, duplicate, restore-from-upload, MateState restore, snapshot rollback); existing guests keep their current tag until then.[^admin-routes] |

# Validation

`IsolationSchema` in admin.routes.ts:[^admin-routes]

```ts
enabled: z.boolean(),
dnsServers: z.string().optional(),
vlanTag: z.union([z.literal(''), z.coerce.number().int().min(1).max(4094)]).optional(),
```

`setVmVlanTag` also refuses tags outside 1–4094 at apply time.[^pve]

# Gotchas

- Isolation is only **enforced** when the Proxmox cluster firewall is on as well. `GET /api/admin/isolation` returns `enforced = isolationEnabled && clusterFirewallEnabled`. `POST /api/admin/isolation/enforce` (`{ managementCidr }`) adds management allow-rules first and then enables the cluster firewall. That state lives in Proxmox, not in SystemConfig.[^admin-routes]
- The admin isolation page suggests a management CIDR derived from the [default network](/config/provisioning-defaults.md) (`default_bridge`) of the default node.
- `readIsolationOptions` deliberately returns `undefined`, not `null`, for an unset tag. `null` would strip existing tags on every deploy.[^pve]
- The IDE pinhole (`ide_ingress_cidr`, see [IDE](/config/ide.md)) is a managed allow-rule added to the guest firewall for the code-server port (`IDE_GUEST_PORT`, default 8080) from that source only.

# Relationships

- [admin API](/api/admin.md), [networking](/proxmox/networking.md), [privileges](/proxmox/privileges.md)

[^admin-routes]: backend/src/routes/admin.routes.ts (`GET/PUT /isolation`, `POST /isolation/enforce`, `IsolationSchema`)
[^pve]: backend/src/services/proxmox.service.ts (`readIsolationOptions`, `configureVmIsolation`, `setVmVlanTag`)
[^vm-svc]: backend/src/services/vm.service.ts
[^matestate]: backend/src/services/matestate.service.ts (restore path)
