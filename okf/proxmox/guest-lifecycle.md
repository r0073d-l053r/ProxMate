---
type: Proxmox Integration
title: Guest lifecycle on Proxmox
description: How ProxMate creates, clones, templates, powers, migrates, backs up, restores, deletes and consoles QEMU VMs and LXC containers on Proxmox VE, including VMID allocation, bridge/VLAN application and tenant firewall isolation.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/vm.service.ts
tags: [proxmate, proxmox, vm, lxc, isolation]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: pve
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/proxmox.service.ts
    title: backend/src/services/proxmox.service.ts
  - id: vm
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/vm.service.ts
    title: backend/src/services/vm.service.ts
  - id: template
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/template.service.ts
    title: backend/src/services/template.service.ts
  - id: matestate
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/matestate.service.ts
    title: backend/src/services/matestate.service.ts
  - id: restore
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/restore-upload.service.ts
    title: backend/src/services/restore-upload.service.ts
  - id: vnc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/vnc-proxy.service.ts
    title: backend/src/services/vnc-proxy.service.ts
  - id: console
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/console.routes.ts
    title: backend/src/routes/console.routes.ts
  - id: vmroutes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/vm.routes.ts
    title: backend/src/routes/vm.routes.ts
  - id: adminroutes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/admin.routes.ts
    title: backend/src/routes/admin.routes.ts
  - id: balancer
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/cluster-balancer.service.ts
    title: backend/src/services/cluster-balancer.service.ts
  - id: deploylock
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/deploy-lock.service.ts
    title: backend/src/services/deploy-lock.service.ts
  - id: ide
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/ide-provision.service.ts
    title: backend/src/services/ide-provision.service.ts
  - id: security
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/SECURITY.md
    title: SECURITY.md
  - id: deploy
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/DEPLOYMENT.md
    title: DEPLOYMENT.md
---

# Purpose

The Proxmox side of every guest operation. Orchestration lives in `vm.service.ts` (plus
template, matestate, restore-upload and console code); every Proxmox call is a wrapper in
`proxmox.service.ts` listed in [API surface](/proxmox/pve-api-surface.md). DB rows are
[VirtualMachine](/database/virtual-machine.md), [Template](/database/template.md) and
[MateState](/database/mate-state.md); routes are in [VM API](/api/vm.md).

Guest kind: `VirtualMachine.type === 'lxc'` → `lxc`, anything else → `qemu` (`kindOf`). Most wrappers
take a trailing `kind` defaulting to `qemu`; the path segment is the kind itself.[^vm][^pve]

# VMID allocation and placement

- VMID: `getNextVmId()` → `GET /cluster/nextid`, parsed as int, called immediately before the DB row
  is created with `status: 'creating'`. There is no lock or reservation around it.[^pve][^vm]
- Node: an explicit `node` is admin-only (`resolveCreateTarget`), and must still hold the install
  media. Otherwise `pickBestNode(want, storagePool, client, candidateNodes, arch)`:[^vm]
  - online nodes from `/cluster/resources`, filtered to `candidateNodes` (nodes holding the ISO /
    LXC template / backup) and, if the pool is reported anywhere, to nodes that have the pool;
  - architecture filter (`amd64` for ISO VMs and uploaded backups; from the template filename for
    LXC); nodes with unknown arch stay in (fail-open);
  - score `mem*0.6 + cpu*0.4`, or `mem*0.5 + cpu*0.35 + disk*0.15` when the pool is node-local,
    `+1` if the request fits. Never hard-fails on capacity.[^pve]
- Template deploys and duplicates run on the template's / source's node; `pickBestNode` is not
  consulted.[^vm]

# Steps: create from ISO (QEMU)

`createVm(user, input)`:[^vm][^pve]

1. `assertWithinQuota`; read `default_storage`, `default_bridge`, `iso_storage`, `isolation_enabled`
   (isolation is on unless the value is the string `false`).
2. `getIsoNodes` → placement → `getNextVmId` → DB row.
3. `POST /nodes/{node}/qemu` with `cores`, `sockets=1`, `memory`, `scsihw=virtio-scsi-pci`,
   `scsi0=<storage>:<GB>`, `net0=virtio,bridge=<default_bridge>,firewall=1`,
   `ide2=<iso_storage>:iso/<iso>,media=cdrom`, `boot=order=scsi0;ide2`, `ostype=l26`, `agent=1`;
   `waitForTask`.
4. If isolating: `configureVmIsolation(node, vmid, readIsolationOptions())` before first boot.
5. Row → `stopped`; `startVm` + `waitForTask`; row → `running`. Any failure → row `error` and a
   `vm.error` notification (`markVmError`).

# Steps: create LXC

`createContainer`: same shape, but the candidate set is `getTemplateNodes(volid)` and the create is
`POST /nodes/{node}/lxc` with `hostname`, `cores`, `memory`, `swap` (default 512), `rootfs=<storage>:<GB>`,
`net0=name=eth0,bridge=<bridge>,firewall=1,ip=dhcp`, `ostemplate`, `unprivileged=1` (unless explicitly
false), `start=0`, optional `password` and `ssh-public-keys`. Isolation is applied with `kind='lxc'`
before `startVm`.[^vm][^pve]

# Steps: templates

- Discover: `getTemplates` = `/cluster/resources?type=vm` entries with `type === 'qemu' && template === 1`.
  `register` reads the config and sets `cloudInit` via `isCloudInitTemplate` (any value containing
  `cloudinit`).[^template][^pve]
- Convert a ProxMate VM: stop (best effort) → `POST .../qemu/{vmid}/template` → delete the VM row →
  register a Template row.[^template]
- Cloud image: download → `createCloudInitVm` (`scsi0: <storage>:0,import-from=…`,
  `ide2: <storage>:cloudinit`, `serial0=socket`, `vga=std`, `boot=order=scsi0`, `agent=1`,
  `net0` on the default bridge with `firewall=1`) → `bakeGuestAgent` → convert → delete import
  volume. `refreshTemplate` builds a new template VM, repoints the same Template row, and deletes the
  old Proxmox template (safe because cloud-init templates are always full-cloned) — only while that
  guest still carries the template's tag; otherwise it is left in place and admins are notified.[^template]
- `bakeGuestAgent` boots the VM once with `cicustom=user=<guest-agent snippet>`, `ipconfig0=ip=dhcp`,
  `agent=enabled=1`, waits for `agent/ping`, then runs `cloud-init clean --logs --seed`, wipes
  journals/logs and truncates `/etc/machine-id` through `agent/exec`; finally shuts down and deletes
  `cicustom,ipconfig0`. It never fails the build; the outcome is stored as `Template.guestAgent`
  (`true`/`false`/`null`). It requires on-demand snippet writing (`SNIPPET_DIR`/`SNIPPET_STORAGE`).[^template]
- `unregister` deletes the Proxmox template VM (ignoring "does not exist") only when it carries the
  template's tag; another guest at that VMID is left in place and admins are notified.[^template]

# Steps: deploy from template (clone)

`deployFromTemplate`:[^vm]

1. Disk size = `max(requested, template.diskGb)`; quota check; node = `template.proxmoxNode`.
2. `planTemplateClone`: cloud-init templates are always full clones (with `storage=default_storage`
   if that pool is available on the node); a regular template already on `default_storage`, or with
   no usable default, stays a linked clone; a regular template elsewhere is full-cloned onto the
   default pool. `POST .../clone` (`newid`, `name`, `full=0|1`, `storage` only when full); wait up
   to 600 s.
3. `configureClonedVm`: `setVmResources`; grow primary disk if larger than the template's; for
   cloud-init templates resolve a vendor snippet (offered features ∩ selection, plus admin base when
   snippet writing is configured, plus `guest-agent` when a password was requested, dropped again
   if no snippet can be produced for it), then
   `setCloudInitConfig` (`ciuser` default `debian`, `sshkeys` URL-encoded, `ipconfig0=ip=dhcp`,
   `cicustom=vendor=<snippet>`) and force `vga=std`; then `applyDefaultBridge`; then if isolating
   `ensureNicFirewall` + `configureVmIsolation`.
4. Start and wait; row → `running`, and for cloud-init templates `deployState='deploying'` plus
   `pendingCiPassword` (encrypted) when a password was given.

`cipassword` is never sent: its hash would be readable by the tenant on the seed drive and in
`/var/lib/cloud`. The password is applied after cloud-init finishes via
`agent/set-user-password` (`applyPendingCiPassword` in deploy-lock.service), and the deploy lock
clears when a guest-agent `cloud-init status` probe reports done.[^pve][^deploylock]
See [cloud-init config](/config/cloud-init.md).

# Steps: duplicate, rebuild

- `duplicateVm` (QEMU only, source must be stopped, quota charged to the source owner): full clone on
  the same node onto `default_storage` if available → `applyDefaultBridge` → `configureVmIsolation`
  (no `ensureNicFirewall`) → start.[^vm]
- `rebuildVm` keeps the DB row and VMID: `stopAndDeleteProxmoxVm` (hard stop, wait ≤25 s, delete;
  "does not exist" ignored), then re-create from ISO (prefers the current node if it holds the ISO)
  or re-clone from a template (moves to the template's node) and run the same configuration as a
  fresh create/deploy. Destructive; failures leave the row in `error`.[^vm]

# Power and console

- Start/shutdown/stop/reboot: `POST /nodes/{node}/{kind}/{vmid}/status/<action>`. ProxMate `stopVm`
  with `force=false` calls `shutdown`; `force=true` calls `stop`. Pause/resume are QEMU-only
  (`suspend`/`resume`). Every power-on path (start, reboot, resume, rescue enter/exit) calls
  `assertOwnerAccessActive` before powering on (the owner's compute access window, not the caller's). All power actions run `syncVmNode` first, which re-reads
  `/cluster/resources` and updates `proxmoxNode` if the guest moved.[^vm]
- Rescue (QEMU only, needs SystemConfig `rescue_iso`): stores `{boot, ide3}` in
  `VirtualMachine.rescueBoot`, stops, sets `ide3=<iso>,media=cdrom` and `boot=order=ide3`, starts;
  exit restores or deletes those keys.[^vm][^pve]
- Console: `POST /api/vms/:id/console` (capability `console`) calls `vncproxy` with `websocket=1` and
  returns `{ticket, port}`; `POST /api/vms/:id/serial` calls `termproxy` (QEMU requires a `serialN`
  key, else 409 `no_serial`) and returns `{ticket, port, user}`.[^vmroutes] The browser then opens a
  WebSocket on the same path with `vncticket` and `port`; the backend checks `Origin === FRONTEND_URL`,
  the session cookie and the `console` capability, then opens
  `wss://<host>/api2/json/nodes/{node}/{kind}/{vmid}/vncwebsocket` with the API-token header and
  relays frames, preserving text/binary opcodes.[^console][^vnc]

# Migration

`migrateVmToNode` (admin, balancer, drain, passthrough flow): refuses LXC and VMs with
`hasPassthrough`; checks the target exists and arch matches (fail-open on unknown); `online` = guest
currently running unless `offline`. `POST .../qemu/{vmid}/migrate` with `target`, and for live moves
`online=1` and `with-local-disks=1`; optional `targetstorage`. Waits on the **source** node's task
(default 30 min), then sets `proxmoxNode`.[^vm][^pve]

`migratePreflight` wraps `GET .../migrate` (`allowed_nodes`, `not_allowed_nodes` normalised into
sentences, `local_disks`) and adds two ProxMate blocks, both fail-open: a running guest with
`cpu=host` may not live-migrate to a node with a different `cpuinfo.model`; a target lacking a
`cicustom` snippet storage is refused. It returns `null` if the preflight cannot be read.[^pve]
The balancer and drain plans use `migratableTargets`; containers are pinned.[^balancer][^security]
Progress for the admin bar: find the running `qmigrate` task in `/cluster/tasks`, read its full log
(`limit=0`) and parse `drive-*/mirror-*: transferred X of Y (p%) in T` lines.[^pve]

# Backup, restore, snapshots

- MateState backup: vzdump `mode=snapshot`, `compress=zstd`, `remove=0`; see [storage](/proxmox/storage.md).[^matestate]
- In-place restore (`restoreFromMateState`): stop (wait ≤30 s) → QEMU `POST /qemu` with
  `archive`, `force=1` or LXC `POST /lxc` with `ostemplate`, `restore=1`, `force=1` and a rootfs
  `storage` → wait 30 min → `ensureNicFirewall` only (not `configureVmIsolation`) → start.[^matestate][^pve]
- Restore as new guest (uploaded archive): `restoreNewGuest` with a new VMID, `unique=1` (fresh MACs)
  and `storage=default_storage` → `setVmName` → `applyDefaultBridge` → `configureVmIsolation` → start.[^restore]
- Snapshots (QEMU only; for LXC the list route returns `[]` and create/delete/rollback answer 400): list/create (`vmstate` optional)/delete/rollback under
  `.../qemu/{vmid}/snapshot`; a per-VM cap `MAX_SNAPSHOTS_PER_VM = 12` is enforced in the route.[^vmroutes]

# Delete

`destroyVm`: `syncVmNode` → `stopAndDeleteProxmoxVm` → delete the DB row.[^vm]

# Guest agent

QEMU only. Used for: IPs (`network-get-interfaces`, 1.5 s, no retry; LXC uses `/lxc/{vmid}/interfaces`
instead), password reset (`set-user-password`), SSH key append (`agent/exec` of a fixed script with
user and key passed as `$1`/`$2`, exit 3 = no such user), `cloud-init status` probes, file writes and
commands for the IDE, disk-usage alerts (`get-fsinfo`), and the template bake. Tailscale addresses
(interface `tailscale*` or 100.64.0.0/10) are reported separately from the LAN IP.[^pve][^ide]

# Network placement and isolation

Network discovery is in [networking](/proxmox/networking.md); config keys are in
[tenant-isolation](/config/tenant-isolation.md).

- `setVmBridge(node, vmid, bridge)`: validates the name (`NETWORK_NAME_RE`,
  `^[A-Za-z][A-Za-z0-9_.-]{0,31}$`), then rewrites `bridge=` on every `netN` that differs, leaving MAC,
  model, `firewall=1`, tag etc. intact. Idempotent.[^pve]
- `applyDefaultBridge`: no-op if `default_bridge` is unset, else `setVmBridge`. Called on template
  deploy, rebuild-from-template, duplicate and upload restore, deliberately overriding the source's
  bridge. ISO and LXC creates write `default_bridge` directly into `net0`.[^pve][^vm]
- `setVmVlanTag(node, vmid, tag|null)`: `tag` must be an integer 1–4094; sets/replaces `tag=` on every
  `netN`, `null` strips it.[^pve]
- `readIsolationOptions()`: `isolation_dns_servers` split on commas/whitespace; `isolation_vlan_tag`
  only if a valid 1–4094 integer, else **undefined** (meaning "leave NICs alone", never strip).[^pve]
- `configureVmIsolation(node, vmid, opts, client, kind)`:[^pve]
  1. If `vlanTag !== undefined` → `setVmVlanTag`.
  2. `PUT .../firewall/options` `enable=1, dhcp=1, ndp=1, macfilter=1, ipfilter=0, policy_in=DROP, policy_out=ACCEPT`.
  3. Delete existing rules whose comment contains `ProxMate isolation` (descending `pos`).
  4. Insert (each at `pos=0`, so later inserts sit above earlier ones): OUT DROP udp dport 68
     (rogue DHCP server), OUT DROP icmpv6 `router-advertisement`, OUT DROP to `192.168.0.0/16`,
     `172.16.0.0/12`, `10.0.0.0/8`, then OUT ACCEPT udp+tcp dport 53 to each configured DNS server,
     or to any destination when none are set.
- `ensureNicFirewall`: adds/flips `firewall=1` on every `netN` (clones and in-place restores).[^pve]
- Cluster firewall: guest rules only take effect once it is on. `setClusterFirewall(true, cidrs)`
  first adds IN ACCEPT tcp 8006 and 22 from each CIDR with comment `ProxMate: management access`
  (skipped entirely if any rule with that comment already exists), then `enable=1`; disabling leaves
  the rules. Driven by `POST/DELETE /api/admin/isolation/enforce`; `GET /api/admin/isolation` reports
  `enforced = isolation_enabled && cluster firewall enabled` and a `suggestedMgmtCidr` derived from the
  default bridge's CIDR on `getDefaultNode()`.[^pve][^adminroutes][^deploy]
- IDE pinhole: `ensureIdePinhole` adds one IN ACCEPT tcp to the IDE port from `ide_ingress_cidr`
  (wildcards rejected), comment `ProxMate IDE: reverse-proxy pinhole`; IDE provisioning also runs
  `ensureHostCpu` (`cpu=host`, effective after reboot).[^pve][^ide] See [IDE config](/config/ide.md).

# Invariants

- When isolation is enabled, it is applied before a guest's first boot on every create/deploy/duplicate/rebuild/upload-restore path.[^vm][^restore]
- POST/PUT/DELETE to Proxmox are never retried by the client.[^pve]
- A create that fails at any Proxmox step leaves the DB row in `error`; the Proxmox guest may remain.[^vm]

# Gotchas

- Concurrent creates can read the same `/cluster/nextid` (no reservation); the later Proxmox create
  then fails and its row goes to `error`. Inferred from the code, not observed.[^vm]
- Changing `isolation_vlan_tag` or `default_bridge` does not touch existing guests until their next
  isolation/configuration run.[^adminroutes]
- DEPLOYMENT.md §2 says "mac/ip-filter on, DNS to the gateway allowed", but the code sets
  `ipfilter=0` and allows DNS to configured servers or anywhere; SECURITY.md §3a matches the code on
  both points (it does not list the DHCP-reply and router-advertisement DROP rules).[^deploy][^security][^pve]
- Changing the `ProxMate isolation` comment string would orphan deployed rules (not reconciled).[^pve]
- `ensureHostCpu` reads and writes the config of the same guest `kind`.[^pve]
- Template deploys pile onto the template's node; ROADMAP tracks this.[^vm]

[^pve]: backend/src/services/proxmox.service.ts
[^vm]: backend/src/services/vm.service.ts
[^template]: backend/src/services/template.service.ts
[^matestate]: backend/src/services/matestate.service.ts
[^restore]: backend/src/services/restore-upload.service.ts
[^vnc]: backend/src/services/vnc-proxy.service.ts
[^console]: backend/src/routes/console.routes.ts
[^vmroutes]: backend/src/routes/vm.routes.ts
[^adminroutes]: backend/src/routes/admin.routes.ts
[^balancer]: backend/src/services/cluster-balancer.service.ts
[^deploylock]: backend/src/services/deploy-lock.service.ts
[^ide]: backend/src/services/ide-provision.service.ts
[^security]: SECURITY.md
[^deploy]: DEPLOYMENT.md
