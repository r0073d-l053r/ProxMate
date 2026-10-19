---
type: Proxmox API Dependency
title: Proxmox VE API surface
description: How ProxMate's backend builds its Proxmox VE REST client (API-token auth, TLS, retries, credential redaction, task polling, error mapping) and every Proxmox path it calls.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/proxmox.service.ts
tags: [proxmate, proxmox, api, http-client, integration]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T20:00:00Z }
sources:
  - id: pve
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/proxmox.service.ts
    title: backend/src/services/proxmox.service.ts
  - id: vnc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/vnc-proxy.service.ts
    title: backend/src/services/vnc-proxy.service.ts
  - id: setup
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/setup.service.ts
    title: backend/src/services/setup.service.ts
  - id: vm
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/vm.service.ts
    title: backend/src/services/vm.service.ts
  - id: template
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/template.service.ts
    title: backend/src/services/template.service.ts
  - id: balancer
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/cluster-balancer.service.ts
    title: backend/src/services/cluster-balancer.service.ts
  - id: alert
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/alert.service.ts
    title: backend/src/services/alert.service.ts
  - id: metrics
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/lib/metrics.ts
    title: backend/src/lib/metrics.ts
  - id: security
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/SECURITY.md
    title: SECURITY.md
  - id: matestate
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/matestate.service.ts
    title: backend/src/services/matestate.service.ts
  - id: restoreupload
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/restore-upload.service.ts
    title: backend/src/services/restore-upload.service.ts
  - id: verifypools
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/_verify_pools.ts
    title: backend/_verify_pools.ts
---

# Purpose

Every call ProxMate makes to Proxmox VE goes through an axios client built in
`proxmox.service.ts` (the only exception is the console WebSocket, opened directly by
`vnc-proxy.service.ts`). Many callers import the module as `pve` and pass an optional
`client` so one request can reuse a single client. The token never reaches the browser.[^security]

Related: [privileges](/proxmox/privileges.md), [storage](/proxmox/storage.md),
[guest lifecycle](/proxmox/guest-lifecycle.md), [networking](/proxmox/networking.md),
[proxmox-connection config](/config/proxmox-connection.md), [proxmox service](/services/proxmox.md).

# Client construction

- `buildClient(host, tokenId, tokenSecret, verifySsl, ca?)` creates an axios instance with
  `baseURL = ${host}/api2/json` and header `Authorization: PVEAPIToken=${tokenId}=${tokenSecret}`.[^pve]
- TLS: `httpsAgent: new https.Agent({ rejectUnauthorized: verifySsl, ca })`. The optional CA PEM
  comes from `getProxmoxCa()`: env `PROXMOX_CA_CERT` (inline PEM, must contain `BEGIN CERTIFICATE`)
  or `PROXMOX_CA_CERT_FILE` (path; unreadable path silently falls back to the default trust store).
  `ca` has no effect when `verifySsl` is false.[^pve]
- `getConnectionConfig()` reads SystemConfig keys `proxmox_host`, `proxmox_token_id`,
  `proxmox_token_secret`, `proxmox_verify_ssl` (string `'true'` enables verification). Throws
  `Proxmox is not configured` when host, token id or secret is missing. `getClient()` builds a
  fresh client from it on every call (no client cache).[^pve] The secret is written encrypted by
  `saveProxmoxConfig` (`setConfig(..., true)`).[^setup] See [SystemConfig](/database/system-config.md).
- Timeout: `PROXMOX_TIMEOUT_MS` (default `15000`) per request; some calls override it
  (`getLxcIps` 2000 ms, `getVmIps` 1500 ms, `guestAgentPing` 3000 ms, `get-fsinfo` 2000 ms).[^pve][^alert]

# Retries

A response interceptor (`attachRetry`) retries **only idempotent methods** (`get`, `head`,
`options`) on transient failures: timeout, network error (no response), HTTP 5xx or 429.
Attempts: `PROXMOX_RETRIES` (default `2`), backoff `min(2000, 250 * 2^(attempt-1))` ms.
POST/PUT/DELETE are never retried, so a VM create cannot be double-submitted. A request can opt
out with `_noRetry: true` (used by `guestAgentPing` and `getVmIps`). Every transient failure
increments the Prometheus counter `proxmate_proxmox_api_errors_total{kind}` with `kind` in
`timeout | network | http | other` (`classifyError` never actually returns `other`); expected 4xx errors are not counted.[^pve][^metrics]

# Credential redaction

A second interceptor (`redactCredentials`) runs `sanitize()` on every failed request's error and
on `err.response`: `config` is replaced by `{method, baseURL, url, timeout, headers:
{Authorization: 'PVEAPIToken=[redacted]'}}` and `request` by an object holding only `_header`
with the Authorization line rewritten. Objects are replaced wholesale (not scrubbed) so references
reaching the token (follow-redirects options, the agent socket pool) are severed. Logging a raw
axios error is therefore safe, but `pveMessage()` remains the intended thing to log.[^pve]

# Error mapping (pveMessage)

`pveMessage(err)` returns, in order: the joined values of `response.data.errors` (Proxmox's
per-parameter validation map, joined with `; `), `response.data.message`,
`Proxmox responded <status>`, the axios message, or `Unknown Proxmox error`. Routes typically
answer `502 { error: pveMessage(err) }` on a Proxmox failure. Several callers pattern-match the
message (`/does not exist|not found/i`) to treat an already-deleted guest as success.[^pve][^vm]

# Default node selection

`getDefaultNode()` returns `nodes[0].node` from `GET /nodes` (first entry, online status not
checked) or throws `No Proxmox nodes available`. It is used only where a node is needed for a
cluster-wide answer (e.g. reading the default bridge's CIDR to suggest a management subnet).
Guest placement never uses it; it uses `pickBestNode` (see [guest lifecycle](/proxmox/guest-lifecycle.md)).[^pve]

# Task (UPID) polling

Mutating calls that Proxmox runs as a task return the UPID string (`res.data.data`).
`waitForTask(node, upid, client?, timeoutMs = 180_000)` polls
`GET /nodes/{node}/tasks/{upid}/status` every 1.5 s until `status === 'stopped'`. Success is
`exitstatus` absent, `OK`, or starting with `WARNINGS` (Proxmox's marker for a task that finished
with non-fatal warnings; the code comment notes it is common for LXC creates and vzdump); anything else throws `Proxmox task failed: <exitstatus>`. Deadline expiry
throws `Proxmox task timed out` (ProxMate stops polling; nothing cancels the Proxmox task). The UPID is URL-encoded in the
path.[^pve] Caller timeouts: clones and the cloud-init template VM create 600 000 ms, cloud-image
download 900 000 ms, migration 1 800 000 ms by default;[^vm][^template] vzdump backup and restore
30 min.[^matestate][^restoreupload]

# Schema

Every Proxmox REST path ProxMate calls. `{kind}` is `qemu` or `lxc` (the `GuestKind` type is the
literal path segment); rows marked qemu use the `qemu` segment only. Paths are relative to
`/api2/json`. "Called from" names the wrapper in `proxmox.service.ts` unless another file is given.

| Method | Path | Called from (function) | Purpose |
|---|---|---|---|
| GET | `/version` | `getVersion` | PVE version; first, standalone step of the connection test |
| GET | `/access/permissions` | `getEffectivePermissions` | Effective privileges of the token (privsep and pools already applied) |
| GET | `/nodes` | `getNodes` (used by `getDefaultNode`, `getIsos`, `listBackups`, `listLxcTemplates`, `getGuestNetworks`, `migrateVmToNode` in vm.service) | Node list with cpu/mem |
| GET | `/nodes/{node}/status` | `getNodeArchMap`, `getNodeAvxMap`, `getNodeCpuModelMap` | `current-kernel.machine` (arch), `cpuinfo.flags` (AVX), `cpuinfo.model`; cached 5 min |
| GET | `/cluster/resources` | `pickBestNode`, `getPlacementDiagnostics`, `getIsoNodes`, `getTemplateNodes`, `nodesWithSnippet`, `getBackupNodes`, node arch/AVX/CPU maps, `getClusterStats`; also `syncVmNode`/`getLiveUsage` (vm.service), `getCloudInitExtras`/`cloudInitStatus` (template.service), alert, resource-history, live-stats, power-schedule services | Cluster-wide nodes, guests, storages with usage |
| GET | `/cluster/resources?type=vm` | `getClusterVmCount`, `getTemplates`; `computeClusterPlan`, `planNodeDrain` (cluster-balancer) | Guests only (templates have `template: 1`)[^balancer] |
| GET | `/cluster/resources?type=storage` | `storageNodeMap` (inside `migratePreflight`) | Which nodes each storage is available on |
| GET | `/cluster/resources?type=node` | `getNodesHealth` | Per-node cpu/mem/uptime |
| GET | `/cluster/status` | `getNodesHealth` | Quorum and node online flags |
| GET | `/cluster/nextid` | `getNextVmId` | Next free VMID |
| GET | `/cluster/tasks` | `getActiveMigrationTask` | Find a running `qmigrate` task (no `endtime`) for a VMID |
| GET | `/cluster/mapping/pci` | `listPciMappings`, `getPciMappingEntries` | Admin-defined PCI resource mappings |
| GET | `/cluster/firewall/options` | `isClusterFirewallEnabled` | `enable === 1` means guest firewalls are enforced |
| PUT | `/cluster/firewall/options` | `setClusterFirewall` | `enable=1` / `enable=0` |
| GET | `/cluster/firewall/rules` | `setClusterFirewall` | Detect existing `ProxMate: management access` rules |
| POST | `/cluster/firewall/rules` | `setClusterFirewall` | Add ACCEPT tcp 8006 and 22 from each management CIDR |
| GET | `/cluster/sdn/vnets` | `getGuestNetworks` | SDN VNets for the network picker (failure tolerated) |
| GET | `/cluster/sdn/zones` | `getGuestNetworks` | Zone node restrictions for VNets (failure tolerated) |
| GET | `/storage` | `getStorages`, `ensureSnippetsEnabled`, `getStoragePath`; `getCloudInitExtras`, `cloudInitStatus` (template.service) | Storage definitions with `content`, `type`, `path` |
| PUT | `/storage/{storage}` | `ensureSnippetsEnabled` | Append `snippets` to a storage's content types |
| GET | `/nodes/{node}/storage` | `getImportStorages` | Storages on a node whose content includes `import` |
| GET | `/nodes/{node}/storage?enabled=1&content=images` | `getNodeImagesStorages` (used by `storageAvailableOn`) | Image-capable storages on a node with `avail` |
| GET | `/nodes/{node}/storage/{storage}/content?content=iso` | `getIsos`, `getIsoNodes` | ISO volumes per node |
| GET | `/nodes/{node}/storage/{storage}/content?content=vztmpl` | `listLxcTemplates`, `getTemplateNodes` | LXC OS templates per node |
| GET | `/nodes/{node}/storage/{storage}/content?content=snippets` | `nodesWithSnippet`; `getCloudInitExtras`, `cloudInitStatus` (template.service) | Which nodes hold a cloud-init snippet file |
| GET | `/nodes/{node}/storage/{storage}/content?content=backup` | `listBackups`, `getBackupNodes` | vzdump archives per node |
| POST | `/nodes/{node}/storage/{storage}/download-url` | `downloadUrlToStorage` | Server-side download of a cloud image (`content=import`), optional checksum; returns UPID |
| DELETE | `/nodes/{node}/storage/{storage}/content/{volid}` | `deleteStorageVolume`, `deleteBackup` | Delete a volume (volid URL-encoded) |
| GET | `/nodes/{node}/network?type=any_bridge` | `getGuestNetworks` | Linux/OVS bridges per online node (the code comment says PVE 8+ also lists applied VNets here); nodes queried in parallel, per-node failure tolerated |
| GET | `/nodes/{node}/network` | `getGuestNetworks` | Unfiltered fallback when the `any_bridge` request fails; filtered to `bridge`/`OVSBridge`/`vnet` types in code |
| GET | `/nodes/{node}/network/{bridge}` | `getBridgeGateway`, `getBridgeNetwork` | Bridge `gateway` and `cidr` |
| POST | `/nodes/{node}/qemu` | `createVm`, `createCloudInitVm`, `restoreBackup` (qemu), `restoreNewGuest` (qemu) | Create VM (with `tags` carrying the ownership tag), or restore with `archive=` |
| POST | `/nodes/{node}/lxc` | `createLxc`, `restoreBackup` (lxc), `restoreNewGuest` (lxc) | Create container (with `tags`), or restore with `ostemplate=` + `restore=1` |
| GET | `/nodes/{node}/{kind}/{vmid}/config` | `getVmConfig`; `migratePreflight` (qemu) | Guest config as string map |
| PUT | `/nodes/{node}/{kind}/{vmid}/config` | `setVmResources`, `setVmName`, `ensureNicFirewall`, `setVmVlanTag`, `setVmBridge`, `ensureHostCpu`; `markClonedGuest` / `markTemplateGuest` / the ownership-tag backfill (vm.service) | cores/memory, name or hostname, `netN` rewrites, `cpu=host`, `tags` (ProxMate's `proxmate-<id>` ownership tag, other tags kept) |
| PUT | `/nodes/{node}/qemu/{vmid}/config` | `setCloudInitConfig`, `attachDisk`, `removeDisk`, `deleteVmConfigKeys`, `addCloudInitDrive`, `attachPci`, `detachPci`, `applyRescueConfig`, `restoreBootConfig`; `configureClonedVm` (vm.service, `vga=std`); `bakeGuestAgent` (template.service) | QEMU-only config edits |
| PUT | `/nodes/{node}/{kind}/{vmid}/resize` | `resizeDisk` | Grow a disk to an absolute `size=<N>G` |
| POST | `/nodes/{node}/qemu/{vmid}/template` | `convertToTemplate` | Convert a stopped VM to a template |
| POST | `/nodes/{node}/qemu/{vmid}/clone` | `cloneVm` | Linked or full clone; returns UPID |
| GET | `/nodes/{node}/qemu/{vmid}/migrate` | `migratePreflight` (via `migratableTargets`) | `allowed_nodes`, `not_allowed_nodes`, `local_disks` |
| POST | `/nodes/{node}/qemu/{vmid}/migrate` | `migrateVm` | Migrate (`online`, `with-local-disks`, `targetstorage`); returns UPID |
| GET | `/nodes/{node}/{kind}/{vmid}/status/current` | `getVmStatus`; `migratePreflight` (qemu) | running/stopped, qmpstatus, cpu, mem, uptime |
| POST | `/nodes/{node}/{kind}/{vmid}/status/start` | `startVm` | Power on; returns UPID |
| POST | `/nodes/{node}/{kind}/{vmid}/status/shutdown` | `shutdownVm` | ACPI/graceful shutdown |
| POST | `/nodes/{node}/{kind}/{vmid}/status/stop` | `stopVm` | Hard power-off |
| POST | `/nodes/{node}/{kind}/{vmid}/status/reboot` | `rebootVm` | Reboot |
| POST | `/nodes/{node}/qemu/{vmid}/status/suspend` | `suspendVm` | Pause (QEMU only) |
| POST | `/nodes/{node}/qemu/{vmid}/status/resume` | `resumeVm` | Resume a paused VM |
| DELETE | `/nodes/{node}/{kind}/{vmid}` | `deleteVm` | Destroy guest; returns UPID |
| GET | `/nodes/{node}/{kind}/{vmid}/rrddata?timeframe=…&cf=AVERAGE` | `getVmRrdData` | Historical cpu/mem/net/disk series (hour…year) |
| GET | `/nodes/{node}/lxc/{vmid}/interfaces` | `getLxcIps` | Container IPs without a guest agent |
| GET | `/nodes/{node}/qemu/{vmid}/snapshot` | `listSnapshots` | Snapshots (synthetic `current` dropped) |
| POST | `/nodes/{node}/qemu/{vmid}/snapshot` | `createSnapshot` | `snapname`, optional `description`, `vmstate=1` |
| DELETE | `/nodes/{node}/qemu/{vmid}/snapshot/{snapname}` | `deleteSnapshot` | Delete snapshot |
| GET | `/nodes/{node}/qemu/{vmid}/snapshot/{snapname}/config` | `getSnapshotConfig` | Config a rollback would bring back (quota pre-check) |
| POST | `/nodes/{node}/qemu/{vmid}/snapshot/{snapname}/rollback` | `rollbackSnapshot` | Roll back |
| POST | `/nodes/{node}/vzdump` | `startBackup` | vzdump with `compress=zstd`, `remove=0`; returns UPID |
| GET | `/nodes/{node}/storage?enabled=1`, `/nodes/{node}/storage/{storage}/content?vmid={vmid}` | `listGuestVolumes` | Volumes already present for a VMID before an upload restore |
| GET | `/nodes/{node}/vzdump/extractconfig?volume={volid}` | `extractBackupConfig` | Guest config embedded in an archive (quota pre-check) |
| GET | `/nodes/{node}/tasks/{upid}/status` | `waitForTask` | Task completion polling |
| GET | `/nodes/{node}/tasks/{upid}/log?limit=0` | `getMigrationProgress`, `getTaskLog` | Full task log: migration progress; the archive a vzdump task wrote |
| DELETE | `/nodes/{node}/tasks/{upid}` | `stopTask` | Stop a vzdump task a MateState run gave up waiting for |
| GET | `/nodes/{node}/hardware/pci` | `getNodePciDevices` | Live PCI devices + IOMMU groups (passthrough preflight) |
| PUT | `/nodes/{node}/{kind}/{vmid}/firewall/options` | `configureVmIsolation` | Guest firewall on, policies, macfilter |
| GET | `/nodes/{node}/{kind}/{vmid}/firewall/rules` | `configureVmIsolation`, `ensureIdePinhole`, `removeIdePinhole` | Read rules to reconcile by comment |
| POST | `/nodes/{node}/{kind}/{vmid}/firewall/rules` | `configureVmIsolation`, `ensureIdePinhole` | Insert isolation rules / IDE pinhole |
| DELETE | `/nodes/{node}/{kind}/{vmid}/firewall/rules/{pos}` | `configureVmIsolation`, `removeIdePinhole` | Remove ProxMate-owned rules (highest pos first) |
| POST | `/nodes/{node}/qemu/{vmid}/agent/ping` | `guestAgentPing` | Is the QEMU guest agent alive (no retry) |
| POST | `/nodes/{node}/qemu/{vmid}/agent/set-user-password` | `setGuestUserPassword` | Set an in-guest password (writes /etc/shadow) |
| POST | `/nodes/{node}/qemu/{vmid}/agent/exec` | `injectGuestSshKey`, `guestExec`, `guestExecOutput` | Run a command; `command` is a repeated array param |
| GET | `/nodes/{node}/qemu/{vmid}/agent/exec-status?pid={pid}` | `injectGuestSshKey`, `guestExecOutput` | Poll exec result |
| POST | `/nodes/{node}/qemu/{vmid}/agent/file-write` | `guestFileWrite` | Write a file (`encode=1`, pass raw content) |
| GET | `/nodes/{node}/qemu/{vmid}/agent/network-get-interfaces` | `getVmIps` | Guest IPs (LAN + Tailscale) |
| GET | `/nodes/{node}/qemu/{vmid}/agent/get-fsinfo` | `getDiskPct` (alert.service) | Fullest filesystem % for disk alerts |
| POST | `/nodes/{node}/{kind}/{vmid}/vncproxy` | `requestVncProxy` (vnc-proxy.service) | One-time VNC ticket + port, `websocket=1` |
| POST | `/nodes/{node}/{kind}/{vmid}/termproxy` | `requestTermProxy` (vnc-proxy.service) | One-time serial ticket + port + user |
| WSS | `/nodes/{node}/{kind}/{vmid}/vncwebsocket?port=…&vncticket=…` | `connectConsoleTarget` (vnc-proxy.service) | Console byte stream, relayed to the browser |

The application code under `backend/src` never calls `/pools`, `/access/users`, `/access/acl` or any
token-management endpoint; `/access/permissions` is its only `/access` call.[^pve][^vnc] The exception
is the committed one-off proof-of-concept script `backend/_verify_pools.ts` (not part of the server),
which creates and deletes `/pools`, `/access/acl` grants and `/access/users/{user}/token/{id}` tokens
to test pool-scoped token isolation.[^verifypools]

# Gotchas

- The `/nodes/{node}/network?type=any_bridge`, `/cluster/sdn/*` rows reflect
  `getGuestNetworks`, which replaces the older `getBridges()` (`GET /nodes/{default}/network?type=bridge`
  on the first node only). Network discovery is covered in [networking](/proxmox/networking.md).[^pve]
- The console WebSocket is opened with `rejectUnauthorized: verifySsl` but **without** the custom
  `ca` from `getProxmoxCa()`, and it forces `wss://` even if `proxmox_host` is `http://`.[^vnc]
  With verification on against a private CA, REST calls can succeed while the console fails TLS.
- Per-node content scans (`getIsos`, `getIsoNodes`, `listBackups`, `getBackupNodes`,
  `listLxcTemplates`, `nodesWithSnippet`) query nodes sequentially and swallow per-node errors, so
  an unreachable node is simply omitted.[^pve]
- `getClient()` rebuilds the client (and re-reads four config rows) on every call; callers that
  make many requests should pass one `client` through.[^pve]
- Node arch/AVX/CPU-model maps are cached 5 min only when no explicit client is passed.[^pve]

[^pve]: backend/src/services/proxmox.service.ts
[^vnc]: backend/src/services/vnc-proxy.service.ts
[^setup]: backend/src/services/setup.service.ts
[^vm]: backend/src/services/vm.service.ts
[^template]: backend/src/services/template.service.ts
[^balancer]: backend/src/services/cluster-balancer.service.ts
[^alert]: backend/src/services/alert.service.ts
[^metrics]: backend/src/lib/metrics.ts
[^matestate]: backend/src/services/matestate.service.ts
[^restoreupload]: backend/src/services/restore-upload.service.ts
[^verifypools]: backend/_verify_pools.ts
[^security]: SECURITY.md
