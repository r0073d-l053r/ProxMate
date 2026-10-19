---
type: Backend Service
title: Deploy-lock service (cloud-init deploy lock)
description: Tracks a freshly deployed guest as `deploying` until the guest agent reports cloud-init finished (or 8 minutes pass), then sets the pending login password in-guest and unlocks.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/deploy-lock.service.ts
tags: [proxmate, cloud-init, deploy, guest-agent, security]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: lock
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/deploy-lock.service.ts
    title: backend/src/services/deploy-lock.service.ts
---

# Purpose

A VM cloned from a cloud-init template is "running" the instant it boots, but cloud-init keeps working for minutes (disk grow, guest agent, docker/tailscale extras, base config). Stopping, restarting or deleting it in that window leaves a half-built box. `deployFromTemplate`/`rebuildVm` set `deployState='deploying'`; the VM routes turn that into a 409 on destructive actions.[^lock]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `deployStateOf` | `(vm) => 'none' \| 'deploying' \| 'ready'` | Normalises the column. |
| `isDeploying` | `(vm) => boolean` | Gate for destructive VM actions. |
| `refreshDeployState` | `(vm: VirtualMachine) => Promise<DeployState>` | Called from the VM-detail fetch. If past `DEPLOY_TIMEOUT_MS` (8 min) → final password attempt, abandon, mark ready. Else probes cloud-init; when settled → apply password, mark ready. |
| `applyPendingCiPassword` (internal) | `(vm)` | Decrypts `pendingCiPassword` and sets it via the guest agent `set-user-password` for the `ciuser`; clears it on success. |
| `abandonPendingCiPassword` (internal) | `(id)` | Drops the secret, logs at ERROR, and sends `notify({ event: 'deploy.agent_missing' })` naming the source template. |
| `cloudInitSettled` (internal) | `(vm) => boolean \| null` | Guest-agent ping, then `cloud-init status` via guest exec (8 s). Terminal state or no cloud-init → true; `running`/`not` → false; agent unreachable → null. |

# Data

[VirtualMachine](/database/virtual-machine.md): `deployState`, `deployStateAt`, `pendingCiPassword` (encrypted with `lib/crypto`), `type`, `name`, `description`, `os`. Reads Proxmox `ciuser` from the VM config.[^lock]

# Gotchas

- Passwords are never handed to cloud-init as `cipassword`: its crypt hash would remain readable by the tenant on the seed drive (`/dev/sr0`, 2026-07-18 pentest finding) and in `/var/lib/cloud/instances/<id>/user-data.txt` (confirmed 2026-08-11; ejecting the seed does not remove the cache). The guest agent writes only `/etc/shadow`.[^lock]
- Ordering: the password is applied only after cloud-init settles, because `cc_users_groups` must have created the account first.[^lock]
- Best-effort: a password failure never holds the lock. The encrypted value is kept for a retry on the next poll and dropped at timeout; recovery is the reset-password flow (same agent call).[^lock]
- LXC guests are skipped (`vm.type !== 'qemu'`). If no `ciuser` is found, the pending secret is discarded.[^lock]
- The `deploy.agent_missing` notification is about the template, not the VM: a template without `qemu-guest-agent` breaks every password-only deploy from it.[^lock]
- The lock advances only when something fetches the VM detail; there is no background job.[^lock]

# Relationships

- Called by the [vm router](/api/vm.md); mirrors the IDE install lock in [ide-provision](/services/ide-provision.md).
- Uses [proxmox service](/services/proxmox.md) (`guestAgentPing`, `guestExecOutput`, `getVmConfig`, `setGuestUserPassword`) and [notify](/services/notify.md).
- Template side: [template service](/services/template.md), [cloud-init config](/config/cloud-init.md), [guest lifecycle](/proxmox/guest-lifecycle.md).

[^lock]: backend/src/services/deploy-lock.service.ts
