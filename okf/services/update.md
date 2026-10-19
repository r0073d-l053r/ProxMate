---
type: Backend Service
title: Update service (self-update check and host-mediated apply)
description: Compares the running version with the latest GitHub Release and, when enabled, queues an update by writing a request file into a bind-mounted control directory watched by a host-side updater.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/update.service.ts
tags: [proxmate, update, deploy, github]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T20:00:00Z }
sources:
  - id: updsh
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/deploy/update.sh
    title: deploy/update.sh
  - id: upd
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/update.service.ts
    title: backend/src/services/update.service.ts
---

# Purpose

Two halves. CHECK (always available, admin-only): read the deployed version and ask the GitHub Releases API for the latest. APPLY (opt-in): a container cannot rebuild itself, so the app only writes a request flag that a privileged host updater (`deploy/update.sh` via a systemd path unit) turns into `git checkout <tag> && docker compose build && up -d`, writing a status file back. No Docker socket, no host shell.[^upd]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `updateRepo` | `() => string` | env `UPDATE_REPO` or `r0073d-l053r/ProxMate`. |
| `currentVersion` | `() => string` | env `APP_VERSION`, else `package.json` version, else `0.0.0`. |
| `isNewer` | `(a, b) => boolean` | Numeric semver compare; prerelease suffix dropped. |
| `checkForUpdate` | `(force = false) => UpdateCheck` | GET `/repos/<repo>/releases/latest` (10 s); 60 s cache; 404 = up to date; optional `GITHUB_TOKEN` bearer. |
| `selfUpdateEnabled` | `() => boolean` | env `SELF_UPDATE_ENABLED === 'true'`. |
| `isValidTag` | `(tag) => boolean` | `^v?[0-9A-Za-z][0-9A-Za-z._-]{0,63}$`. |
| `requestUpdate` | `(tag, requestedBy)` | Writes `update-status.json` (`queued`) then `update-request.json` in the control dir. |
| `getUpdateStatus` | `() => UpdateStatus` | Reads the status file; `idle` when absent or unreadable. |

# Data

No DB. Files in env `UPDATE_CONTROL_DIR` (default `/control`). Env `UPDATE_REPO`, `APP_VERSION`, `GITHUB_TOKEN`, `SELF_UPDATE_ENABLED` — see [docker environment](/env/docker-environment.md) and [backend environment](/env/backend-environment.md).[^upd]

# Gotchas

- The cache exists to stay under GitHub's unauthenticated limit (60/hour/IP).[^upd]
- `writeControlFile` self-heals ownership skew: the root-run host updater may leave files unwritable to the app user, so on EACCES/EPERM it unlinks and rewrites (the app owns the directory).[^upd]
- Tags are restricted to a safe charset because the host script will `git checkout` them (the script validates too).[^upd]
- The host updater refuses to run over local edits to tracked files (it names them and asks for compose customisations to move into the untracked `docker-compose.override.yml`), builds only when the checkout exactly matches the release tag, and reports a run that fails or is killed as an `error` status (the unit's `ExecStopPost` runs `update.sh --mark-failed`). A control dir it has to create is owned by uid 1000, the backend container's user. After updating from 1.0.x, copy the updater units into `/etc/systemd/system/` again and run `systemctl daemon-reload`.[^updsh]

# Relationships

- Called only by the [admin router](/api/admin.md). Host side: `deploy/update.sh`; see [architecture](/services/architecture.md).

[^upd]: backend/src/services/update.service.ts
[^updsh]: deploy/update.sh
