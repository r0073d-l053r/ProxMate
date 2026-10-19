---
type: Playbook
title: Setting up ProxMate on an SDN-only cluster
description: Steps to pick an SDN VNet as the default network when the cluster has no Linux bridge for guests.
tags: [proxmate, playbook, sdn, networking, setup]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: networking
    resource: /proxmox/networking.md
    title: Guest networking and network discovery
  - id: setup
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/setup.service.ts
    title: backend/src/services/setup.service.ts
  - id: issue-126
    resource: https://github.com/r0073d-l053r/ProxMate/issues/126
    title: "Issue #126: ProxMate Setup - Network bridge"
---

# Trigger

The setup wizard's **Default network** picker lists no SDN VNet, or nothing at all, on a
cluster whose guests run on SDN VNets (VLAN, VXLAN or EVPN zones).[^issue-126]

# Steps

1. **Apply the SDN configuration.** In Datacenter → SDN, click *Apply*. A VNet that is
   configured but not applied doesn't exist on the nodes, and guests attached to it fail
   to start (Proxmox VE behaviour; ProxMate does not check whether a listed VNet has been applied).
2. **Grant the token the SDN privileges.** `SDN.Audit` lets ProxMate list VNets.
   `SDN.Use` lets it attach guest NICs; Proxmox VE 8+ checks it on every NIC attachment.
   For example:
   `pveum acl modify /sdn/zones --tokens '<user>@<realm>!<tokenid>' --roles PVESDNUser`.
   The wizard's connection test names whichever of the two is missing.[^setup]
3. **Re-run the connection test** in the wizard (`POST /api/setup/proxmox/test`) and
   check that no `SDN.*` warning remains.
4. **Pick the VNet.** Each VNet shows as `<vnet> · SDN VNet · zone <zone>`. If the list is
   still incomplete, use *Not listed? Type a name* and enter the VNet ID. It must match
   `^[A-Za-z][A-Za-z0-9_.-]{0,31}$`.[^networking]
5. **Check node coverage.** If the picker says the network is "only on" some nodes, the
   zone is restricted to those nodes. Guests placed elsewhere will fail to start, so widen
   the zone's node list or restrict placement.

# Known limits

The management-subnet derivation used by the cluster-firewall toggle reads a Linux
bridge's CIDR, and finds nothing on a VNet. Add the management CIDR by hand when
enabling the firewall. See [networking](/proxmox/networking.md).[^networking]

[^networking]: Guest networking and network discovery
[^setup]: backend/src/services/setup.service.ts
[^issue-126]: "Issue #126: ProxMate Setup - Network bridge"
