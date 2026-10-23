---
type: Backend Service
title: Bulk-deploy service (several copies of one template)
description: Deploys N copies of a template for one owner from a `{n}` name pattern, or one copy per chosen user (admin), reserving the whole batch against quota up front and cloning a few at a time with per-copy results.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/bulk-deploy.service.ts
tags: [proxmate, template, deploy, quota, bulk]
generated: { by: okf-bootstrap/0.1, at: 2026-10-23T12:00:00Z }
sources:
  - id: bulk
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/bulk-deploy.service.ts
    title: backend/src/services/bulk-deploy.service.ts
  - id: vm
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/vm.service.ts
    title: backend/src/services/vm.service.ts
---

# Purpose

One request deploys several machines from one Template Store entry: `count` copies named from `namePattern` (`web-{n}` → `web-1`, `web-2`, …) for the caller (or an admin's `forUserId`), or — admin only — one copy into each user in `forUserIds`. The batch is all or nothing on quota: `reserveTemplateBatch` (vm service) takes every owner's quota lock in id order, checks each owner's share of the batch, places every copy, reserves a VMID for each and writes all rows in one transaction. Nothing is written or cloned when any owner is over quota (`BatchQuotaError`, keyed by owner email). The copies are then cloned in the background, `BULK_DEPLOY_CONCURRENCY` (3) at a time, each through the single-deploy path (`provisionReservedDeploy` → clone, tag, autoscale, cloud-init, default bridge, isolation, start, cloud-init deploy lock).[^bulk][^vm]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `planBatch` | `(actor, { namePattern, count?, forUserId?, forUserIds?, quotaExempt? }) => Promise<{ owner, name }[]>` | Enforces the caps (`BULK_DEPLOY_MAX` 20 for tenants, `BULK_DEPLOY_MAX_ADMIN` 50 for admins), the admin-only options (`CreateOptionError` 403 for a tenant), `{n}` in the pattern for more than one copy, and valid unique names. |
| `startTemplateBatch` | `(actor, template, copies, input) => Promise<DeployBatch>` | Reserves the batch, records `template.deploy_bulk`, starts the clone pool and returns the batch. Records `template.deploy_bulk_done` with `ok/total` when every copy is settled. |
| `getBatch` | `(id, user) => DeployBatch \| null` | The batch for its starter or an admin; null otherwise. |
| `waitForBatch` | `(id) => Promise<void>` | Resolves when every copy is settled. |
| `expandNamePattern` | `(pattern, n) => string` | Replaces every `{n}` with the copy number. |

# Data

Creates [VirtualMachine](/database/virtual-machine.md) rows in `creating`, one per copy, with `adminManaged` set when the owner is not the actor and `quotaExempt` only for another user's account. Batch progress (`queued` → `deploying` → `done`/`failed` with the Proxmox error) is kept in memory and dropped an hour after the batch finishes.[^bulk]

# Gotchas

- VMIDs are reserved before their guests exist, so they are held in an in-process set that every create path (`nextVmId`) skips, and `reserveVmIds` also skips VMIDs any row or Template Store entry references. A copy whose VMID was taken outside ProxMate while it waited is moved to a fresh VMID before its clone — unless the guest there carries the copy's own tag, in which case the copy stops and its row is held for an admin. A queued copy is `creating`, so nothing but deleting it is allowed meanwhile; one deleted before its turn is skipped. Each reserved VMID is held the moment Proxmox confirms it free, so reservations running side by side never share one.[^vm]
- Placement counts the copies already placed in the batch (`pickBestNode`'s `pending` load), so a batch spreads across nodes instead of all landing on the node that was emptiest at the start. Linked clones stay on the template's node, as for a single deploy.[^vm]
- A failed copy is settled like a failed single deploy (`settleFailedCreate`): its row is dropped when no guest of ours was left, otherwise kept in `error`. The other copies carry on.[^vm]
- Batches are in memory: a restart loses the progress view, not the machines.[^bulk]

# Relationships

- Called by the [template router](/api/template.md) (`POST /api/templates/deploy-bulk`, `GET /api/templates/deploy-bulk/:id`).
- Uses the [vm service](/services/vm.md) (`reserveTemplateBatch`, `provisionReservedDeploy`), the [deploy lock](/services/deploy-lock.md) for cloud-init copies, and [audit](/services/audit.md).

[^bulk]: backend/src/services/bulk-deploy.service.ts
[^vm]: backend/src/services/vm.service.ts
