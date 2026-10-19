---
type: Backend Service
title: Live-stats service
description: Cached, request-coalesced live CPU/memory/disk/network stats for every guest from `/cluster/resources`, plus a single server-side SSE fan-out loop for admin monitors.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/live-stats.service.ts
tags: [proxmate, monitoring, sse, proxmox]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: live
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/live-stats.service.ts
    title: backend/src/services/live-stats.service.ts
---

# Purpose

Lets a fast UI cadence share one Proxmox `/cluster/resources` call per 750 ms window, and pushes stats to all subscribed admin clients via Server-Sent Events instead of one poll per tab.[^live]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `getLiveStats` | `() => Promise<Record<number, LiveStat>>` | Keyed by `proxmoxVmId` (each entry carries the guest's Proxmox `tags`, so the per-VM route only shows stats for the row's own tagged guest); returns cache if younger than 750 ms, otherwise joins or starts a single in-flight fetch. |
| `addLiveFeedSubscriber` | `(res: Response) => () => void` | Adds an SSE response; starts the interval timer if needed; returns an unsubscribe function. |

`LiveStat` fields: `status, cpu, maxcpu, mem, maxmem, disk, maxdisk, uptime, netin, netout`.[^live]

# Data

No DB access. Reads Proxmox `/cluster/resources` (qemu + lxc entries). Env `LIVE_FEED_INTERVAL_MS` (default 1000, minimum 250).[^live]

# Gotchas

- On a fetch failure each subscriber receives `event: stale` with `data: {}` instead of stats.[^live]
- Dead responses (`writableEnded`, `destroyed`, `writable === false`) are pruned on every tick as well as on close/error, to avoid leaking clients that disconnect without firing `close`.[^live]
- The feed timer stops when the last subscriber leaves.[^live]

# Relationships

- Called by the [vm router](/api/vm.md) and [admin router](/api/admin.md).
- Uses [proxmox service](/services/proxmox.md) `getClient`; see [PVE API surface](/proxmox/pve-api-surface.md).

[^live]: backend/src/services/live-stats.service.ts
