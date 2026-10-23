---
type: Backend Service
title: Guest-pool service (pool-scoped token support)
description: The connection test's resource-pool checks and the admin action that moves guests carrying a ProxMate ownership marker into the configured `proxmox_pool`.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/guest-pool.service.ts
tags: [proxmate, proxmox, permissions, acl, pool]
generated: { by: okf-bootstrap/0.1, at: 2026-10-23T12:00:00Z }
sources:
  - id: pool
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/guest-pool.service.ts
    title: backend/src/services/guest-pool.service.ts
  - id: pve
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/proxmox.service.ts
    title: backend/src/services/proxmox.service.ts
  - id: setup
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/setup.service.ts
    title: backend/src/services/setup.service.ts
---

# Purpose

With the optional `proxmox_pool` setting, every guest ProxMate creates, clones, restores or imports joins that Proxmox resource pool (`pve.getGuestPool()` is passed as `pool` to `createVm`, `createLxc`, `createCloudInitVm`, `cloneVm`, `restoreBackup` and `restoreNewGuest`), so the API token's guest privileges can be granted on `/pool/<name>` instead of on `/`.[^pve] This service answers the connection test's pool questions and moves the guests ProxMate already manages into the pool.[^pool]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `managedGuests` | `(client) => { guests, notVisible }` | One `/cluster/resources?type=vm` read plus the VirtualMachine and Template rows. A guest counts only when its tags carry the marker of a row **at that VMID** (`proxmate-<row id>` or `proxmate-template-<id>`). `notVisible` lists rows (not `creating`) and templates whose VMID the token cannot see.[^pool] |
| `checkGuestPool` | `(client, perms, pool, guestPrivileges) => { report, blocking, warnings }` | The connection test's pool section, described below.[^pool] |
| `poolScopedWithoutSetting` | `(perms) => string[]` | With no pool set: the `/pool/<id>` paths holding `VM.Allocate` when neither `/` nor `/vms` does, so the test can say which pool to configure.[^pool] |
| `moveManagedGuestsIntoPool` | `(client?) => { pool, moved, failed }` | Takes the managed guests outside the pool, re-reads each one's config and keeps only those whose own `tags` still carry their row's marker, then adds them one request per guest (a guest in another pool also needs `Pool.Allocate` there, and one refusal must not stop the rest). Each outcome is `{ vmid, name, template, from }`, failures add `error`. Throws when no pool is configured.[^pool] |

`pve.addGuestsToPool(pool, vmids)` sends `PUT /pools` with `poolid`, `vms` and `allow-move=1` (Proxmox VE 8.1+), falling back to `PUT /pools/{poolid}` on a 501 or 404 (8.0). Proxmox wants `Pool.Allocate` on `/pool/<name>` and `VM.Allocate` on each guest.[^pve]

# Connection-test outcomes

| Finding | Kind | Meaning |
|---|---|---|
| Pool not listed by `GET /pools` while the token holds `Pool.Audit` on it | **Blocking** | The pool does not exist; every create would fail. Names `pveum pool add <name>`. |
| Pool not listed and no `Pool.Audit` | Warning (`exists: null`) | Existence cannot be confirmed. |
| `VM.Allocate` held neither on `/pool/<name>` nor on `/vms` | **Blocking** | Every create into the pool would be refused. |
| Other guest privileges missing on `/pool/<name>` | Warning (`missingOnPool`) | Lists each one (the list includes `Pool.Audit` and `Pool.Allocate`). An unlisted path inherits its parent's answer from `/access/permissions`. |
| `VM.*` privileges held on `/` or `/vms` | Warning (`guestPrivilegesOnRoot`) | The token still reaches every guest; the pool limits nothing until that grant is removed. |
| Managed guests outside the pool | Warning (`outside`) | Points at "Move managed guests into the pool". |
| Rows/templates whose guest is not visible | Warning (`notVisible`) | Prints `pveum pool modify <name> --vms <ids> --allow-move 1` for root, and notes that a gone guest's backups are outside the pool too. |
| `Sys.Modify` on `/` | Warning | Held: the pool does not fully contain the token (cluster backup jobs, firewall groups and IP sets, cluster options). Not held: the cluster firewall must be enabled once by hand (quiet once it is on). |
| No way to run `download-url` | Warning | Needs `Sys.AccessNetwork` on `/nodes` (8.2+) or `Sys.Audit`+`Sys.Modify` on `/`. |
| `Datastore.Allocate` on `/storage` | Warning | It can delete any volume and edit any storage. |
| The snippet storage (`SNIPPET_STORAGE`) lacks the snippets content type and the token cannot turn it on | Warning | Names the one-time root step and `--snippet-storage`. Nothing is asked for the ISO or backup storage. |

The guest privilege list comes from `setup.service` (`VM.Audit`, the `VM.*` operational privileges, the release's guest-agent privileges, `Pool.Audit`).[^setup]

# Gotchas

- Setting the pool does not move anything; existing guests stay where they are until the admin action (or root) moves them.[^pool]
- The move action needs the token to still reach the guests, i.e. it works while the earlier `/` grant is in place. `deploy/proxmox-token.sh --pool` keeps that grant until `--drop-root-grant`.[^pool]
- Templates registered from an existing Proxmox template carry a template marker and are moved too: cloning needs `VM.Clone` on the template, which a pool-scoped token only has inside the pool. The admin UI asks before moving a template that is in another pool.[^pool]
- Guest import (`guest-import.service`) adds an imported guest to the pool as its last step and returns a `poolNote` the UI shows. A guest already in another pool is refused (`409`, `code: 'pool_move'`) until the admin confirms with `movePool: true`; a refusal by Proxmox is recorded and does not undo the import.

# Relationships

- Called by [setup](/services/setup.md) (`testProxmoxConnection`) and the [admin API](/api/admin.md) (`POST /settings/proxmox/pool/move-guests`).
- Uses the [Proxmox service](/services/proxmox.md) and the marker helpers of the [VM service](/services/vm.md).
- Setting: [Proxmox connection](/config/proxmox-connection.md). Privileges and ACL paths: [Proxmox privileges](/proxmox/privileges.md).

[^pool]: backend/src/services/guest-pool.service.ts
[^pve]: backend/src/services/proxmox.service.ts (`getGuestPool`, `listPools`, `addGuestsToPool`)
[^setup]: backend/src/services/setup.service.ts (`guestPrivilegesFor`, `testProxmoxConnection`)
