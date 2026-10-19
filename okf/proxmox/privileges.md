---
type: Proxmox Privilege Matrix
title: Proxmox token privileges
description: Which Proxmox VE privileges ProxMate's connection test checks, how it reads the token's effective permissions, what breaks without each privilege, and the documented token/ACL setup.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/setup.service.ts
tags: [proxmate, proxmox, permissions, acl, setup]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: setup
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/setup.service.ts
    title: backend/src/services/setup.service.ts
  - id: pve
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/proxmox.service.ts
    title: backend/src/services/proxmox.service.ts
  - id: deploy
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/DEPLOYMENT.md
    title: DEPLOYMENT.md
  - id: security
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/SECURITY.md
    title: SECURITY.md
  - id: adminguide
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/docs/admin-guide.md
    title: docs/admin-guide.md
  - id: roadmap
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/ROADMAP.md
    title: ROADMAP.md
---

# Purpose

ProxMate talks to Proxmox with a single API token (see [API surface](/proxmox/pve-api-surface.md)
and [proxmox-connection config](/config/proxmox-connection.md)). `testProxmoxConnection()` in
`setup.service.ts` decides whether that token is usable. It is run by the setup wizard and by the
admin "test connection" action ([setup API](/api/setup.md), [admin API](/api/admin.md)).[^setup]

# How the check works

1. `GET /version` alone first. If the token cannot authenticate, that error is the result and no
   permission analysis is reported.[^setup]
2. In parallel: `GET /nodes` and `GET /access/permissions`. The permissions endpoint returns the
   permissions of the **authenticated entity** as Proxmox computes them, with privilege
   separation, the token-and-user intersection and pool expansion already collapsed
   (`PvePermissions = Record<path, Record<privilege, 0|1>>`).[^pve]
3. `heldPrivileges(perms)` flattens every privilege held on **any** path into one set. It is
   deliberately path-agnostic, so a grant scoped to `/pool/<name>` counts; whether the scope covers
   the right objects is left to the functional checks below.[^pve]
4. Empty set → hard failure. The error explains privilege separation: `pveum user token add`
   defaults to `--privsep 1`; an ACL granted with `--users` is a no-op for a privsep token; a
   `root@pam`-owned token gets no automatic Administrator rights. Suggested fix:
   `pveum acl modify / --tokens '<user>@<realm>!<tokenid>' --roles PVEAdmin`, or recreate the token
   with `--privsep 0`.[^setup]
5. Two **blocking** privileges, each checked as privilege *and* as a non-empty result (a grant on a
   path holding nothing looks identical to no grant).[^setup]
6. **Operational** privileges: missing ones become non-blocking `warnings` in the result
   (`{connected, version, nodeCount, vmCount, storageCount, warnings}`).[^setup]
7. Blocking failures throw one error listing each item plus the hint to run
   `pveum user token permissions <userid> <tokenid>`.[^setup]

# Schema

| Privilege | Checked as | Why ProxMate needs it / what breaks without it |
|---|---|---|
| (any) | Blocking | Empty `/access/permissions` means privsep with no ACL; nothing works.[^setup] |
| `VM.Audit` | Blocking, plus `GET /cluster/resources?type=vm` must succeed | Without it every VM list, the dashboard and quota accounting are empty. Zero visible guests is only a warning (a new cluster has none). The error notes `PVEVMUser` includes it but `PVEDatastoreUser` does not.[^setup] |
| `Datastore.Audit` | Blocking, plus `GET /storage` must return at least one storage | Without it the disk-pool, ISO and backup pickers are empty and no VM can be created. The error notes `PVEVMUser` has no Datastore privilege at all.[^setup] |
| `VM.Allocate` | Warning | creating and deleting guests |
| `VM.Config.Disk` | Warning | attaching and resizing disks |
| `VM.Config.Network` | Warning | putting guests on a bridge or VLAN |
| `VM.Config.Cloudinit` | Warning | cloud-init deploys |
| `VM.PowerMgmt` | Warning | starting, stopping and rebooting guests |
| `VM.Console` | Warning | the noVNC and xterm.js consoles |
| `VM.Clone` | Warning | deploying from a template |
| `VM.Snapshot` | Warning | snapshots |
| `Datastore.AllocateSpace` | Warning | creating disks on a storage |
| `Sys.Audit` | Warning | node health and capacity readings; also warned when `/nodes` returns no nodes |
| `SDN.Use` | Warning, only when the PVE major version is 8 or higher | PVE 8+ checks it on `/sdn/zones/<zone>/<bridge>` whenever a guest NIC is attached (plain bridges sit in the implicit `localnetwork` zone), so create/re-network fails with 403. `PVESDNUser` carries it.[^setup] |
| `SDN.Audit` | Warning | `/cluster/sdn/vnets` is refused, so SDN VNets may be missing from the network picker (a VNet can still be typed by name). See [networking](/proxmox/networking.md).[^setup] |

The warning rows come verbatim from `OPERATIONAL_PRIVILEGES`; the message format is
`<priv> is missing — <reason> will fail.`[^setup]

# Not checked by the connection test

ProxMate also calls endpoints whose privileges are not in the lists above, e.g. the cluster
firewall (`PUT /cluster/firewall/options`, `POST /cluster/firewall/rules`), per-guest firewall
rules, `POST .../migrate`, `POST /nodes/{node}/vzdump`, `download-url`, guest-agent endpoints, and
PCI resource mappings.[^pve] SECURITY.md summarises the need as `VM.Allocate`, `VM.Config.*`,
`VM.PowerMgmt`, `VM.Console`, `VM.Audit`, `Datastore.Audit`, `Datastore.AllocateSpace`,
`Sys.Audit` "(+ firewall management for isolation)".[^security] A token that passes the test can
therefore still get 403 on migration, backups, isolation enforcement or the IDE/agent features;
those surface as `pveMessage` errors at the call site.

# Recommended setup (from the docs)

- Supported path: a token with privilege separation **off**:
  `pveum user token add root@pam proxmate --privsep 0`; Token ID `root@pam!proxmate`.[^deploy]
- Keeping privsep on: grant the token a role explicitly, e.g.
  `pveum acl modify / --tokens 'root@pam!proxmate' --roles Administrator` (admin guide), or
  `--roles PVEAdmin` (the connection-test error text).[^adminguide][^setup]
- Least privilege: a dedicated user (e.g. `proxmate@pve`) with only the roles above on the relevant
  nodes/pool. DEPLOYMENT.md states the per-tenant Pool/ACL least-privilege model is "still being
  validated" and the privsep-off token is the supported path for now.[^deploy][^security] ROADMAP
  notes an earlier pool-scoping failure was likely an ACL naming `users=` where a privsep token
  needs `tokens=`.[^roadmap]
- Troubleshooting row: "Proxmox storage empty / VM create 403" → privilege separation on.[^deploy]

# Gotchas

- `/version` and `/nodes` answer for a zero-permission token; that is why the old test passed and
  showed an empty dashboard. Only `/access/permissions` plus the functional reads are meaningful.[^setup]
- `heldPrivileges` ignores paths, so a privilege held only on an unrelated path still counts as
  held. A warning-free result does not prove coverage of the configured storages/nodes.[^pve]
- The SDN warnings were added with the issue #126 fix; builds before it lack them.

[^setup]: backend/src/services/setup.service.ts
[^pve]: backend/src/services/proxmox.service.ts
[^deploy]: DEPLOYMENT.md §2.2 and §17
[^security]: SECURITY.md "Recommended: scope the Proxmox API token"
[^adminguide]: docs/admin-guide.md §1.1
[^roadmap]: ROADMAP.md
