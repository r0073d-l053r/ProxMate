---
type: Proxmox Integration
title: Guest networking and network discovery
description: How ProxMate discovers the bridges and SDN VNets a guest NIC can attach to, stores the default, and applies it to every new guest.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/proxmox.service.ts
tags: [proxmate, proxmox, networking, sdn, bridge]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: pve
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/proxmox.service.ts
    title: backend/src/services/proxmox.service.ts
  - id: setup
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/setup.service.ts
    title: backend/src/services/setup.service.ts
  - id: picker
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/frontend/src/components/network-picker.tsx
    title: frontend/src/components/network-picker.tsx
  - id: tests
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/test/guest-networks.test.ts
    title: backend/test/guest-networks.test.ts
  - id: issue-126
    resource: https://github.com/r0073d-l053r/ProxMate/issues/126
    title: "Issue #126: ProxMate Setup - Network bridge"
---

# Purpose

Every guest NIC ProxMate writes names one network in its `bridge=` key. The admin picks
that network once, as the **default network**, stored in the `default_bridge` key of
[provisioning defaults](/config/provisioning-defaults.md). It can be a Linux bridge
(`vmbr0`), an Open vSwitch bridge, or an SDN VNet. Proxmox attaches all three the same way
(`net0: virtio,bridge=<name>,firewall=1`).[^pve]

# Discovery: `getGuestNetworks()`

`getGuestNetworks(client)` builds the list both network pickers show. They get it through
`GET /api/setup/proxmox/resources` (setup wizard) and `GET /api/proxmox/resources`
(admin settings), as the `bridges` array.[^setup]

| Step | Proxmox call | Contributes |
|------|--------------|-------------|
| 1 | `GET /nodes` | Online nodes. Offline nodes are not asked. |
| 2 | `GET /nodes/{node}/network?type=any_bridge`, once per online node | `bridge` (Linux) and `OVSBridge` interfaces, plus any `vnet` entries (the code comment says Proxmox VE 8+ lists applied VNets here) |
| 2b | `GET /nodes/{node}/network` (unfiltered), only if 2 is rejected | The same bridge types, filtered client-side, so a release without `any_bridge` keeps its bridges |
| 3 | `GET /cluster/sdn/vnets` | Every SDN VNet, with its `zone` and `alias` |
| 4 | `GET /cluster/sdn/zones` | Each zone's optional `nodes` restriction, which becomes the VNet's node set |

Results are merged by name, so a VNet reported both per node and by `/cluster/sdn`
appears once. Names failing `NETWORK_NAME_RE` are dropped. The list is sorted bridges
first, then OVS bridges, then VNets.[^pve]

# Schema

`GuestNetwork`, as returned to the frontend:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | What goes in `bridge=`. Matches `NETWORK_NAME_RE` (`^[A-Za-z][A-Za-z0-9_.-]{0,31}$`). |
| `kind` | `bridge` \| `ovs` \| `vnet` | Linux bridge, OVS bridge or SDN VNet. |
| `zone` | string? | SDN zone, VNets only. |
| `comment` | string? | VNet alias, or the interface's `comments`, trimmed. |
| `nodes` | string[] | Online nodes it is known to exist on, sorted. |

The resources response also carries `nodeCount` (online nodes). The picker uses it to
flag a network that is missing from some nodes.[^setup]

# Invariants

- **Partial beats empty.** Any single call failing (an offline node, the SDN package not
  installed, a token without `SDN.Audit`) only drops what that call would have added.
  Discovery never throws because of SDN.[^tests]
- **Hand entry is always possible.** If the list is empty, or the saved value isn't in
  it, `NetworkPicker` shows a text input. Otherwise a "Not listed? Type a name" toggle
  offers one. Both save routes (`POST /api/setup/defaults`,
  `PUT /api/admin/settings/defaults`) trim the name and validate it against
  `NETWORK_NAME_RE`.[^picker]
- **The default overrides inherited NICs.** Template deploys and duplicates are clones, and an
  uploaded-backup restore carries the archive's NICs, so all three inherit `net0` from their source. `applyDefaultBridge` rewrites every
  `netN` onto the default network, keeping the rest of the NIC line. It is idempotent:
  a NIC already on the target network is skipped.[^pve]

# Gotchas

- **Before the #126 fix**, discovery asked only the first node for `?type=bridge`. That
  returns Linux bridges only. On an SDN-only cluster the picker was empty and setup could
  not be finished; OVS clusters had the same problem.[^issue-126]
- **Privileges.** On Proxmox VE 8+, attaching a NIC needs `SDN.Use` on
  `/sdn/zones/<zone>/<bridge>` in addition to `VM.Config.Network`. This applies to plain
  bridges too, which live in the implicit `localnetwork` zone. Listing VNets needs
  `SDN.Audit`. The connection test warns about both (it doesn't block); see
  [privileges](/proxmox/privileges.md).[^setup]
- **VNets must be applied** (Proxmox VE behaviour, not checked by ProxMate). `/cluster/sdn/vnets`
  returns the configured VNets, which can include pending ones. A VNet that hasn't been applied
  (Datacenter → SDN → Apply) does not exist on the nodes yet, and guests attached to it fail to
  start. ProxMate does not check whether a listed VNet has been applied; the picker's empty-list hint only reminds the
  admin to apply the SDN configuration.[^picker]
- **Node coverage.** A Linux bridge is defined per node. The picker warns when the chosen
  network is on fewer nodes than `nodeCount`, because a guest placed on a node without it
  fails to start.[^picker]
- **Not yet SDN-aware:** `getBridgeNetwork` / `getBridgeGateway` read the gateway and
  CIDR from `/nodes/{node}/network/{bridge}`, which has nothing for a VNet (its subnets
  live under `/cluster/sdn/vnets/{vnet}/subnets`). The firewall management-subnet helper
  therefore derives nothing when the default is a VNet. The `isolation_vlan_tag` guest
  tag is also applied on top of a VNet, whose zone usually sets the tag itself. See
  [tenant isolation](/config/tenant-isolation.md).[^pve]

- Tenant NICs never carry `trunks=`: `ensureNicFirewall` (post-clone, duplicate, MateState restore, snapshot rollback) and `setVmVlanTag` remove it, and restore-from-upload rebuilds every NIC without it.[^pve]

# Relationships

- Stored in: [provisioning defaults](/config/provisioning-defaults.md) (`default_bridge`).
- Exposed by: [setup router](/api/setup.md), [proxmox router](/api/proxmox.md), and
  [admin router](/api/admin.md) for saving.
- Applied by: [guest lifecycle](/proxmox/guest-lifecycle.md),
  [VM service](/services/vm.md), [template service](/services/template.md).
- Playbook: [SDN-only cluster](/playbooks/sdn-only-cluster.md).

[^pve]: backend/src/services/proxmox.service.ts
[^setup]: backend/src/services/setup.service.ts
[^picker]: frontend/src/components/network-picker.tsx
[^tests]: backend/test/guest-networks.test.ts
[^issue-126]: "Issue #126: ProxMate Setup - Network bridge"
