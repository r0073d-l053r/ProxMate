---
type: Prisma Model
title: VirtualMachine
description: ProxMate's record of a tenant-owned Proxmox guest (QEMU VM or LXC container) with sizing, status, lifecycle locks, schedules and quota flags.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
tags: [proxmate, database, prisma, vm, proxmox]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: schema
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
    title: backend/prisma/schema.prisma
  - id: vm-svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/vm.service.ts
    title: backend/src/services/vm.service.ts
  - id: deploy-lock
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/deploy-lock.service.ts
    title: backend/src/services/deploy-lock.service.ts
  - id: ide-prov
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/ide-provision.service.ts
    title: backend/src/services/ide-provision.service.ts
  - id: passthrough
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/passthrough-request.service.ts
    title: backend/src/services/passthrough-request.service.ts
  - id: matestate
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/matestate.service.ts
    title: backend/src/services/matestate.service.ts
  - id: vm-routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/vm.routes.ts
    title: backend/src/routes/vm.routes.ts
  - id: template-svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/template.service.ts
    title: backend/src/services/template.service.ts
---

# Purpose

Maps a ProxMate VM id to a Proxmox guest (`proxmoxVmId` on `proxmoxNode`) and owner. Proxmox is the source of truth for live state; this row holds ownership, allocated sizing (for quota), cached status/IPs and ProxMate-only state (locks, schedules, flags).[^schema] See [vm router](/api/vm.md), [VM service](/services/vm.md), [guest lifecycle](/proxmox/guest-lifecycle.md).

# Schema

| Field | Type | Attributes | Description |
|---|---|---|---|
| id | String | `@id @default(cuid())` | ProxMate VM id. |
| userId | String | FK, `@@index` | Owner [User](/database/user.md). |
| proxmoxVmId | Int | `@@index` | Proxmox VMID (not unique in the schema). |
| proxmoxNode | String | | Node the guest currently lives on; rewritten on migration / node resync. |
| name | String | | |
| description | String? | | Template deploys write `"From template: <name>"`.[^vm-svc] |
| type | String | `@default("qemu")` | `"qemu"` or `"lxc"`; selects the PVE API path and feature set. |
| hasPassthrough | Boolean | `@default(false)` | A `hostpciN` device is attached; balancer/drain skip it. |
| cpu | Int | | Allocated vCPUs. |
| ram | Int | | Allocated RAM (MB). |
| storage | Int | | Allocated disk (GB). |
| os | String | | OS label. |
| status | String | `@default("creating")` | `creating`, `running`, `stopped`, `error`. A held (`holdReason`) or `error` row can only be deleted or repaired (restore, rebuild, admin adoption); nothing may start it or open its console/IDE. |
| holdReason | String? | | Set while the guest may not run — provisioning, rebuild or a restore didn't finish, or a restore left it over quota — with how to recover; null otherwise. Live-status syncs, stop and PCI detach never change a held row's status; only `liftQuotaHoldIfFits`, a successful MateState restore / snapshot rollback / rebuild, and admin adoption clear it. |
| ipAddress | String? | | Guest LAN IP. |
| tailscaleIp | String? | | Guest Tailscale address (100.64.0.0/10), kept separate from `ipAddress`. |
| rescueBoot | String? | | JSON snapshot of pre-rescue `{ boot, ide3 }`; non-null while in rescue mode. |
| ideState | String? | | null/`none`, `installing` (guest locked), `ready`, `failed`. |
| ideStateAt | DateTime? | | When `ideState` last changed. |
| deployState | String? | | `deploying` (cloud-init running, guest locked), `ready`, or null for untracked deploys. |
| deployStateAt | DateTime? | | When `deployState` last changed. |
| pendingCiPassword | String? | | AES-256-GCM encrypted tenant login password, held only until the guest agent applies it, then nulled. |
| quotaExempt | Boolean | `@default(false)` | Admin grant excluded from quota usage. |
| adminManaged | Boolean | `@default(false)` | Admin deployed it for the tenant; tenant may operate but not resize. |
| tags | String? | | Lowercase, trimmed, deduped CSV.[^vm-svc] |
| startCron | String? | | 5-field cron (server TZ) for auto-start. |
| stopCron | String? | | 5-field cron for graceful auto-shutdown. |
| backupCron | String? | | Per-VM backup cron; null = cluster-wide weekly default. |
| backupKeep | Int? | | MateStates to keep; null = default retention (`MATESTATE_RETENTION` = 2).[^matestate] Admin-only setting, 1..14. |
| createdAt | DateTime | `@default(now())` | |
| updatedAt | DateTime | `@updatedAt` | |

[^schema] [^vm-routes]

# Relationships

- Belongs to [User](/database/user.md), `onDelete: Cascade`.
- Has many [MateState](/database/mate-state.md), [VmShare](/database/vm-share.md), [PassthroughRequest](/database/passthrough-request.md), [AlertRule](/database/alert-rule.md), all cascade-deleted with the VM.[^schema]
- Referenced without FK by [IdeGatewayToken](/database/ide-gateway-token.md).`vmId`, [IdeGuestSecret](/database/ide-guest-secret.md).`vmId` and [ResourceSample](/database/resource-sample.md).`vmId`; no link to the [Template](/database/template.md) it was cloned from.[^schema]

# Invariants

- Quota usage sums `cpu`, `ram`, `storage` over the owner's rows with `quotaExempt: false`; admins skip the check.[^vm-svc]
- `deployState='deploying'` makes destructive VM routes return 409; it clears when a guest-agent `cloud-init status` probe reports done, or after 8 minutes (`DEPLOY_TIMEOUT_MS`).[^deploy-lock]
- An `ideState` of `installing` older than 10 minutes (`INSTALL_TIMEOUT_MS`) is treated as timed out.[^ide-prov]
- `pendingCiPassword` is set only for cloud-init template deploys (and template rebuilds) with a password, and is cleared once applied in-guest or when the deploy window closes without an agent (that path also notifies admins with `deploy.agent_missing`).[^vm-svc] [^deploy-lock]
- `hasPassthrough` is set true only after a successful passthrough attach, and recomputed on detach.[^passthrough]
- Tenants can't set `backupKeep`; for non-admins the route forces it to null.[^vm-routes]

# Gotchas

- `destroyVm` deletes the Proxmox guest first (treating "does not exist" as success), then the row together with its IdeGuestSecret and IdeGatewayToken rows (one transaction). Converting a VM to a template also deletes its row, the same way.[^vm-svc] [^template-svc]
- The password is never passed as cloud-init `cipassword`, because that would leave its crypt hash readable on the guest disk. That's why `pendingCiPassword` exists.[^schema]

[^schema]: backend/prisma/schema.prisma
[^vm-svc]: backend/src/services/vm.service.ts
[^deploy-lock]: backend/src/services/deploy-lock.service.ts
[^ide-prov]: backend/src/services/ide-provision.service.ts
[^passthrough]: backend/src/services/passthrough-request.service.ts
[^matestate]: backend/src/services/matestate.service.ts
[^vm-routes]: backend/src/routes/vm.routes.ts
[^template-svc]: backend/src/services/template.service.ts
