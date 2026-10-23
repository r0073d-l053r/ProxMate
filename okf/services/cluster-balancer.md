---
type: Backend Service
title: Cluster-balancer service (DRS-style balancing and node drain)
description: Pure memory-load balancing and node-drain planners plus orchestrators that gather a live cluster snapshot and live-migrate ProxMate-managed VMs, optionally on a 15-minute auto schedule.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/cluster-balancer.service.ts
tags: [proxmate, cluster, migration, balancer, scheduler]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: bal
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/cluster-balancer.service.ts
    title: backend/src/services/cluster-balancer.service.ts
  - id: scheduler
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/scheduler.service.ts
    title: backend/src/services/scheduler.service.ts
---

# Purpose

Reads each node's memory load and live-migrates running ProxMate-managed guests from the hottest node to the coldest until the memory-load spread is within an admin tolerance. Memory is the binding constraint (cannot be safely overcommitted), so plans are simulated on memory; CPU is shown for context only. Also plans and executes node drains (evacuate before maintenance).[^bal]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `planBalance` | `(input: { nodes, vms, thresholdPct, maxMoves }) => BalancePlan` | Pure greedy planner: repeatedly moves the best candidate from hottest to coldest node, only if it strictly lowers the peak, until spread <= threshold, no improving move, or `maxMoves`. Needs >= 2 online nodes. |
| `getBalancerSettings` | `() => { mode, thresholdPct, maxMoves, exclude }` | Defaults `off`, 15, 5, `[]`; threshold clamped 5..50, maxMoves 1..20. |
| `saveBalancerSettings` | `(s)` | Persists and returns re-read settings. |
| `computeClusterPlan` | `(settings?, client?)` | Gathers `getNodesHealth`, `getNodeArchMap`, `/cluster/resources?type=vm`, all DB VMs, and `migratableTargets` for each running, non-excluded VM; calls `planBalance`. A row whose VMID's guest doesn't carry the row's ProxMate tag (`tagsMarkRow`) is excluded. |
| `runMigrations` | `(moves: { vmId, toNode }[], actor?)` | Sequential; each via `vm.service.migrateVmToNode` (re-validates); audits `balancer.migrate` / `balancer.migrate_failed` with Proxmox's real error. |
| `runAutoBalance` | `() => { applied, reason }` | Scheduler entry; no-op unless mode `auto`; audits `balancer.auto_run`. |
| `planDrain` | `(input: DrainInput) => DrainPlan` | Pure: bin-packs the drained node's guests largest-first onto best-fit nodes (fits first, then most free memory); explicit `targetNode` forces all there. |
| `planNodeDrain` | `(node, targetNode?, client?)` | Live snapshot → `planDrain`, adding blockers for unmanaged VMs (including guests without their row's ProxMate tag), LXC containers, passthrough VMs, and VMs locked by an IDE install or cloud-init deploy. |

# Data

- SystemConfig `balancer_mode` (`off`/`recommend`/`auto`), `balancer_threshold`, `balancer_max_moves`, `balancer_exclude` (CSV of VMIDs) — see [cluster-balancer config](/config/cluster-balancer.md).[^bal]
- [VirtualMachine](/database/virtual-machine.md): `tags`, `type`, `hasPassthrough`, `proxmoxVmId`, `proxmoxNode` (read; migration updates happen in [vm service](/services/vm.md)).
- [AuditLog](/database/audit-log.md) entries above.

# Scheduling

Cron `*/15 * * * *`, overridable with env `BALANCER_CRON`; under `balancerRunning` (a long live-migration pass makes later ticks skip). Cheap no-op unless mode is `auto`.[^scheduler]

# Invariants

- Only ProxMate-managed guests move; foreign guests count as fixed load.[^bal]
- Never x86 ↔ ARM (arch guardrail; `unknown` arch is permissive).[^bal]
- Anti-affinity: VMs sharing an `aa:<group>` tag are never co-located by the balancer.[^bal]
- Pinned: tags `pin` / `no-balance`, the exclude list, LXC (no live migration), VMs with PCI/GPU passthrough, VMs whose Proxmox `allowed_nodes` is empty (node-local storage), and VMs locked by an IDE install or cloud-init deploy (`ideState=installing` / `deployState=deploying`). `runMigrations` re-checks that lock per move at apply time (manual apply, auto mode, drain) and reports a locked VM as a failed move.[^bal]
- Each move strictly lowers the peak load, preventing oscillation; `maxMoves` caps churn per pass.[^bal]

# Gotchas

- With a pool-scoped token (`proxmox_pool` and `deploy/proxmox-token.sh --pool`) the snapshot only contains guests in the pool, so guests outside it are neither counted in a node's load nor moved.
- Proxmox placement is authoritative (`r.node` overrides the DB's `proxmoxNode`) since VMs may move outside ProxMate.[^bal]
- `migratableTargets` preflight fails open: an unreadable result (null) leaves the VM unrestricted; the apply re-validates.[^bal]
- Drain with an explicit target is an admin override: only arch and storage-locality are enforced, not capacity or anti-affinity. Auto drain falls back to ignoring anti-affinity when no safe node exists.[^bal]
- In drains only running guests get the preflight; stopped ones (offline migration) are left unrestricted.[^bal]
- Unmanaged-VM blockers are appended to the reason but do not set `ok = false`; container, passthrough and locked-VM blockers do.[^bal]
- Owners are notified only for admin-initiated moves (an `actor` is present), never for routine auto-balancing.[^bal]

# Relationships

- Called by the [scheduler](/services/scheduler.md) and the [admin router](/api/admin.md).
- Uses [vm service](/services/vm.md) `migrateVmToNode`, [proxmox service](/services/proxmox.md), [config](/services/config.md), [audit](/services/audit.md).
- Proxmox side: [guest lifecycle](/proxmox/guest-lifecycle.md), [storage](/proxmox/storage.md).

[^bal]: backend/src/services/cluster-balancer.service.ts
[^scheduler]: backend/src/services/scheduler.service.ts
