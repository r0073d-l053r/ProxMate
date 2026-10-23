---
type: Backend Service
title: Usage-digest service (weekly per-tenant usage email)
description: Builds and sends the weekly opt-in email listing a user's own machines, their running hours and average CPU/RAM from ResourceSample, and their quota in use.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/usage-digest.service.ts
tags: [proxmate, email, usage, scheduler]
generated: { by: okf-bootstrap/0.1, at: 2026-10-23T12:00:00Z }
sources:
  - id: digest
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/usage-digest.service.ts
    title: backend/src/services/usage-digest.service.ts
  - id: scheduler
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/scheduler.service.ts
    title: backend/src/services/scheduler.service.ts
---

# Purpose

Once a week, every user with `usageDigestOptIn` gets one branded email (`usageDigestEmail`) covering the past 7 days: each of their machines with running hours, average CPU (as % of allocated cores) and average memory in use, a total, and their quota in use.[^digest]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `isUsageDigestEnabled` / `setUsageDigestEnabled` | `() => boolean` / `(enabled)` | The admin switch `usage_digest_enabled` (on unless `'false'`). |
| `digestRows` | `(userId, vms, samples) => DigestVmRow[]` | Pure fold: drops samples of any other user, one row per current machine (0 h when idle), then one "Deleted machine" row per vmId no longer among them. Running hours = samples × `SAMPLE_INTERVAL_MINUTES` (5) / 60. |
| `buildUsageDigest` | `(userId, now?) => { to, mail } \| null` | Reads the user, their VMs and their samples in `[now − 7 d, now)`, all filtered by that user id; quota counts non-exempt VMs, as the quota checks do. |
| `runUsageDigest` | `(now?) => { ran, reason?, sent, failed }` | Skips when disabled or SMTP is off; otherwise one digest per opted-in user whose access has not ended (`hasAccessEnded`), a failure counted and logged without stopping the rest. |

# Gotchas

- A digest only ever describes the recipient: every query is scoped to their user id, and `digestRows` filters samples by owner again. `ResourceSample` has no FK to the VM, so a machine deleted during the week still shows its usage, labelled "Deleted machine" (its old name is not kept).[^digest]
- Scheduled by `usageDigestTick` on `USAGE_DIGEST_CRON` (default `0 8 * * 1`), with no catch-up for a missed run.[^scheduler]
- Running time is approximate: it counts 5-minute samples of running guests, so a guest up for less than one tick may not appear.[^digest]

# Relationships

- Scheduled by [scheduler](/services/scheduler.md); previewed via the [admin router](/api/admin.md); setting in [usage digest](/config/usage-digest.md).
- Reads [User](/database/user.md), [VirtualMachine](/database/virtual-machine.md), [ResourceSample](/database/resource-sample.md); uses [mail](/services/mail.md), [config](/services/config.md), [resource-history](/services/resource-history.md) (`SAMPLE_INTERVAL_MINUTES`).

[^digest]: backend/src/services/usage-digest.service.ts
[^scheduler]: backend/src/services/scheduler.service.ts (`usageDigestTick`)
