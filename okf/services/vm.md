---
type: Backend Service
title: VM service (guest lifecycle orchestration)
description: Central orchestration for tenant guests - quota checks, create (ISO, LXC, template deploy, duplicate, rebuild), access/capability resolution, power actions with owner access-window guard, migration, resize, rescue mode, guest-agent helpers and the storage-pinning report.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/vm.service.ts
tags: [proxmate, vm, lifecycle, quota, authorization]
generated: { by: claude-code/okf-bootstrap, at: 2026-10-19T12:00:00Z }
sources:
  - id: vm
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/vm.service.ts
    title: backend/src/services/vm.service.ts
---

# Purpose

The layer between the routers and [proxmox service](/services/proxmox.md) for everything a tenant does to a guest. Every create path follows: quota check → reserve VMID → DB row `creating` → create/clone on Proxmox (waiting for the task) → isolation firewall before first boot → `stopped` → start (waited) → `running`; any failure marks the row `error` and fires `notify({ event: 'vm.error' })`.[^vm]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `kindOf` | `(vm) => 'qemu' \| 'lxc'` | Defaults to qemu for legacy rows. |
| `assertWithinQuota` | `(user, input)` | Sums non-exempt VMs; throws `QuotaError(details)` per cpu/ram/storage violation. Admins and `quotaExempt` skip. |
| `resolveCreateTarget` | `(reqUser, { forUserId?, quotaExempt?, node? }) => User` | Those three options are admin-only (`CreateOptionError` 403); returns the owning user (quota charged to them). |
| `createVm` | `(user, input)` | ISO install; only nodes holding the ISO on `iso_storage`; auto-placement amd64 via `pickBestNode`. |
| `createContainer` | `(user, input)` | LXC; only nodes holding the OS template; arch guessed from template filename. |
| `deployFromTemplate` | `(user, template, input)` | Clone (see `planTemplateClone`), `configureClonedVm`, start; cloud-init templates set `deployState='deploying'` and store `pendingCiPassword` encrypted. |
| `duplicateVm` | `(source, newName)` | QEMU only, source must be stopped; full clone on same node onto `default_storage` if available; quota charged to owner. |
| `getOwnedVm` | `(vmId, user)` | Owner or admin only (delete, shares, convert, migrate, passthrough, rebuild). |
| `resolveVmAccess` / `getVmWithCap` / `getViewableVm` | `(vmId, user[, cap])` | THE per-VM gate: owner/admin → all caps; share → preset caps; returns null when not permitted (no existence oracle). |
| `listVms` / `annotateAccess` | `(user)` / `(vms, user)` | Owned + shared (all for admins); adds `access` and `caps`. |
| `migrateVmToNode` | `(vm, target, { notifyOwner?, actorId?, offline?, targetstorage?, timeoutMs? })` | Refuses LXC, passthrough VMs, unknown nodes and arch mismatch; live if running; optional owner email; waits (default 30 min); updates `proxmoxNode`. |
| `updateVm` / `normalizeTags` | | Notes/name/tags; tags lowercased, deduped CSV. |
| `quotaAccountFor` / `assertResizeWithinQuota` / `resizeVm` | | Resize billed to the VM OWNER; disk grow-only (`ResizeError`); Proxmox first, then DB per step. |
| `setPowerSchedule` | `(vm, { startCron, stopCron })` | Stored for [power-schedule](/services/power-schedule.md). |
| `syncVmNode` | `(vm)` | Corrects `proxmoxNode` from `/cluster/resources`. |
| `getVmWithLiveStatus` / `refreshVmIps` / `getLiveUsage` | | Live status merge (syncs DB status unless `creating`), agent/LXC IP refresh, per-user live usage. |
| `destroyVm` | `(vm)` | Hard-stop, wait, delete on Proxmox (already-gone tolerated), delete row. |
| `rebuildVm` | `(user, vm, source: iso \| template)` | Destructive re-image into the SAME VMID; clears `ideState`; re-arms deploy lock/pending password for cloud-init. |
| `startVm` / `stopVm(vm, force)` / `restartVm` / `pauseVm` / `resumeVm` | | Power actions; `stopVm` graceful unless `force`; pause/resume QEMU only. |
| `generateGuestPassword` / `resetGuestPassword` | | 20-char unambiguous CSPRNG password set via agent; returned once, never stored. |
| `addGuestSshKey` | `(vm, username, key)` | Validates key, injects via agent, best-effort merges into cloud-init `sshkeys` preserving `ipconfig0`. |
| `enterRescue` / `exitRescue` | `(vm)` | Snapshot `{ boot, ide3 }` to `rescueBoot`, boot `rescue_iso`; restore on exit. |
| `getStoragePinningReport` | `()` | Read-only report of guests Proxmox's migrate preflight says are pinned to node-local storage (batches of 8). |

# Data

- [VirtualMachine](/database/virtual-machine.md): `userId, proxmoxVmId, proxmoxNode, type, name, description, cpu, ram, storage, os, status, quotaExempt, adminManaged, tags, ipAddress, tailscaleIp, deployState, deployStateAt, pendingCiPassword, ideState, ideStateAt, hasPassthrough, rescueBoot, startCron, stopCron`.[^vm]
- [User](/database/user.md) quotas `maxCpu/maxRam/maxStorage`, `role`, `accessExpiresAt`; [VmShare](/database/vm-share.md); [Template](/database/template.md).
- SystemConfig `default_storage`, `default_bridge`, `iso_storage`, `rescue_iso` ([provisioning defaults](/config/provisioning-defaults.md)), `isolation_enabled` ([tenant isolation](/config/tenant-isolation.md)), cloud-init offered/base ([cloud-init](/config/cloud-init.md)).

# Gotchas

- Placement is constrained to nodes that physically hold the ISO / LXC template (node-local storage is the #1 cause of async Proxmox failures). ISO installs and uploads are kept on amd64 nodes.[^vm]
- `planTemplateClone`: cloud-image templates always full-clone (onto `default_storage` if the node sees it); regular templates stay linked if already on the default pool, otherwise full-clone so the guest is not pinned to node-local storage (the 2026-08-01 migratability fix). If the default pool is not visible on the template node, the template's own storage is used with a warning.[^vm]
- Template deploys run on the template's node.[^vm]
- `cipassword` is never given to cloud-init (hash readable on `/dev/sr0` and `/var/lib/cloud`, pentest 2026-07-18, verified 2026-08-11). The password is stored encrypted and applied by [deploy-lock](/services/deploy-lock.md). When a password is requested, `guest-agent` is added to the snippet as a "belt"; if no snippet can be produced for it the deploy continues with a warning.[^vm]
- Only cloud-init feature ids the admin OFFERS are accepted; the always-on base applies only when on-demand snippet writing (`snippetWriteConfig`) is configured. A missing snippet for a chosen feature is a hard error.[^vm]
- Cloud-image VMs get `vga: std` so noVNC is not stuck on the serial placeholder.[^vm]
- `applyDefaultBridge` runs on every clone path before isolation. Deploy and template rebuild (`configureClonedVm`) then call `ensureNicFirewall` + `configureVmIsolation`, because cloned NICs may lack the firewall flag; `duplicateVm` re-runs only `configureVmIsolation` (fresh MAC).[^vm]
- Power-on paths (`startVm`, `restartVm`, `resumeVm`, rescue boot, `duplicateVm`) check the OWNER's access window, not the caller's, so a share-holder cannot undo a suspension. In `enterRescue`/`exitRescue` the check runs only after the guest has been stopped, its boot config rewritten and the row updated (`status: 'running'`), so a refused rescue boot leaves the guest stopped in the new boot config.[^vm]
- `stopVm` writes `status: 'stopped'` regardless of whether the guest actually went down (relied on by [access-sweep](/services/access-sweep.md), which re-checks Proxmox).[^vm]
- Resize/rebuild quota is billed to the owner (a Manager resizing a shared VM is checked against the owner's caps; orphaned VM falls back to the caller). `quotaExempt` VMs stay exempt.[^vm]
- `refreshVmIps`: the LAN IP is sticky (never cleared on agent hiccup); the Tailscale IP is cleared when no longer advertised.[^vm]
- LXC: no live migration, pause, rescue, password reset, SSH-key add, or duplicate.[^vm]

# Relationships

- Called by the [vm router](/api/vm.md), [admin router](/api/admin.md), [user router](/api/user.md), [template router](/api/template.md), [ide router](/api/ide.md), [passthrough-request router](/api/passthrough-request.md), [console router](/api/console.md).
- Used by [cluster-balancer](/services/cluster-balancer.md), [access-sweep](/services/access-sweep.md), [disk](/services/disk.md), [ide-proxy](/services/ide-proxy.md), [ide-gateway](/services/ide-gateway.md), [ide-provision](/services/ide-provision.md), [restore-upload](/services/restore-upload.md), [power-schedule](/services/power-schedule.md), [passthrough-request](/services/passthrough-request.md).
- Depends on [proxmox service](/services/proxmox.md), [vm-share](/services/vm-share.md), [template](/services/template.md), [ssh-key](/services/ssh-key.md), [access](/services/access.md), [config](/services/config.md), [notify](/services/notify.md), [mail](/services/mail.md).
- Proxmox side: [guest lifecycle](/proxmox/guest-lifecycle.md), [networking](/proxmox/networking.md), [storage](/proxmox/storage.md).

[^vm]: backend/src/services/vm.service.ts
