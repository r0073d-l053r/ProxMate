---
type: Proxmox Privilege Matrix
title: Proxmox token privileges
description: Which Proxmox VE privileges ProxMate's connection test checks, how it reads the token's effective permissions, what breaks without each privilege, and the documented token/ACL setup.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/setup.service.ts
tags: [proxmate, proxmox, permissions, acl, setup]
generated: { by: okf-bootstrap/0.1, at: 2026-10-20T12:00:00Z }
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
  - id: pool
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/guest-pool.service.ts
    title: backend/src/services/guest-pool.service.ts
  - id: script
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/deploy/proxmox-token.sh
    title: deploy/proxmox-token.sh
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
7. With `proxmox_pool` set, the pool checks run next (see "Pool-scoped token" below); a pool
   that does not exist is blocking, everything else a warning. With no pool set, a token whose
   `VM.Allocate` exists only on some `/pool/<id>` gets a warning naming the pool to configure.[^pool]
8. Blocking failures throw one error listing each item plus the hint to run
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
| `VM.Config.Options` | Warning | setting the ownership tag on new guests and renaming them |
| `VM.Config.CPU` / `VM.Config.Memory` / `VM.Config.HWType` | Warning | creating guests and changing CPU, memory, disk controller, display and serial console |
| `VM.Config.CDROM` | Warning | ISO installs and rescue mode |
| `VM.Backup` | Warning | backups and restores |
| `VM.Migrate` | Warning | migration, the Cluster Balancer and node drains |
| `Datastore.AllocateSpace` | Warning | creating disks on a storage |
| `Datastore.Allocate` | Warning | enabling snippets and cleaning up imported cloud images |
| `Datastore.AllocateTemplate` | Warning | importing cloud images for the Template Store |
| `Sys.Audit` | Warning | node health and capacity readings; also warned when `/nodes` returns no nodes |
| `Sys.Modify` | Warning | enforcing isolation on the cluster firewall |
| `VM.Monitor` | Warning, only when the PVE major version is 8 or lower | the guest agent (guest IPs, login passwords, cloud-init progress) |
| `VM.GuestAgent.Audit` / `VM.GuestAgent.Unrestricted` | Warning, only on PVE 9 or later | reading guest IPs; applying a deploy's login password and checking cloud-init progress |
| `SDN.Use` | Warning, only when the PVE major version is 8 or higher | PVE 8+ checks it on `/sdn/zones/<zone>/<bridge>` whenever a guest NIC is attached (plain bridges sit in the implicit `localnetwork` zone), so create/re-network fails with 403. `PVESDNUser` carries it.[^setup] |
| `SDN.Audit` | Warning | `/cluster/sdn/vnets` is refused, so SDN VNets may be missing from the network picker (a VNet can still be typed by name). See [networking](/proxmox/networking.md).[^setup] |

The warning rows come verbatim from `OPERATIONAL_PRIVILEGES` and `guestAgentPrivileges`; the message format is
`<priv> is missing — <reason> will fail.`[^setup]

# Not checked by the connection test

- `VM.Snapshot.Rollback` (rollback also accepts `VM.Snapshot`, which is checked).
- `VM.GuestAgent.FileWrite` (PVE 9: `agent/file-write`, used by the IDE bootstrap and by pushing a file into a VM — on 9.2.3 `VM.GuestAgent.Unrestricted` already covers `file-write`; see the hardware section). Pushing a file and reading the IDE install log also run `agent/exec`, which the checked `VM.GuestAgent.Unrestricted` (or `VM.Monitor` on 8) covers.
- `Mapping.Audit` / `Mapping.Use` (GPU/PCI passthrough through resource mappings).

A token that passes the test can still get 403 on those features; it surfaces as a `pveMessage`
error at the call site. The script below grants all of them.[^pve]

# Proven on hardware (QueenBee, 7 nodes, PVE 9.2.3 / 9.2.4 / 9.2.6)

Checked with the role `deploy/proxmox-token.sh` creates, by removing one privilege at a time and
retrying the call. Everything below is an observation from that cluster, not a reading of the docs.

| Question | Answer |
| --- | --- |
| `VM.GuestAgent.Unrestricted` and `exec` / `exec-status` | Work. `exec` + `exec-status` ran shell commands in a deployed guest. |
| `set-user-password` | Works with `VM.GuestAgent.Unrestricted`. |
| Does `file-write` need `VM.GuestAgent.FileWrite`? | **No, on 9.2.3.** With `VM.GuestAgent.FileWrite` removed from the role, `agent/file-write` still wrote and read back a file. `Unrestricted` covers it, so `FileWrite` is redundant on this release — harmless, and kept in the role for older 9.x where it may still be checked. |
| `/nodes/{node}/hardware/pci` (passthrough host readiness) | Satisfied by **either `Sys.Audit` or `Sys.Modify`**. Removing `Mapping.Audit`/`Mapping.Use`, then `Sys.Audit`, then `Sys.Modify` (one at a time) never broke it. |
| `/cluster/mapping/pci` without `Mapping.Audit` | Returns `200 []`, **not** 403 — the mappings page looks empty rather than reporting a missing privilege. |
| `GET /storage/<id>` (the storage *configuration* endpoint) | Needs **`Datastore.Allocate`**: without it, `Permission check failed (/storage/<id>, Datastore.Allocate)`. `/cluster/resources?type=storage` carries the same per-node availability under `Datastore.Audit`, so prefer it. |
| Does `cicustom` need `Datastore.Allocate` on the snippet storage? | **No.** With `Datastore.Allocate` removed from the role (keeping `AllocateSpace`/`AllocateTemplate`), a full cloud-init deploy still cloned, attached `cicustom: vendor=<snippet storage>:snippets/…`, started and finished provisioning. ProxMate writes the snippet through the mounted `SNIPPET_DIR` filesystem, not the storage API, and Proxmox only reads the volid at start time. |
| `download-url` (cloud-image import) | Works with this role (`Sys.Modify` on `/`). A Debian 13 genericcloud image imported and became a template. |
| Restore as a non-root token | A QEMU `vma.zst` archive is **neither refused nor silently changed**: cores, memory, disk size, `net0 … firewall=1` and the ownership tag all survived in place. No `SDN.Use` complaint for the archive's NIC (`vmbr0` is in the implicit `localnetwork` zone and the role holds `SDN.Use`). |
| The token's own task calls | `GET /nodes/{n}/tasks`, `…/{upid}/status`, `…/{upid}/log` and `DELETE …/{upid}` all work with no extra privileges. |

# Pool-scoped token (optional)

`deploy/proxmox-token.sh --pool <name>` grants the guest privileges on a resource pool instead of
on `/`, so Proxmox refuses the token guests outside the pool, and ProxMate (with the same pool in
`proxmox_pool`) creates every guest inside it.[^script][^pool] The split follows the path Proxmox
checks each privilege on:

| Path | Propagate | Role | Privileges | What needs it there |
|---|---|---|---|---|
| `/pool/<name>` | yes | `ProxMate-Guest` | every `VM.*` the role holds (incl. the release's guest-agent ones), `Pool.Audit`, `Pool.Allocate` | Guests are checked on `/vms/<vmid>`, which a pool member inherits from `/pool/<name>`. Creating with `pool=<name>` needs `VM.Allocate` on the pool instead of on `/vms/<new id>` (create, clone, restore); a container create into the pool also checks `Pool.Allocate`. `Pool.Audit` lets the connection test see the pool; `Pool.Allocate` lets the move action add guests (Proxmox also checks `VM.Allocate` on each). |
| `/nodes` | yes | `ProxMate-Infra` | `Sys.Audit`, and `Sys.AccessNetwork` on 8.2+ | Node status, RRD and capacity, `/cluster/resources` node rows, network and PCI listings, other users' tasks; `download-url` accepts `Sys.AccessNetwork` on the node instead of `Sys.Modify` on `/`. Not `Sys.Modify`, which on a node allows changing its configuration. |
| `/storage` | yes | `ProxMate-Infra` | `Datastore.Audit`, `.AllocateSpace`, `.AllocateTemplate` | Disk allocation, ISO/template/snippet/import volume access, `download-url`'s storage half. |
| `/storage/<id>` for the snippet and import storages (`--snippet-storage`, `--import-storage`, default `local`) and, optionally, `--backup-storage` | yes | `ProxMate-Storage` | the three above plus `Datastore.Allocate` | `GET`/`PUT /storage/<id>` (enabling snippets), deleting the downloaded import image, and reading an uploaded backup before its guest exists. A more specific ACL replaces what `/storage` passes down, hence the full set. |
| `/sdn/zones` | yes | `ProxMate-Infra` | `SDN.Audit`, `SDN.Use` | `SDN.Use` on `/sdn/zones/<zone>/<bridge>` for every NIC (plain bridges are in `localnetwork`); `SDN.Audit` for VNet and zone listings. |
| `/mapping` | yes, only with `--with-passthrough` | `ProxMate-Infra` | `Mapping.Audit`, `Mapping.Use` | `/mapping/pci/<id>` for GPU/PCI passthrough. |
| `/` | **no** (this path only) | `ProxMate-Cluster` | `Sys.Audit`; `Sys.Modify` only with `--with-cluster-firewall` (or before 8.2) | `Sys.Audit`: `/cluster/status` and the cluster firewall reads. `Sys.Modify`: enabling the cluster firewall and writing ProxMate's management rules; before 8.2 also `download-url`. |

What still reaches past the pool, and is therefore opt-in or narrowed:

- **`Sys.Modify` on `/`** also allows cluster backup jobs (`/cluster/backup`, which run as root and
  can back up every guest), the cluster firewall's groups, IP sets and aliases, `/cluster/options`
  and other cluster settings. While the token holds it, the pool does not fully contain it; the
  script and the connection test both say so. Without it, enable the cluster firewall once by hand
  as root (Datacenter → Firewall: an accept rule for the management network on 8006 and 22, then
  enable); the connection test warns until then.
- **`Datastore.Allocate`** deletes any volume and edits the storage definition, so it is granted
  only on the named storages. Granting it on all of `/storage` draws a connection-test warning.

What changes with a pool-scoped token:

- Guests outside the pool disappear from `/cluster/resources`, so ProxMate stops seeing them: their
  rows read as unconfirmed (every action fails closed), the Cluster Balancer, alerts and live stats
  only see pool guests, and "Import existing guests" only lists guests already in the pool.
  Admin-registered templates must be in the pool to be cloned (`VM.Clone` is checked on the template).
- Imported guests are added to the pool. An in-place backup restore sends no `pool` (the guest keeps
  its membership).
- **Uploaded backups**: Proxmox treats a backup as owned by the VMID in its file name, and outside
  the pool the token has no `VM.Backup` on that VMID. ProxMate therefore takes the new VMID first and
  renames the archive on the share to `vzdump-<kind>-<new vmid>-…` before Proxmox sees it, so the
  restore reads an archive of the guest being restored. Listing the archive and reading its config
  happen before that guest exists, which Proxmox allows only with `Datastore.Allocate` on the backup
  storage (`--backup-storage`); the connection test warns when restore uploads are enabled without
  it. Every `unusedN` on the freshly restored guest is treated as foreign, since the pre-restore
  volume listing cannot see volumes of a VMID outside the pool.
- **Backups of a deleted guest** leave the pool with it: the token can no longer list, read or delete
  them. A machine whose rebuild failed after its guest was destroyed has no guest in the pool, so
  restoring one of its backups needs root (or a rebuild first). The connection test lists such rows.
- An earlier `ProxMate` grant on `/` is kept until `--drop-root-grant`, which runs after the token's
  new ACLs are in place and warns when the pool holds no guests yet. While the grant exists the
  connection test warns that the pool limits nothing, and the admin "Move managed guests into the
  pool" action can still reach every guest carrying a ProxMate ownership marker. It sends one request
  per guest and reports each refusal (a guest in another pool also needs `Pool.Allocate` there).
- The connection test checks, with a pool set: the pool exists (blocking if not, when the token
  holds `Pool.Audit`), `VM.Allocate` on the pool (blocking when held neither there nor on `/vms`),
  each other guest privilege on `/pool/<name>`, guest privileges still on `/` or `/vms`,
  `Sys.Modify` on `/`, `Datastore.Allocate` on `/storage` and on the storages that need it,
  cloud-image download rights, managed guests outside the pool, and rows whose guest is not visible.[^pool]
- Not yet proven on hardware: the table is derived from the documented ACL paths and the API calls
  ProxMate makes. ROADMAP.md lists it as needing live verification.[^roadmap]

# Recommended setup (from the docs)

- Supported path: a token with privilege separation **off**:
  `pveum user token add root@pam proxmate --privsep 0`; Token ID `root@pam!proxmate`.[^deploy]
- Keeping privsep on: grant the token a role explicitly, e.g.
  `pveum acl modify / --tokens 'root@pam!proxmate' --roles Administrator` (admin guide), or
  `--roles PVEAdmin` (the connection-test error text).[^adminguide][^setup]
- Least privilege: `deploy/proxmox-token.sh` (run as root on a node) creates user `proxmate@pve`,
  role `ProxMate` (the privileges in the table, with the guest-agent ones chosen by PVE major) and a
  privsep token, and grants the role on `/` with propagate to **both** the user and the token (a
  privsep token's effective set is the intersection). `/` is required: the cluster firewall,
  `/cluster/status` and `download-url` are checked there. on PVE 9 the role also
  holds `VM.GuestAgent.FileWrite` (`--with-ide`, which used to add it, is still accepted and changes nothing), `--with-passthrough` adds `Mapping.Audit`/`Mapping.Use`,
  `--dry-run` prints the commands. Re-running updates the role and ACLs and never re-issues an
  existing token. `--pool <name>` switches to the pool-scoped split above.[^deploy][^security]
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
[^pool]: backend/src/services/guest-pool.service.ts (`checkGuestPool`, `moveManagedGuestsIntoPool`)
[^script]: deploy/proxmox-token.sh (`--pool`)
