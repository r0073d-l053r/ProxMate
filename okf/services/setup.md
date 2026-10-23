---
type: Backend Service
title: Setup service
description: First-run wizard logic, covering the admin account, Proxmox connection and privilege test, resource discovery, defaults and completion.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/setup.service.ts
tags: [proxmate, service, setup, proxmox]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T20:00:00Z }
sources:
  - id: setup
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/setup.service.ts
    title: backend/src/services/setup.service.ts
  - id: tests
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/test/connection-test.test.ts
    title: backend/test/connection-test.test.ts
---

# Purpose

The backend half of the setup wizard (`frontend/src/app/(setup)/setup/`). It also serves
the admin settings page, which reuses the connection test, the resource discovery and
`saveDefaults`.[^setup]

# Key functions

| Function | Signature summary | What it does |
|----------|-------------------|--------------|
| `createAdmin` | `({ email, password, displayName })` | Creates the only first-run admin: email lowercased, bcrypt cost 12, `role: 'admin'`, `emailBound: true`. Throws if an admin exists. Generates `jwt_secret` (64 random bytes, hex, stored encrypted) if absent, then opens a session. |
| `hasAdmin` | `()` | Whether any `role: 'admin'` user exists. |
| `saveProxmoxConfig` | `({ host, tokenId, tokenSecret, verifySsl, pool? })` | Writes the [Proxmox connection](/config/proxmox-connection.md) keys; `proxmox_token_secret` is stored encrypted; `pool` goes through `saveGuestPool`. |
| `saveGuestPool` | `(pool: string)` | Sets `proxmox_pool` (trimmed; `''` clears it); throws on a name `POOL_ID_RE` rejects. |
| `testProxmoxConnection` | `()` → `{ connected, version, nodeCount, vmCount, storageCount, warnings, pool? }` | Checks that the token can actually *do* things, not just authenticate (see below). With `proxmox_pool` set it adds the [guest-pool](/services/guest-pool.md) checks and their `pool` report. |
| `getProxmoxResources` | `()` → `{ storages, bridges, nodeCount, isoStorages, backupStorages }` | Storages filtered by content (`images` / `iso` / `backup`), plus guest networks from `getGuestNetworks` (see [networking](/proxmox/networking.md)). |
| `saveDefaults` | `({ storage, bridge, isoStorage, backupStorage? })` | Writes the [provisioning defaults](/config/provisioning-defaults.md). `backup_storage` is written only when provided. |
| `completeSetup` | `()` | Requires the admin, ensures `jwt_secret`, sets `setup_complete=true`; opens no session (the route is reached only by the admin's own session). |

# Connection test

1. `GET /version` on its own: an authentication failure is the finding.
2. `/nodes` and `/access/permissions`. If the token holds **no** privileges, throw an
   error naming privilege separation (`--privsep 1`) and the `pveum acl modify` fix.
3. **Blocking:** `VM.Audit` missing, or held but `/cluster/resources` unreadable;
   `Datastore.Audit` missing, or held but no storage returned.
4. **Warnings:** each missing operational privilege (`VM.Allocate`, `VM.Config.*`,
   `VM.PowerMgmt`, `VM.Console`, `VM.Clone`, `VM.Snapshot`,
   `Datastore.AllocateSpace`, `Sys.Audit`). `SDN.Use` is checked on Proxmox VE 8+ only,
   and `SDN.Audit` always. A VM count of zero is a warning, not a failure.[^setup]

Privileges are collected across all ACL paths (`heldPrivileges`), so a correctly scoped
pool grant passes.[^tests] Full matrix: [privileges](/proxmox/privileges.md).

# Data

Writes [SystemConfig](/database/system-config.md) keys and creates the first
[User](/database/user.md) and [Session](/database/session.md).

# Relationships

- Called by: [setup router](/api/setup.md), [admin router](/api/admin.md), [proxmox router](/api/proxmox.md).
- Uses: [Proxmox service](/services/proxmox.md), [config service](/services/config.md), [auth service](/services/auth.md).

[^setup]: backend/src/services/setup.service.ts
[^tests]: backend/test/connection-test.test.ts
