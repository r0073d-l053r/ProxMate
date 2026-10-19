---
type: Configuration Group
title: Cluster balancer settings
description: SystemConfig keys configuring the DRS-style memory-load balancer, covering its mode, imbalance threshold, per-pass migration cap and excluded VMIDs.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/cluster-balancer.service.ts
tags: [proxmate, config, balancer, migration, scheduler]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: balancer
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/cluster-balancer.service.ts
    title: backend/src/services/cluster-balancer.service.ts
  - id: admin-routes
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/routes/admin.routes.ts
    title: backend/src/routes/admin.routes.ts
  - id: scheduler
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/scheduler.service.ts
    title: backend/src/services/scheduler.service.ts
---

# Purpose

The balancer reads node memory load and recommends or applies live migrations to even it out. `getBalancerSettings()` reads the four keys and **clamps** each value. `saveBalancerSettings()` writes all four and returns the re-read, clamped settings.[^balancer] Admins use `GET /api/admin/balancer` (settings plus a freshly computed plan) and `PUT /api/admin/balancer`. Moves are applied through `POST /api/admin/balancer/apply` ([admin API](/api/admin.md)).

# Schema

| Key | Value format | Default / when unset | Written by | Read by | Description |
|---|---|---|---|---|---|
| `balancer_mode` | `off` \| `recommend` \| `auto` | `off` (any other value reads as `off`) | `saveBalancerSettings` ← `PUT /api/admin/balancer` | `getBalancerSettings`; `runAutoBalance` (scheduler) | `auto` lets the scheduled tick apply migrations. `recommend` only computes plans. |
| `balancer_threshold` | integer percent string | `15` when the row is missing or blank. Stored values are clamped to 5–50 | same | `getBalancerSettings` | Imbalance threshold (`thresholdPct`). |
| `balancer_max_moves` | integer string | `5` when the row is missing or blank. Stored values are clamped to 1–20 | same | `getBalancerSettings` | Maximum migrations per pass (`maxMoves`). |
| `balancer_exclude` | CSV of positive integer VMIDs | `''`, meaning no exclusions; parsing de-duplicates and drops invalid entries | same (`exclude.join(',')`) | `getBalancerSettings` (`parseVmidCsv`) | Proxmox VMIDs the balancer never moves. |

# Validation

`BalancerSettingsSchema`: `mode` enum, `thresholdPct` int 5–50, `maxMoves` int 1–20, `exclude` array of positive ints (max 500, default `[]`).[^admin-routes] `PUT /balancer` records a `balancer.settings` audit entry. If Proxmox is unreachable when the fresh plan is computed, the settings are still saved and the response carries `plan: null` plus an `error`.

# Gotchas

- On a fresh install (no `PUT /balancer` yet) `GET /balancer` reports threshold 5 and max moves 1, not the `DEFAULTS` values. The first save writes all four keys explicitly.[^balancer]
- The scheduled tick runs on `BALANCER_CRON`, default `*/15 * * * *`, but it only acts in `auto` mode. An overlapping tick is skipped while a previous pass is still running.[^scheduler] See [backend environment](/env/backend-environment.md).

[^balancer]: backend/src/services/cluster-balancer.service.ts (`DEFAULTS`, `clampInt`, `parseVmidCsv`, `getBalancerSettings`, `saveBalancerSettings`)
[^admin-routes]: backend/src/routes/admin.routes.ts (`BalancerSettingsSchema`, `GET/PUT /balancer`)
[^scheduler]: backend/src/services/scheduler.service.ts (`DEFAULT_BALANCER_SCHEDULE`)
